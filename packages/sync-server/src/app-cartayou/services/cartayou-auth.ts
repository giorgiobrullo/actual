import createDebug from 'debug';
import type { BrowserContext } from 'playwright-core';

import type { CartaYouAccount } from '#app-cartayou/models/cartayou';
import { AuthFailedError } from '#app-cartayou/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';
import {
  closeStealthContext,
  launchStealthContext,
} from '#services/stealth-browser';

import * as smsOtpService from './sms-otp-service';

const debug = createDebug('actual:cartayou:auth');

// Carta You URLs
const CARTAYOU_LOGIN_URL = 'https://my.cartayou.it/b2c/it/';
const CARTAYOU_DASHBOARD_URL = 'https://my.cartayou.it/';

// Session cache - stores browser context for reuse
type CartaYouSession = {
  cookies: Record<string, string>;
  accounts: CartaYouAccount[];
  createdAt: number;
  expiresAt: number;
};

let cachedSession: CartaYouSession | null = null;

// Session TTL - 10 minutes (Carta You sessions tend to be longer-lived)
const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * Check if we have a valid cached session
 */
export function hasValidSession(): boolean {
  if (!cachedSession) {
    return false;
  }
  return Date.now() < cachedSession.expiresAt;
}

/**
 * Get cached session if valid
 */
export function getCachedSession(): CartaYouSession | null {
  if (hasValidSession()) {
    return cachedSession;
  }
  cachedSession = null;
  return null;
}

/**
 * Get cached accounts from the session
 */
export function getCachedAccounts(): CartaYouAccount[] {
  const session = getCachedSession();
  return session?.accounts || [];
}

/**
 * Extract cookies from browser context
 * Gets ALL cookies to ensure we capture frontCookie and other auth cookies
 */
async function extractCookies(
  context: BrowserContext,
): Promise<Record<string, string>> {
  // Get ALL cookies (no URL filter)
  const cookies = await context.cookies();
  const cookieMap: Record<string, string> = {};

  for (const cookie of cookies) {
    // Only include cookies for cartayou.it domains
    if (cookie.domain.includes('cartayou.it')) {
      cookieMap[cookie.name] = cookie.value;
      debug(
        'Cookie: %s = %s... (domain: %s, httpOnly: %s, secure: %s)',
        cookie.name,
        cookie.value.substring(0, 30),
        cookie.domain,
        cookie.httpOnly,
        cookie.secure,
      );
    }
  }

  return cookieMap;
}

/**
 * Perform login to Carta You
 * Handles the full flow: login -> 2FA selection -> OTP entry
 */
