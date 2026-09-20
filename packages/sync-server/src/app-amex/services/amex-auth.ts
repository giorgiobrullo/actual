import createDebug from 'debug';
import type { BrowserContext, ElementHandle, Page } from 'playwright-core';

import type { AmexAccount } from '#app-amex/models/amex';
import { AuthFailedError } from '#app-amex/utils/errors';
import {
  detectRecaptcha,
  injectCaptchaToken,
  isCaptchaServiceConfigured,
  solveRecaptcha,
} from '#services/captcha-service';
import { SecretName, secretsService } from '#services/secrets-service';
import {
  closeStealthContext,
  launchStealthContext,
} from '#services/stealth-browser';

import { getProxy } from './amex-services';
import { isImapConfigured, waitForAmexVerificationCode } from './imap-service';

const debug = createDebug('actual:amex:auth');

// Amex Italy login URL
const AMEX_LOGIN_URL = 'https://www.americanexpress.com/it-it/account/login';
const AMEX_DASHBOARD_URL = 'https://global.americanexpress.com/dashboard';
/**
 * Endpoints that list the member's accounts, tried in order and merged.
 *
 * These answer without knowing an account up front, which is what makes them
 * usable for discovery.
 */
const AMEX_ACCOUNT_SOURCES = [
  'https://global.americanexpress.com/api/servicing/v1/member',
  'https://global.americanexpress.com/api/servicing/v2/prefetch',
];

/**
 * Endpoints that describe one account, and answer 400 without an
 * `account_token` header. They are what turn a bare token into a name, a last
 * four and a balance, so they run once the tokens are known.
 */
const AMEX_ACCOUNT_DETAIL_SOURCES = [
  'https://global.americanexpress.com/api/servicing/v1/financials/credit_limits',
  'https://global.americanexpress.com/api/servicing/v1/financials/balances',
  'https://global.americanexpress.com/api/servicing/v1/financials/transaction_summary',
];

/**
 * Names of any token-ish or account-ish keys in a payload.
 *
 * Discovery keys off `account_token`. When a payload has no accounts this says
 * whether the field was renamed or simply absent, which is the difference
 * between a one-line fix and a wrong guess.
 */
function describeKeys(
  value: unknown,
  seen = new Set<string>(),
  depth = 0,
): string[] {
  if (depth > 8 || value == null || typeof value !== 'object') {
    return [...seen];
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) describeKeys(item, seen, depth + 1);
    return [...seen];
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/token|account|card/i.test(key)) seen.add(key);
    describeKeys(nested, seen, depth + 1);
  }
  return [...seen];
}

// Session cache - stores browser context for reuse
type AmexSession = {
  cookies: Record<string, string>;
  accounts: AmexAccount[];
  createdAt: number;
  expiresAt: number;
};

let cachedSession: AmexSession | null = null;

// Session TTL - 4 minutes (aat token expires in ~5 min, we refresh before that)
const SESSION_TTL_MS = 4 * 60 * 1000;

/**
 * The browser that performed the login, kept open for the life of the session.
 *
 * Amex fronts global.americanexpress.com with Akamai Bot Manager, which ties
 * the session cookies (_abck, bm_sz, ...) to the TLS and HTTP fingerprint of
 * the client that earned them. Replaying those cookies from Node's fetch is
 * answered with 403 however complete the headers are, and only occasionally
 * slips through right after the browser has been busy. So every API call is
 * made by the browser itself: `sessionApiPage` is a tab parked on a static
 * same-origin URL and requests run as fetch() inside it. The page has to be
 * static because the Amex web app patches out eval, which breaks
 * page.evaluate on any page that loads it.
 */
let sessionContext: BrowserContext | null = null;
let sessionApiPage: Page | null = null;
let sessionCloseTimer: ReturnType<typeof setTimeout> | null = null;

const AMEX_API_ORIGIN = 'https://global.americanexpress.com';
const AMEX_API_PAGE_URL = `${AMEX_API_ORIGIN}/robots.txt`;

export type AmexApiResponse = { status: number; text: string };

async function openApiPage(context: BrowserContext): Promise<Page> {
  const apiPage = await context.newPage();
  await apiPage.goto(AMEX_API_PAGE_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  return apiPage;
}

async function pageFetch(
  apiPage: Page,
  url: string,
  headers: Record<string, string> = {},
): Promise<AmexApiResponse> {
  const absolute = url.startsWith('http') ? url : `${AMEX_API_ORIGIN}${url}`;
  return apiPage.evaluate(
    async ({ url, headers }) => {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json', ...headers },
      });
      return { status: response.status, text: await response.text() };
    },
    { url: absolute, headers },
  );
}

