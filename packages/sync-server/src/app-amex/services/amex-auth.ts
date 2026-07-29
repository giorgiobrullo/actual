import createDebug from 'debug';
import type { BrowserContext } from 'playwright-core';

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

// Login timeout - increased for slow proxy connections
const LOGIN_TIMEOUT_MS = 60000;

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
  const username = secretsService.get(SecretName.amex_username);
  const password = secretsService.get(SecretName.amex_password);

  if (!username || !password) {
    throw new AuthFailedError('Amex credentials not configured');
  }

  debug('Starting Amex login flow...');

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
      // Look for API responses that contain account tokens
      if (
        url.includes('/api/servicing/v1/financials/credit_limits') ||
        url.includes('/api/servicing/v1/financials/balances') ||
        url.includes('/api/servicing/v1/financials/transaction_summary') ||
        url.includes('/api/servicing/v1/member')
      ) {
        try {
          const data = await response.json();
          debug('Intercepted API response from %s: %o', url, data);

          // Handle array responses (credit_limits, balances, transaction_summary)
          if (Array.isArray(data)) {
            for (const item of data) {
              if (item.account_token) {
                const existing = discoveredAccounts.find(
                  a => a.account_token === item.account_token,
                );
                if (existing) {
                  // Merge additional data into existing account
                  if (item.total_credit_amount) {
                    existing.credit_limit = item.total_credit_amount;
                  }
                  if (item.available_credit_amount) {
                    existing.available_credit = item.available_credit_amount;
                  }
                  if (item.product_name) existing.name = item.product_name;
                  if (item.display_account_number) {
                    existing.display_number = item.display_account_number;
                  }
                  // Balance from /balances endpoint
                  if (item.statement_balance_amount !== undefined) {
                    existing.balance = item.statement_balance_amount;
                  } else if (
                    item.remaining_statement_balance_amount !== undefined
                  ) {
                    existing.balance = item.remaining_statement_balance_amount;
                  }
                  // transaction_summary provides embossed_name in accounts_total
                  if (
                    item.accounts_total &&
                    Array.isArray(item.accounts_total)
                  ) {
                    const firstAccount = item.accounts_total[0];
                    if (
                      firstAccount?.embossed_name &&
                      !existing.name.includes('Card')
                    ) {
                      // Only update if we don't already have a good name
                    } else if (firstAccount?.embossed_name) {
                      existing.name = firstAccount.embossed_name;
                    }
                    if (firstAccount?.display_account_number) {
                      existing.display_number =
                        firstAccount.display_account_number;
                    }
                  }
                } else {
                  // Create new account entry
                  // Extract embossed name from transaction_summary if available
                  let accountName = item.product_name || item.display_name;
                  let displayNumber =
                    item.display_account_number || item.account_token.slice(-4);

                  if (
                    item.accounts_total &&
                    Array.isArray(item.accounts_total)
                  ) {
                    const firstAccount = item.accounts_total[0];
                    if (firstAccount?.embossed_name) {
                      accountName = firstAccount.embossed_name;
                    }
                    if (firstAccount?.display_account_number) {
                      displayNumber = firstAccount.display_account_number;
                    }
                  }

                  const balance =
                    item.statement_balance_amount ??
                    item.remaining_statement_balance_amount ??
                    item.total_balance;
                  discoveredAccounts.push({
                    account_token: item.account_token,
                    name: accountName || `Amex Card ****${displayNumber}`,
                    display_number: displayNumber,
                    // Balance comes from /balances endpoint as statement_balance_amount or remaining_statement_balance_amount
                    balance,
                    credit_limit: item.total_credit_amount,
                    available_credit: item.available_credit_amount,
                  });
                  debug(
                    'Discovered account: %s (name: %s, balance: %d, limit: %d)',
                    item.account_token,
                    accountName,
                    balance,
                    item.total_credit_amount,
                  );
                }
              }
            }
          }
        } catch {
          // Ignore parse errors
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
    await page.click('#eliloUserID');
    await page.locator('#eliloUserID').pressSequentially(username, {
      delay: 90 + Math.floor(Math.random() * 70),
    });
    await page.click('#eliloPassword');
    await page.locator('#eliloPassword').pressSequentially(password, {
      delay: 90 + Math.floor(Math.random() * 70),
    });

    // Small pause before submitting, as a human would.
    await page.waitForTimeout(400 + Math.floor(Math.random() * 500));

    // Click login button
    debug('Clicking login button...');
    await page.click('#loginSubmit');

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

      // Check for OTP error message
      const otpError = await page.$(
        '[data-testid="error-message"], .error-message, [role="alert"]',
      );
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

        // Click continue button with force to bypass any overlapping elements
        const continueButton = await page.$('button[type="submit"]');
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

    return cachedSession;
  } finally {
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
}

/**
 * Build cookie header string from cookies object
 */
export function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