export async function performLogin(): Promise<CartaYouSession> {
  const username = secretsService.get(SecretName.cartayou_username);
  const password = secretsService.get(SecretName.cartayou_password);

  if (!username || !password) {
    throw new AuthFailedError('Carta You credentials not configured');
  }

  debug('Starting Carta You login flow...');

  let context: BrowserContext | null = null;

  try {
    // Launch a stealth-configured Camoufox context (headful Firefox under a
    // managed virtual display, with humanized cursor movement).
    // Persistent profile: a recognised device is challenged less, and may let
    // the bank skip the SMS step entirely on later runs.
    context = await launchStealthContext({
      locale: 'it-IT',
      profile: 'cartayou',
    });

    const page = context.pages()[0] ?? (await context.newPage());

    // Set up response interception to capture account data
    const discoveredAccounts: CartaYouAccount[] = [];

    page.on('response', async response => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      // Log all JSON API responses for debugging
      if (contentType.includes('application/json') && !url.includes('.json')) {
        debug('API Response: %s', url);
      }

      // Look for API responses that contain account/transaction information
      // Pattern: /api/accounts/{uuid}/transactions
      const accountTransactionsMatch = url.match(
        /\/api\/accounts\/([0-9a-f-]+)\/transactions/i,
      );
      if (
        accountTransactionsMatch &&
        contentType.includes('application/json')
      ) {
        const accountId = accountTransactionsMatch[1];
        debug('Found transactions for account: %s', accountId);

        // Add this account if we haven't seen it yet
        const existing = discoveredAccounts.find(
          a => a.account_id === accountId,
        );
        if (!existing) {
          discoveredAccounts.push({
            account_id: accountId,
            name: 'Carta You Credit Card',
            display_number: accountId.slice(-4),
          });
          debug('Discovered account from transactions URL: %s', accountId);
        }
      }

      // Look for customer profile endpoint - best source for account info
      // Pattern: /api/customers/profile/v2/
      if (
        contentType.includes('application/json') &&
        url.includes('/api/customers/profile')
      ) {
        try {
          const data = await response.json();
          debug('Intercepted customer profile from %s: %o', url, data);

          // Extract accounts from customerProfile.accounts[]
          const accounts = data?.customerProfile?.accounts || [];
          for (const account of accounts) {
            if (account.accountId) {
              const existing = discoveredAccounts.find(
                a => a.account_id === account.accountId,
              );
              if (!existing) {
                const card = account.activeCard || {};
                discoveredAccounts.push({
                  account_id: account.accountId,
                  name: card.cardBrandName || 'Carta You Credit Card',
                  display_number:
                    card.last4DigitsCardNumber || account.accountId.slice(-4),
                });
                debug(
                  'Discovered account from profile: %s (%s ****%s)',
                  account.accountId,
                  card.cardBrandName,
                  card.last4DigitsCardNumber,
                );
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Also look for accounts list endpoint as fallback
      if (
        contentType.includes('application/json') &&
        url.includes('/api/accounts') &&
        !url.includes('/transactions')
      ) {
        try {
          const data = await response.json();
          debug('Intercepted accounts response from %s: %o', url, data);

          // Handle accounts list response
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item.accountId || item.id) {
              const accountId = item.accountId || item.id;
              const existing = discoveredAccounts.find(
                a => a.account_id === accountId,
              );
              if (!existing) {
                discoveredAccounts.push({
                  account_id: accountId,
                  name:
                    item.productName || item.name || 'Carta You Credit Card',
                  display_number:
                    item.cardNumber?.slice(-4) || accountId.slice(-4),
                  balance: item.balance ?? item.currentBalance,
                  credit_limit: item.creditLimit ?? item.limit,
                  available_credit: item.availableCredit ?? item.available,
                });
                debug('Discovered account: %s', accountId);
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    });

    // Navigate to login page
    debug('Navigating to Carta You login page...');
    await page.goto(CARTAYOU_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // Wait for redirect to login form
    debug('Waiting for login form...');
    await page.waitForSelector('#username', { timeout: 30000 });

    // Dismiss cookie banner if present (Piwik PRO consent manager)
    try {
      debug('Waiting for cookie banner...');
      await page.waitForSelector('#ppms_cm_reject-all', { timeout: 5000 });
      debug('Cookie banner detected, dismissing...');
      await page.click('#ppms_cm_reject-all');
      await page.waitForTimeout(500);
    } catch {
      debug('No cookie banner found, continuing...');
    }

    // Fill in credentials
    debug('Entering credentials...');
    await page.fill('#username', username);
    await page.fill('#password', password);

    // Declared before submitting, since that is what makes the bank send the
    // SMS. Doing it later (when the OTP page appears) would be too late: the
    // code can arrive while the page is still navigating.
    smsOtpService.beginAttempt();

    // Click login button
    debug('Clicking login button...');
    await page.click('[data-testid="loginButton"]');

    // Wait for either 2FA selection page, dashboard, or error
    debug('Waiting for post-login navigation...');
    try {
      const result = await Promise.race([
        // 2FA selection page - "Scegli il tuo metodo di autenticazione"
        page
          .waitForSelector('h2:has-text("Scegli il tuo metodo")', {
            timeout: 30000,
          })
          .then(() => '2fa-selection'),
        // OTP input page directly
        page
          .waitForSelector('[data-input-otp="true"]', { timeout: 30000 })
          .then(() => 'otp-input'),
        // Dashboard (successful login without 2FA)
        page
          .waitForURL('**/dashboard**', { timeout: 30000 })
          .then(() => 'dashboard'),
        page
          .waitForURL('**/home**', { timeout: 30000 })
          .then(() => 'dashboard'),
        // Error state - check for error messages
        page
          .waitForSelector('[class*="error"], [class*="alert--error"]', {
            timeout: 30000,
          })
          .then(() => 'error'),
      ]);

      debug('Login result: %s', result);

      // Check for login error
      if (result === 'error') {
        const errorElement = await page.$(
          '[class*="error"], [class*="alert--error"]',
        );
        if (errorElement) {
          const errorText = await errorElement.textContent();
          debug('Login error: %s', errorText);
          throw new AuthFailedError(
            errorText?.trim() || 'Invalid username or password',
          );
        }
      }

      // Handle 2FA selection if needed
      if (result === '2fa-selection') {
        debug('2FA selection page detected, selecting SMS option...');

        // Click the first menu item (SMS option)
        // The SMS option contains "Inviare un SMS" text
        const smsOption = await page.$(
          '._menu__item_1h1sp_13:has-text("SMS"), li:has-text("Inviare un SMS") ._menu__item_1h1sp_13, li:first-child ._menu__item_1h1sp_13',
        );

        if (smsOption) {
          await smsOption.click();
          debug('Clicked SMS option');
        } else {
          // Try alternative selector - first menu item
          const firstMenuItem = await page.$(
            'li:first-child > div, li:first-child',
          );
          if (firstMenuItem) {
            await firstMenuItem.click();
            debug('Clicked first menu item');
          }
        }

        // Wait for OTP input page
        await page.waitForSelector('[data-input-otp="true"]', {
          timeout: 15000,
        });
        debug('OTP input page loaded');
      }

      // Now we should be on the OTP input page
      let currentUrl = page.url();
      debug('Current URL: %s', currentUrl);

      // Check if we're on OTP page
      const otpInput = await page.$('[data-input-otp="true"]');
      if (otpInput) {
        debug('On OTP input page, waiting for SMS code...');

        // No clearing here: the code may already have arrived while the page
        // was navigating. beginAttempt() (before the submit) is what scopes
        // which codes are eligible.
        const otpCode = await smsOtpService.waitForOTP(120000, 1000);

        if (!otpCode) {
          debug('Timeout waiting for OTP from SMS webhook');
          throw new AuthFailedError(
            'OTP verification timeout - SMS code was not received. Make sure your iPhone is on and the automation is configured.',
          );
        }

        debug('Received OTP code: %s', otpCode);

        // Find all OTP input fields and fill them
        // OTP inputs are typically individual input fields for each digit
        const otpInputs = await page.$$(
          '[data-input-otp="true"] input, [data-input-otp="true"]',
        );

        if (otpInputs.length >= otpCode.length) {
          // Fill each digit into its corresponding input
          for (let i = 0; i < otpCode.length; i++) {
            await otpInputs[i].fill(otpCode[i]);
            await page.waitForTimeout(50); // Small delay between inputs
          }
          debug('Filled OTP code into %d input fields', otpCode.length);
        } else {
          // Single input field - fill the entire code
          await otpInput.fill(otpCode);
          debug('Filled OTP code into single input field');
        }

        // Clear the OTP after using it
        smsOtpService.clearOTP();

        // Wait for navigation away from OTP page (auto-submits or we need to click)
        try {
          // First check if there's a submit button to click
          const submitButton = await page.$(
            'button[type="submit"], [data-testid="submitButton"], button:has-text("Conferma"), button:has-text("Verifica")',
          );
          if (submitButton) {
            debug('Clicking OTP submit button...');
            await submitButton.click();
          }

          // Wait for OTP page to be left
          await page.waitForURL(
            url =>
              !url.href.includes('Login') &&
              !url.href.includes('otp') &&
              !url.href.includes('two-step'),
            { timeout: 30000 },
          );
          debug('Successfully passed OTP verification');

          // Now wait for the OIDC redirect to complete (id.cartayou.it -> my.cartayou.it)
          debug('Waiting for OIDC redirect to complete...');
          await page.waitForURL(url => url.href.includes('my.cartayou.it'), {
            timeout: 30000,
          });
          debug('OIDC redirect completed');
        } catch {
          debug('Timeout waiting for OTP verification or OIDC redirect');
          throw new AuthFailedError(
            'OTP verification failed - the SMS code may be invalid or expired, or the redirect timed out',
          );
        }
      }

      // Verify we're logged in (should be on my.cartayou.it now)
      currentUrl = page.url();
      debug('Final URL: %s', currentUrl);

      if (!currentUrl.includes('my.cartayou.it')) {
        throw new AuthFailedError('Login failed - did not reach dashboard');
      }
    } catch (error) {
      if (error instanceof AuthFailedError) {
        throw error;
      }
      debug('Error during login flow: %s', error);
      throw new AuthFailedError(
        `Login flow error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // Navigate to dashboard to trigger API calls for account discovery
    // This also ensures all cookies (including frontCookie) are properly set
    debug('Navigating to dashboard...');
    try {
      await page.goto(CARTAYOU_DASHBOARD_URL, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      // Wait for API responses to be intercepted and cookies to be set
      debug('Waiting for dashboard API responses...');
      await page.waitForTimeout(3000);
      debug('Discovered %d accounts from dashboard', discoveredAccounts.length);

      // If still no accounts, log the current page content for debugging
      if (discoveredAccounts.length === 0) {
        debug(
          'No accounts discovered from API interception. Current URL: %s',
          page.url(),
        );
      }
    } catch (e) {
      debug('Error navigating to dashboard: %s', e);
    }

    // Extract cookies AFTER dashboard navigation (frontCookie is set now)
    const cookies = await extractCookies(context);

    // Log extracted cookies for debugging
    debug(
      'Extracted %d cookies: %o',
      Object.keys(cookies).length,
      Object.keys(cookies),
    );

    // Verify we have the essential frontCookie
    if (!cookies['frontCookie']) {
      debug('WARNING: frontCookie not found! API requests will likely fail.');
      debug(
        'This cookie is set by my.cartayou.it after successful OIDC redirect.',
      );
    } else {
      debug('frontCookie found (length: %d)', cookies['frontCookie'].length);
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
 * Build cookie header string from cookies object
 */
export function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * Clear the cached session
 */
export function clearSession(): void {
  cachedSession = null;
  debug('Session cleared');
}