async function closeSessionBrowser(): Promise<void> {
  if (sessionCloseTimer) {
    clearTimeout(sessionCloseTimer);
    sessionCloseTimer = null;
  }
  const context = sessionContext;
  sessionContext = null;
  sessionApiPage = null;
  if (context) {
    try {
      await closeStealthContext(context);
    } catch (e) {
      debug(
        'Error closing session browser: %s',
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/**
 * Make an authenticated Amex API request from inside the session's browser,
 * logging in first when there is no live session.
 */
export async function apiRequest(
  url: string,
  headers: Record<string, string> = {},
): Promise<AmexApiResponse> {
  if (!getCachedSession() || !sessionApiPage || sessionApiPage.isClosed()) {
    debug('No live browser session, performing login...');
    await performLogin();
  }
  const apiPage = sessionApiPage;
  if (!apiPage) {
    throw new AuthFailedError('Amex login did not produce a browser session');
  }
  try {
    return await pageFetch(apiPage, url, headers);
  } catch (e) {
    // The tab or browser went away underneath us: drop the session so the
    // next call performs a fresh login instead of failing the same way.
    debug('In-browser request failed: %s', e instanceof Error ? e.message : e);
    clearSession();
    throw new AuthFailedError('Amex browser session is no longer available');
  }
}

// Login timeout - increased for slow proxy connections
const LOGIN_TIMEOUT_MS = 60000;

/**
 * First element matching any of `selectors` that is actually visible.
 *
 * Amex renders several buttons matching the same selector on a page --
 * responsive variants and at least one hidden form -- and `page.$` returns the
 * first in DOM order, which is often not the one on screen. Clicking that fails
 * even with `force`, which skips actionability checks but still cannot scroll
 * an invisible element into view.
 */
async function findVisible(
  page: Page,
  selectors: string[],
): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  for (const selector of selectors) {
    for (const handle of await page.$$(selector)) {
      if (await handle.isVisible()) {
        debug('Matched visible element: %s', selector);
        return handle;
      }
    }
  }
  return null;
}

// How long a humanized click may take before it is treated as wedged.
const CLICK_TIMEOUT_MS = 8000;

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError';
}

/**
 * Click a login-form field, falling back to keyboard focus.
 *
 * About one run in seven the humanized click stalls at "performing click
 * action" on an element Playwright has already found visible, enabled and
 * stable, and sits there until the default 30s timeout fails the whole sync.
 * The click only exists to put the caret in the field, so give it a short
 * budget and focus the field directly when it does not come back.
 */
async function clickOrFocus(page: Page, selector: string): Promise<void> {
  try {
    await page.click(selector, { timeout: CLICK_TIMEOUT_MS });
  } catch (e) {
    if (!isTimeoutError(e)) throw e;
    debug('Click on %s stalled, focusing it instead', selector);
    await page.locator(selector).focus({ timeout: CLICK_TIMEOUT_MS });
  }
}

/**
 * Every object carrying an `account_token`, at any depth.
 *
 * Amex reshapes and re-versions these payloads (the servicing endpoints moved
 * from v1 to a single v2 prefetch call), and matching exact paths means a
 * silent "0 accounts" every time they do. The token is the one field that has
 * stayed put, so the accounts are found by looking for it rather than by
 * knowing the payload's shape.
 */
function collectAccountObjects(
  value: unknown,
  found: Array<Record<string, unknown>> = [],
  depth = 0,
): Array<Record<string, unknown>> {
  if (depth > 8 || value == null || typeof value !== 'object') return found;

  if (Array.isArray(value)) {
    for (const item of value) collectAccountObjects(item, found, depth + 1);
    return found;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.account_token === 'string' && record.account_token) {
    found.push(record);
  }
  for (const nested of Object.values(record)) {
    collectAccountObjects(nested, found, depth + 1);
  }
  return found;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return undefined;
}

function firstText(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Merge whatever account fields a payload happens to carry into `accounts`.
 *
 * Fields arrive spread across several responses, so this fills gaps rather
 * than overwriting: a later payload without a balance must not erase one an
 * earlier payload supplied.
 */
export function mergeDiscoveredAccounts(
  accounts: AmexAccount[],
  payload: unknown,
): AmexAccount[] {
  for (const record of collectAccountObjects(payload)) {
    const token = record.account_token as string;
    // The member listing nests the number under `account` and the card name
    // under `product`; the financial endpoints keep the same fields flat.
    const nestedAccount = asRecord(record.account);
    const nestedProduct = asRecord(record.product);
    const displayNumber =
      firstText(record, ['display_account_number', 'last_five', 'last_four']) ??
      (nestedAccount &&
        firstText(nestedAccount, ['display_account_number', 'last_five'])) ??
      token.slice(-4);
    // Deliberately not `embossed_name`: that is the cardholder, and Amex
    // returns no product name here, so falling through to it would name the
    // account after the person rather than the card.
    const name =
      firstText(record, ['product_name', 'display_name']) ??
      (nestedProduct &&
        firstText(nestedProduct, ['description', 'product_name']));
    const balance = firstNumber(record, [
      'statement_balance_amount',
      'remaining_statement_balance_amount',
      'total_balance_amount',
      'total_balance',
    ]);
    const creditLimit = firstNumber(record, [
      'total_credit_amount',
      'credit_limit_amount',
    ]);
    const availableCredit = firstNumber(record, [
      'available_credit_amount',
      'available_amount',
    ]);

    const existing = accounts.find(a => a.account_token === token);
    if (existing) {
      if (name) existing.name = name;
      if (displayNumber) existing.display_number = displayNumber;
      if (balance !== undefined) existing.balance = balance;
      if (creditLimit !== undefined) existing.credit_limit = creditLimit;
      if (availableCredit !== undefined) {
        existing.available_credit = availableCredit;
      }
    } else {
      accounts.push({
        account_token: token,
        name: name || `Amex Card ****${displayNumber}`,
        display_number: displayNumber,
        balance,
        credit_limit: creditLimit,
        available_credit: availableCredit,
      });
    }
  }
  return accounts;
}

/**
 * Check if we have valid cached session cookies
 */
export function hasValidSession(): boolean {
  if (!cachedSession) return false;
  return Date.now() < cachedSession.expiresAt;
}

/**
 * Get the cached session cookies if still valid
 */
export function getCachedSession(): AmexSession | null {
  if (hasValidSession()) {
    return cachedSession;
  }
  cachedSession = null;
  return null;
}

/**
 * Get cached accounts from the session
 */
export function getCachedAccounts(): AmexAccount[] {
  const session = getCachedSession();
  return session?.accounts || [];
}

/**
 * Extract cookies from browser context
 */
async function extractCookies(
  context: BrowserContext,
): Promise<Record<string, string>> {
  const cookies = await context.cookies();
  const cookieMap: Record<string, string> = {};

  for (const cookie of cookies) {
    cookieMap[cookie.name] = cookie.value;
  }

  return cookieMap;
}

/**
 * Perform Amex login using Playwright
 * Returns session cookies on success
 */
export async function performLogin(): Promise<AmexSession> {
  const progress = { submitted: false };
  try {
    return await attemptLogin(progress);
  } catch (e) {
    // A stall before the form is submitted has cost nothing: no credentials
    // were sent and no verification email was requested, so a fresh browser is
    // free to try once more. Past that point a retry would trigger a second
    // OTP email and look like credential stuffing, so the error stands.
    if (progress.submitted || !isTimeoutError(e)) throw e;
    debug(
      'Login stalled before submitting credentials, retrying once: %s',
      e instanceof Error ? e.message.split('\n')[0] : String(e),
    );
    return await attemptLogin({ submitted: false });
  }
}

async function attemptLogin(progress: {
  submitted: boolean;
}): Promise<AmexSession> {
  const username = secretsService.get(SecretName.amex_username);
  const password = secretsService.get(SecretName.amex_password);

  if (!username || !password) {
    throw new AuthFailedError('Amex credentials not configured');
  }

  debug('Starting Amex login flow...');

  // A previous session may still hold the browser (and the profile lock).
  await closeSessionBrowser();

  let context: BrowserContext | null = null;

  try {
    // Launch a stealth-configured Camoufox context (headful Firefox under a
    // managed virtual display, with humanized cursor movement). Optionally
    // route through a proxy (e.g. socks5://10.0.0.1:1080 for WireGuard/Tailscale).
    const proxyUrl = getProxy();

    // Log configuration status
    debug(
      'Configuration: proxy=%s, captcha=%s, imap=%s',
      proxyUrl ? proxyUrl : 'none',
      isCaptchaServiceConfigured() ? 'configured' : 'not configured',
      isImapConfigured() ? 'configured' : 'not configured',
    );

    if (proxyUrl) {
      debug('Launching browser with SOCKS proxy: %s', proxyUrl);
    } else {
      debug('Launching browser without proxy (using direct connection)');
    }

    context = await launchStealthContext({
      locale: 'it-IT',
      proxyServer: proxyUrl || undefined,
      // Kept between runs so Amex's device trust survives; a fresh profile is
      // challenged with a CAPTCHA every time.
      profile: 'amex',
    });

    const page = context.pages()[0] ?? (await context.newPage());

    // Check external IP to verify proxy is working
    try {
      debug('Checking external IP address...');
      const ipCheckPage = await context.newPage();
      await ipCheckPage.goto('https://api.ipify.org?format=json', {
        timeout: 15000,
      });
      const ipResponse = await ipCheckPage.textContent('body');
      if (ipResponse) {
        const { ip } = JSON.parse(ipResponse);
        debug('External IP: %s (via %s)', ip, proxyUrl ? 'proxy' : 'direct');
      }
      await ipCheckPage.close();
    } catch (e) {
      debug('Could not check external IP: %s', e);
    }

    // Set up response interception to capture account tokens
    const discoveredAccounts: AmexAccount[] = [];

    page.on('response', async response => {
      const url = response.url();

      // Account discovery keys off a fixed set of servicing endpoints below.
      // When Amex moves them the only symptom is "0 accounts", with nothing to
      // say where they went, so record every servicing call that goes past.
      if (
        url.includes('/api/') &&
        !/\.(js|css|png|jpe?g|svg|woff2?)/.test(url)
      ) {
        debug('api call: %s %d', url.split('?')[0], response.status());
      }

      // Any servicing payload may carry accounts; the shape and version keep
      // moving, so match the family of endpoints and search for the token
      // rather than pinning exact paths.
      if (url.includes('/api/servicing/')) {
        try {
          const data = await response.json();
          const before = discoveredAccounts.length;
          mergeDiscoveredAccounts(discoveredAccounts, data);
          if (discoveredAccounts.length !== before) {
            debug(
              'discovered %d account(s) from %s',
              discoveredAccounts.length - before,
              url.split('?')[0],
            );
          }
        } catch {
          // Not JSON, or a body we cannot read: nothing to discover here.
        }
      }
    });

    // Navigate to login page
    debug('Navigating to Amex login page...');
    await page.goto(AMEX_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Handle cookie consent banner if present
    try {
      const acceptCookiesButton = await page.waitForSelector(
        '#user-consent-management-granular-banner-accept-all-button',
        { timeout: 5000 },
      );
      if (acceptCookiesButton) {
        debug('Cookie banner found, accepting cookies...');
        await acceptCookiesButton.click();
        await page.waitForTimeout(1000); // Wait for banner to close
      }
    } catch {
      debug('No cookie banner found, continuing...');
    }

    // Wait for login form
    await page.waitForSelector('#eliloUserID', { timeout: 30000 });

    // Wait a bit for any CAPTCHA/challenge to load
    debug('Waiting for page to fully load...');
    await page.waitForTimeout(5000);

    // Check for CAPTCHA before entering credentials. Amex's page monkeypatches
    // the global `eval`, which makes Playwright-Firefox's page.evaluate throw
    // ("eval is disabled"); detection is best-effort, so treat a failure here
    // as "no captcha found" and let the normal flow proceed.
    debug('Checking for CAPTCHA before login...');
    let preLoginCaptcha = null;
    try {
      preLoginCaptcha = await detectRecaptcha(page);
    } catch (e) {
      debug(
        'CAPTCHA detection skipped (page.evaluate unavailable): %s',
        e instanceof Error ? e.message : String(e),
      );
    }
    if (preLoginCaptcha) {
      debug('CAPTCHA detected before login (type: %s)', preLoginCaptcha.type);

      if (!isCaptchaServiceConfigured()) {
        throw new AuthFailedError(
          'CAPTCHA verification required before login. Configure 2Captcha API key in settings.',
        );
      }

      debug('Solving pre-login CAPTCHA...');
      const token = await solveRecaptcha(
        page.url(),
        preLoginCaptcha.sitekey,
        preLoginCaptcha.type,
      );

      if (!token) {
        throw new AuthFailedError(
          'Failed to solve CAPTCHA. Please try again later.',
        );
      }

      await injectCaptchaToken(page, token);
      debug('Pre-login CAPTCHA solved');
    }

    // Fill in credentials with human-like keystrokes. An instant fill() plus
    // instant click reads as automation to behavioural bot-scoring (e.g. Amex's
    // invisible reCAPTCHA); Camoufox humanizes the cursor, and pressSequentially
    // with a per-key delay humanizes the typing.
    debug('Entering credentials...');
    await clickOrFocus(page, '#eliloUserID');
    await page.locator('#eliloUserID').pressSequentially(username, {
      delay: 90 + Math.floor(Math.random() * 70),
    });
    await clickOrFocus(page, '#eliloPassword');
    await page.locator('#eliloPassword').pressSequentially(password, {
      delay: 90 + Math.floor(Math.random() * 70),
    });

    // Small pause before submitting, as a human would.
    await page.waitForTimeout(400 + Math.floor(Math.random() * 500));

    // Click login button. From here on the attempt is no longer free to retry.
    debug('Clicking login button...');
    progress.submitted = true;
    try {
      await page.click('#loginSubmit', { timeout: CLICK_TIMEOUT_MS });
    } catch (e) {
      if (!isTimeoutError(e)) throw e;
      // The stalled click may still have landed, in which case the form is
      // already gone; failing to press Enter is then not an error, and the
      // checks below decide whether the login went through.
      debug('Click on #loginSubmit stalled, submitting with Enter instead');
      await page
        .locator('#eliloPassword')
        .press('Enter', { timeout: CLICK_TIMEOUT_MS })
        .catch(() => debug('Login form no longer there, carrying on'));
    }

    // Wait for any CAPTCHA or response to appear
    debug('Waiting for login response...');
    await page.waitForTimeout(5000);

    // Debug: Check what's on the page after clicking login. Wrapped because
    // Amex disables eval (see above) — this is diagnostic only, so a failure
    // must not abort the login.
    const pageStateAfterClick = await page
      .evaluate(() => {
        // Check for any error messages
        const errorElements = document.querySelectorAll(
          '[class*="error"], [class*="alert"], [role="alert"], [data-testid*="error"]',
        );
        const errors = Array.from(errorElements)
          .map(el => el.textContent?.trim())
          .filter(Boolean);

        // Check for any overlays or modals
        const overlays = document.querySelectorAll(
          '[class*="overlay"], [class*="modal"], [class*="captcha"], [class*="challenge"]',
        );
        const overlayInfo = Array.from(overlays).map(el => ({
          class: el.className,
          visible:
            (el as HTMLElement).offsetParent !== null ||
            getComputedStyle(el).display !== 'none',
        }));

        // Check if login button is still enabled
        const loginBtn = document.querySelector(
          '#loginSubmit',
        ) as HTMLButtonElement;
        const btnState = loginBtn
          ? {
              disabled: loginBtn.disabled,
              text: loginBtn.textContent,
            }
          : null;

        // Check for form validation errors (inline errors on fields)
        const formErrors: string[] = [];
        const userIdField = document.querySelector('#eliloUserID');
        const passwordField = document.querySelector('#eliloPassword');
        if (userIdField) {
          const userIdError = userIdField.getAttribute('aria-describedby');
          if (userIdError) {
            const errorEl = document.getElementById(userIdError);
            if (errorEl?.textContent) {
              formErrors.push(`UserID: ${errorEl.textContent}`);
            }
          }
        }
        if (passwordField) {
          const pwdError = passwordField.getAttribute('aria-describedby');
          if (pwdError) {
            const errorEl = document.getElementById(pwdError);
            if (errorEl?.textContent) {
              formErrors.push(`Password: ${errorEl.textContent}`);
            }
          }
        }

        // Check for any visible text that might indicate an error
        const loginContainer = document.querySelector(
          '[data-module-name="axp-login"]',
        );
        const containerText =
          loginContainer?.textContent?.substring(0, 500) || '';

        // Check for iframes (possible hidden CAPTCHA)
        const iframes = document.querySelectorAll('iframe');
        const iframeInfo = Array.from(iframes).map(iframe => ({
          src: iframe.src,
          visible: (iframe as HTMLElement).offsetParent !== null,
        }));

        return {
          errors,
          overlays: overlayInfo,
          buttonState: btnState,
          formErrors,
          iframes: iframeInfo,
          containerText,
        };
      })
      .catch(e => ({
        evalDisabled: e instanceof Error ? e.message : String(e),
      }));
    debug('Page state after login click: %o', pageStateAfterClick);

    // Check for CAPTCHA and try to solve it
    const captcha = await detectRecaptcha(page);
    if (captcha) {
      debug('CAPTCHA detected (type: %s)', captcha.type);

      if (!isCaptchaServiceConfigured()) {
        debug('CAPTCHA detected but 2Captcha not configured');
        throw new AuthFailedError(
          'CAPTCHA verification required. Configure 2Captcha API key in settings or try again later.',
        );
      }

      debug('Attempting to solve CAPTCHA with 2Captcha...');
      const token = await solveRecaptcha(
        page.url(),
        captcha.sitekey,
        captcha.type,
      );

      if (!token) {
        throw new AuthFailedError(
          'Failed to solve CAPTCHA. Please try again later.',
        );
      }

      await injectCaptchaToken(page, token);
      debug('CAPTCHA solved and token injected');

      // Re-click login button after solving CAPTCHA
      await page.click('#loginSubmit');
      await page.waitForTimeout(2000);
    }

    // Check for any blocking modal or overlay
    const blockingOverlay = await page.$(
      '[data-testid="modal-overlay"], .modal-overlay, #security-challenge',
    );
    if (blockingOverlay) {
      debug('Security challenge modal detected');
      throw new AuthFailedError(
        'Security challenge detected. Please log in manually to verify your account.',
      );
    }

    // Wait for either:
    // 1. Successful redirect to dashboard
    // 2. 2FA prompt
    // 3. Error message

    debug('Waiting for login result...');

    // Wait for one of several possible outcomes
    let is2FAPage = false;

    try {
      // Race between 2FA page appearing, successful login redirect, or error
      const result = await Promise.race([
        page
          .waitForSelector('[data-testid="challenge-options-list"]', {
            timeout: LOGIN_TIMEOUT_MS,
          })
          .then(() => '2fa'),
        page
          .waitForURL('**/dashboard**', { timeout: LOGIN_TIMEOUT_MS })
          .then(() => 'dashboard'),
        page
          .waitForURL('**/myca/**', { timeout: LOGIN_TIMEOUT_MS })
          .then(() => 'myca'),
        page
          .waitForURL('**/activity**', { timeout: LOGIN_TIMEOUT_MS })
          .then(() => 'activity'),
        page
          .waitForSelector('h1:has-text("Verifica la tua identità")', {
            timeout: LOGIN_TIMEOUT_MS,
          })
          .then(() => '2fa'),
        page
          .waitForSelector('[data-testid="login-message-container"]', {
            timeout: LOGIN_TIMEOUT_MS,
          })
          .then(() => 'error'),
      ]);

      debug('Login result: %s', result);

      // Check for login error (wrong credentials)
      if (result === 'error') {
        const errorContainer = await page.$(
          '[data-testid="login-message-container"]',
        );
        if (errorContainer) {
          const errorText = await errorContainer.textContent();
          debug('Login error: %s', errorText);
          throw new AuthFailedError(
            errorText?.trim() || 'Invalid username or password',
          );
        }
      }

      is2FAPage = result === '2fa';
    } catch (e) {
      if (e instanceof AuthFailedError) {
        throw e;
      }
      debug('Timeout waiting for login result, checking current state...');

      // Save screenshot for debugging on timeout
      try {
        const screenshotPath = '/tmp/amex-login-timeout.png';
        await page.screenshot({ path: screenshotPath, fullPage: true });
        debug('Timeout screenshot saved to: %s', screenshotPath);
      } catch (screenshotError) {
        debug('Could not save timeout screenshot: %s', screenshotError);
      }

      // Check for error messages that might have appeared
      const errorText = await page
        .$eval(
          '[data-testid="login-message-container"], .error-message, [role="alert"], .axp-global-alert',
          el => el.textContent,
        )
        .catch(() => null);

      if (errorText) {
        debug('Found error message: %s', errorText);
        throw new AuthFailedError(errorText.trim());
      }

      // Check if still on login page and if login is still in progress
      const stillOnLogin = page.url().includes('/login');
      if (stillOnLogin) {
        // Check if button is still in loading state (has spinner)
        const loginButton = await page.$('#loginSubmit');
        const buttonText = loginButton
          ? await loginButton
              .evaluate(el => el.innerHTML.trim())
              .catch(() => '')
          : '';
        const isStillLoading =
          buttonText === '&nbsp;' ||
          buttonText.includes('spinner') ||
          buttonText.includes('loading') ||
          buttonText === '';

        debug(
          'Still on login page, button loading: %s, text: %s',
          isStillLoading,
          buttonText,
        );

        // If button is still loading, wait another timeout period
        if (isStillLoading) {
          debug(
            'Login still in progress, waiting another %dms...',
            LOGIN_TIMEOUT_MS,
          );

          try {
            // Wait for successful redirect, 2FA, or error
            const retryResult = await Promise.race([
              page
                .waitForSelector('[data-testid="challenge-options-list"]', {
                  timeout: LOGIN_TIMEOUT_MS,
                })
                .then(() => '2fa'),
              page
                .waitForURL('**/dashboard**', { timeout: LOGIN_TIMEOUT_MS })
                .then(() => 'dashboard'),
              page
                .waitForURL('**/myca/**', { timeout: LOGIN_TIMEOUT_MS })
                .then(() => 'myca'),
              page
                .waitForURL('**/activity**', { timeout: LOGIN_TIMEOUT_MS })
                .then(() => 'activity'),
              page
                .waitForSelector('h1:has-text("Verifica la tua identità")', {
                  timeout: LOGIN_TIMEOUT_MS,
                })
                .then(() => '2fa'),
              page
                .waitForSelector('[data-testid="login-message-container"]', {
                  timeout: LOGIN_TIMEOUT_MS,
                })
                .then(() => 'error'),
            ]);

            debug('Retry login result: %s', retryResult);

            if (retryResult === 'error') {
              const errorContainer = await page.$(
                '[data-testid="login-message-container"]',
              );
              if (errorContainer) {
                const retryErrorText = await errorContainer.textContent();
                throw new AuthFailedError(
                  retryErrorText?.trim() || 'Invalid username or password',
                );
              }
            }

            // Set is2FAPage if 2FA was detected - the flow below will handle it
            if (retryResult === '2fa') {
              is2FAPage = true;
            }
          } catch (retryError) {
            if (retryError instanceof AuthFailedError) {
              throw retryError;
            }

            // Save screenshot for debugging on retry timeout
            try {
              const screenshotPath = '/tmp/amex-login-retry-timeout.png';
              await page.screenshot({ path: screenshotPath, fullPage: true });
              debug('Retry timeout screenshot saved to: %s', screenshotPath);
            } catch (screenshotError) {
              debug('Could not save retry screenshot: %s', screenshotError);
            }

            // Check button state again after retry timeout
            const retryButtonText = loginButton
              ? await loginButton
                  .evaluate(el => el.innerHTML.trim())
                  .catch(() => '')
              : '';
            const stillLoading =
              retryButtonText === '&nbsp;' ||
              retryButtonText.includes('spinner') ||
              retryButtonText.includes('loading') ||
              retryButtonText === '';

            debug(
              'After retry - still loading: %s, text: %s',
              stillLoading,
              retryButtonText,
            );

            if (stillLoading) {
              throw new AuthFailedError(
                'Login timed out after extended wait - the request is still in progress. This usually happens with a slow network connection or proxy. Try again or check your connection speed.',
              );
            }
            // If not loading anymore but still on login page, will be handled below
          }
        }
      }
    }

    let currentUrl = page.url();
    debug('Current URL after login: %s', currentUrl);

    // Also check URL for 2FA indicators
    if (
      !is2FAPage &&
      (currentUrl.includes('verification') ||
        currentUrl.includes('challenge') ||
        currentUrl.includes('authenticate'))
    ) {
      is2FAPage = true;
    }

    // Check for 2FA verification page
    if (is2FAPage) {
      debug('2FA verification required');

      if (!isImapConfigured()) {
        throw new AuthFailedError(
          '2FA is required but IMAP is not configured. Please configure IMAP settings for email verification.',
        );
      }

      // Record time before requesting code
      const codeRequestTime = new Date();

      // Click on email verification option
      debug('Selecting email verification option...');
      const emailOption = await page.$(
        'button[data-testid="option-button"]:has-text("e-mail")',
      );
      if (!emailOption) {
        throw new AuthFailedError('Could not find email verification option');
      }
      await emailOption.click();

      // Wait for the code input page
      debug('Waiting for code input page...');
      await page.waitForTimeout(2000);

      // Wait for verification code via IMAP
      debug('Waiting for verification email...');
      const verificationCode = await waitForAmexVerificationCode(
        codeRequestTime,
        120000, // 2 minute timeout
      );

      if (!verificationCode) {
        throw new AuthFailedError(
          'Timeout waiting for verification email. Please try again.',
        );
      }

      debug('Got verification code, entering...');

      // Find and fill the OTP input field
      // Try multiple selectors in order of specificity
      const otpSelectors = [
        'input[data-testid="question-value"]', // Amex Italy OTP page
        'input[autocomplete="one-time-code"]',
        'input#question-value',
        'input[type="tel"]',
        'input[type="text"][maxlength="6"]',
        'input[name*="otp"]',
        'input[name*="code"]',
      ];

      let otpInput = null;
      for (const selector of otpSelectors) {
        otpInput = await page.$(selector);
        if (otpInput) {
          debug('Found OTP input with selector: %s', selector);
          break;
        }
      }

      if (otpInput) {
        await otpInput.fill(verificationCode);
      } else {
        // Try individual digit inputs as fallback
        const digitInputs = await page.$$('input[type="tel"][maxlength="1"]');
        if (digitInputs.length === 6) {
          for (let i = 0; i < 6; i++) {
            await digitInputs[i].fill(verificationCode[i]);
          }
        } else {
          throw new AuthFailedError('Could not find OTP input field');
        }
      }

      // Submit the verification code
      const submitSelectors = [
        'button[data-testid="continue-button"]', // Amex Italy OTP page
        'button[type="submit"]',
        'button:has-text("Verifica")',
        'button:has-text("Continua")',
      ];

      for (const selector of submitSelectors) {
        const submitButton = await page.$(selector);
        if (submitButton) {
          debug('Found submit button with selector: %s', selector);
          await submitButton.click();
          break;
        }
      }

      // Wait for navigation or page change after OTP submit
      debug('Waiting for post-OTP navigation...');
      try {
        // Wait for either URL change or trust device page to appear
        await Promise.race([
          page.waitForURL(url => !url.href.includes('two-step-verification'), {
            timeout: 10000,
          }),
          page.waitForSelector('#trustDevice', { timeout: 10000 }),
          page.waitForSelector('input[name="device-name"]', { timeout: 10000 }),
        ]);
      } catch {
        debug('Timeout waiting for post-OTP navigation, continuing...');
      }

      await page.waitForTimeout(1000); // Small buffer for page to stabilize

      currentUrl = page.url();
      debug('Current URL after OTP: %s', currentUrl);

      // Only look for an error while still on the verification page. Reaching
      // the dashboard means the code was accepted, and `[role="alert"]` also
      // matches Amex's dismissible marketing banners there -- which otherwise
      // fails a login that has already succeeded.
      const stillVerifying = currentUrl.includes('two-step-verification');
      const otpError = stillVerifying
        ? await page.$(
            '[data-testid="error-message"], .error-message, [role="alert"]',
          )
        : null;
      if (otpError) {
        const errorText = await otpError.textContent();
        debug('OTP error detected: %s', errorText);
        throw new AuthFailedError(`OTP verification failed: ${errorText}`);
      }

      // Check for "trust device" page (appears after successful 2FA)
      // Multiple ways to detect it
      const trustDeviceCheckbox = await page.$('#trustDevice');
      const trustDeviceInput = await page.$(
        'input[name="device-name"], #device-name-input',
      );
      const isTrustDevicePage = trustDeviceCheckbox || trustDeviceInput;

      if (isTrustDevicePage) {
        debug('Trust device page detected');

        // Optionally check the "trust device" checkbox using the label (to avoid interception issues)
        // The label intercepts clicks to the hidden checkbox, so click the label instead
        const trustDeviceLabel = await page.$('label[for="trustDevice"]');
        if (trustDeviceLabel) {
          try {
            await trustDeviceLabel.click({ force: true });
            debug('Clicked trust device label');
          } catch (e) {
            debug('Could not click trust device label (optional): %s', e);
          }
        }

        // Must be the visible button: this page carries hidden submit buttons
        // too, and clicking one of those aborts the login right at the point
        // where the device would have been registered.
        const continueButton = await findVisible(page, [
          'button[data-testid="continue-button"]',
          'button[type="submit"]',
          'button:has-text("Continua")',
        ]);
        if (continueButton) {
          debug('Clicking continue on trust device page...');
          await continueButton.click({ force: true });

          // Wait for navigation after trust device
          try {
            await page.waitForURL(
              url => !url.href.includes('two-step-verification'),
              {
                timeout: 10000,
              },
            );
          } catch {
            debug('Timeout waiting for post-trust-device navigation');
          }

          await page.waitForTimeout(2000);
          currentUrl = page.url();
          debug('Current URL after trust device: %s', currentUrl);

          // Amex sometimes redirects to login page even when authenticated
          // Check if we're actually logged in (logout link present) and navigate to dashboard
          if (currentUrl.includes('login')) {
            const logoutLink = await page.$(
              'a[href*="logout"], a:has-text("Esci")',
            );
            if (logoutLink) {
              debug(
                'On login page but logout link found - already authenticated, navigating to dashboard',
              );
              await page.goto(AMEX_DASHBOARD_URL, {
                waitUntil: 'networkidle',
                timeout: LOGIN_TIMEOUT_MS,
              });
              await page.waitForTimeout(2000);
              currentUrl = page.url();
              debug('Navigated to dashboard: %s', currentUrl);
            }
          }
        }
      }
    }

    // Check for error message
    const errorElement = await page.$('.error-message');
    if (errorElement) {
      const errorText = await errorElement.textContent();
      debug('Login error: %s', errorText);
      throw new AuthFailedError(`Login failed: ${errorText}`);
    }

    // Verify we reached a logged-in page
    const isLoggedIn =
      currentUrl.includes('dashboard') ||
      currentUrl.includes('myca') ||
      currentUrl.includes('activity') ||
      currentUrl.includes('global.americanexpress.com');

    if (!isLoggedIn) {
      debug('Unexpected URL after login: %s', currentUrl);

      if (currentUrl.includes('login')) {
        // Still on login page - login failed
        throw new AuthFailedError(
          'Login failed - page did not redirect. This often happens when Amex detects a datacenter/VPS IP address. Try configuring a proxy to route traffic through a residential IP (e.g., your home network via WireGuard/SOCKS5). Could also be incorrect credentials or rate limiting.',
        );
      }

      throw new AuthFailedError('Login failed - unexpected redirect');
    }

    debug('Login successful, extracting cookies...');

    // Wait a bit for all cookies to be set
    await page.waitForTimeout(2000);

    // Extract cookies
    const cookies = await extractCookies(context);

    // Verify we have the essential aat cookie
    if (!cookies['aat']) {
      debug('Missing aat cookie, available cookies: %o', Object.keys(cookies));
      throw new AuthFailedError('Login succeeded but session cookie not found');
    }

    // Ask the servicing API directly before falling back to watching the page.
    // Interception only sees a request the app actually makes, and with a warm
    // profile the dashboard renders from its own cache without re-fetching, so
    // the better the session persistence works the less there is to intercept.
    // Opened before discovery so it, and every later request in this
    // session, runs inside the browser. See sessionContext for why.
    const apiPage = await openApiPage(context);

    if (discoveredAccounts.length === 0) {
      for (const url of AMEX_ACCOUNT_SOURCES) {
        const path = url.replace(AMEX_API_ORIGIN, '');
        try {
          const response = await pageFetch(apiPage, url);

          if (response.status < 200 || response.status >= 300) {
            debug('discovery %s -> %d', path, response.status);
            continue;
          }

          const body = response.text;
          let payload: unknown;
          try {
            payload = JSON.parse(body);
          } catch {
            debug('discovery %s -> 200 but not JSON', path);
            continue;
          }

          const before = discoveredAccounts.length;
          mergeDiscoveredAccounts(discoveredAccounts, payload);
          const gained = discoveredAccounts.length - before;
          debug(
            'discovery %s -> 200, %d bytes, +%d account(s)',
            path,
            body.length,
            gained,
          );
          // Only worth saying when nothing was found: naming the fields that
          // are present makes a renamed identifier obvious rather than
          // invisible.
          if (gained === 0) {
            debug(
              '  candidate keys: %s',
              describeKeys(payload).join(', ') || '(none)',
            );
          }
        } catch (e) {
          debug(
            'discovery %s failed: %s',
            path,
            e instanceof Error ? e.message : e,
          );
        }
      }
      debug('direct discovery found %d account(s)', discoveredAccounts.length);

      // Second pass: the financial endpoints answer 400 unless told which
      // account to describe, so they can only run now that the tokens are
      // known. This is what supplies the product name, last four and balance
      // that the listing endpoints leave out.
      for (const account of discoveredAccounts) {
        for (const url of AMEX_ACCOUNT_DETAIL_SOURCES) {
          const path = url.replace(AMEX_API_ORIGIN, '');
          try {
            const response = await pageFetch(apiPage, url, {
              account_token: account.account_token,
            });
            if (response.status < 200 || response.status >= 300) {
              debug('detail %s -> %d', path, response.status);
              continue;
            }
            mergeDiscoveredAccounts(
              discoveredAccounts,
              JSON.parse(response.text),
            );
            debug('detail %s -> 200', path);
          } catch (e) {
            debug(
              'detail %s failed: %s',
              path,
              e instanceof Error ? e.message : e,
            );
          }
        }
      }

      for (const account of discoveredAccounts) {
        debug(
          'account %s: name=%s ****%s balance=%s limit=%s',
          account.account_token,
          account.name,
          account.display_number,
          account.balance,
          account.credit_limit,
        );
      }
    }

    // Navigate to dashboard to trigger API calls for account discovery
    if (discoveredAccounts.length === 0) {
      debug('No accounts discovered yet, navigating to dashboard...');
      try {
        await page.goto(AMEX_DASHBOARD_URL, {
          waitUntil: 'networkidle',
          timeout: LOGIN_TIMEOUT_MS,
        });
        // Wait for API responses to be intercepted
        await page.waitForTimeout(3000);
        debug(
          'Discovered %d accounts from dashboard',
          discoveredAccounts.length,
        );
      } catch (e) {
        debug('Error navigating to dashboard: %s', e);
      }
    }

    const now = Date.now();
    cachedSession = {
      cookies,
      accounts: discoveredAccounts,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };

    debug(
      'Session created with %d accounts, expires at: %s',
      discoveredAccounts.length,
      new Date(cachedSession.expiresAt),
    );

    // The browser now belongs to the session: see sessionContext.
    sessionContext = context;
    sessionApiPage = apiPage;
    context = null;
    sessionCloseTimer = setTimeout(() => {
      debug('Session TTL elapsed, closing browser');
      void closeSessionBrowser();
    }, SESSION_TTL_MS);
    sessionCloseTimer.unref?.();

    return cachedSession;
  } finally {
    // Still set only when login failed; success hands it to the session.
    if (context) {
      await closeStealthContext(context);
    }
  }
}

/**
 * Get valid session cookies, performing login if needed
 */
export async function getSessionCookies(): Promise<Record<string, string>> {
  const cached = getCachedSession();
  if (cached) {
    debug('Using cached session');
    return cached.cookies;
  }

  debug('No valid session, performing login...');
  const session = await performLogin();
  return session.cookies;
}

/**
 * Clear the cached session (call when session is detected as expired)
 */
export function clearSession(): void {
  debug('Clearing cached session');
  cachedSession = null;
  void closeSessionBrowser();
}

/**
 * Build cookie header string from cookies object
 */
export function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
