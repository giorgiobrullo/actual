/// <reference lib="dom" />
import createDebug from 'debug';
import type { Page } from 'playwright-core';

import { SecretName, secretsService } from './secrets-service';

const debug = createDebug('actual:captcha');

// 2Captcha API v2 endpoints
const TWOCAPTCHA_API = 'https://api.2captcha.com';

// 2Captcha API v2 response types
type TwoCaptchaCreateTaskResponse = {
  errorId: number; // 0 = no error
  errorCode?: string;
  errorDescription?: string;
  taskId?: number;
};

type TwoCaptchaGetResultResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: 'processing' | 'ready';
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
};

/**
 * Check if 2Captcha is configured
 */
export function isCaptchaServiceConfigured(): boolean {
  const apiKey = secretsService.get(SecretName.captcha_2captcha_apikey);
  return Boolean(apiKey);
}

/**
 * Configure 2Captcha API key
 */
export function configureCaptchaService(apiKey: string): void {
  secretsService.set(SecretName.captcha_2captcha_apikey, apiKey);
  debug('2Captcha API key configured');
}

/**
 * Test 2Captcha API key by checking balance
 */
export async function testCaptchaApiKey(
  apiKey: string,
): Promise<{ success: boolean; balance?: number; error?: string }> {
  debug('Testing 2Captcha API key...');

  try {
    const response = await fetch(`${TWOCAPTCHA_API}/getBalance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey }),
    });

    const result = (await response.json()) as {
      errorId: number;
      errorCode?: string;
      errorDescription?: string;
      balance?: number;
    };

    if (result.errorId !== 0) {
      debug('2Captcha API key test failed: %s', result.errorDescription);
      return {
        success: false,
        error: result.errorDescription || result.errorCode || 'Invalid API key',
      };
    }

    debug('2Captcha API key valid, balance: %s', result.balance);
    return { success: true, balance: result.balance };
  } catch (error) {
    debug('2Captcha API key test error: %o', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Detect if there's a reCAPTCHA or other CAPTCHA on the page
 * Returns the sitekey if found, null otherwise
 */
export async function detectRecaptcha(
  page: Page,
): Promise<{ sitekey: string; type: 'v2' | 'v3' | 'invisible' } | null> {
  debug('Checking for CAPTCHA on page: %s', page.url());

  // Some sites (e.g. Amex) monkeypatch the global `eval`, which makes
  // Playwright-Firefox's page.evaluate throw "eval is disabled". CAPTCHA
  // detection is best-effort, so every page.evaluate below degrades to its
  // empty default on failure and the function returns null ("no CAPTCHA").

  // First, let's see what iframes exist on the page for debugging
  const iframeInfo = await page
    .evaluate(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      return iframes.map(f => ({
        src: f.src?.substring(0, 100),
        title: f.title,
        id: f.id,
      }));
    })
    .catch(() => [] as Array<{ src?: string; title: string; id: string }>);
  if (iframeInfo.length > 0) {
    debug('Found %d iframes: %o', iframeInfo.length, iframeInfo);
  }

  // Check for reCAPTCHA v2/invisible iframe
  const recaptchaFrame = await page.$(
    'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], iframe[src*="hcaptcha"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]',
  );

  if (recaptchaFrame) {
    debug('Found CAPTCHA iframe');

    // Extract the sitekey WITHOUT page.evaluate. Sites like Amex monkeypatch
    // the global eval, which breaks page.evaluate ("eval is disabled"); reading
    // attributes via ElementHandle.getAttribute goes through the Playwright
    // protocol and is unaffected.
    let sitekey: string | null = null;

    // Preferred: the data-sitekey attribute on the .g-recaptcha container.
    const recaptchaDiv = await page.$('.g-recaptcha[data-sitekey]');
    if (recaptchaDiv) {
      sitekey = await recaptchaDiv.getAttribute('data-sitekey');
    }

    // Fallback: the reCAPTCHA anchor iframe carries the sitekey as the `k`
    // query parameter in its src (e.g. .../api2/anchor?ar=1&k=<sitekey>&...).
    if (!sitekey) {
      const frameSrc = await recaptchaFrame.getAttribute('src');
      if (frameSrc) {
        try {
          sitekey = new URL(frameSrc).searchParams.get('k');
        } catch {
          // Malformed src; leave sitekey null.
        }
      }
    }

    if (sitekey) {
      // Determine type (invisible vs checkbox) via a protocol DOM query.
      const isInvisible = await page.$('.g-recaptcha[data-size="invisible"]');
      return {
        sitekey,
        type: isInvisible ? 'invisible' : 'v2',
      };
    }
  }

  // Check for reCAPTCHA v3 (usually in scripts)
  const v3Sitekey = await page
    .evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        // Look for grecaptcha.execute calls with sitekey
        const match = script.textContent?.match(
          /grecaptcha\.execute\(['"]([^'"]+)['"]/,
        );
        if (match) return match[1];
      }
      return null;
    })
    .catch(() => null);

  if (v3Sitekey) {
    debug('Found reCAPTCHA v3');
    return { sitekey: v3Sitekey, type: 'v3' };
  }

  debug('No reCAPTCHA detected');
  return null;
}

/**
 * Solve a reCAPTCHA using 2Captcha API v2
 */
export async function solveRecaptcha(
  pageUrl: string,
  sitekey: string,
  type: 'v2' | 'v3' | 'invisible' = 'v2',
): Promise<string | null> {
  const apiKey = secretsService.get(SecretName.captcha_2captcha_apikey);
  if (!apiKey) {
    debug('2Captcha API key not configured');
    return null;
  }

  debug('Submitting reCAPTCHA to 2Captcha (type: %s)...', type);

  try {
    // Build task object based on captcha type
    type TaskType = {
      type: string;
      websiteURL: string;
      websiteKey: string;
      isInvisible?: boolean;
      minScore?: number;
      pageAction?: string;
    };

    const task: TaskType = {
      type:
        type === 'v3' ? 'RecaptchaV3TaskProxyless' : 'RecaptchaV2TaskProxyless',
      websiteURL: pageUrl,
      websiteKey: sitekey,
    };

    if (type === 'invisible') {
      task.isInvisible = true;
    } else if (type === 'v3') {
      task.minScore = 0.3;
      task.pageAction = 'verify';
    }

    // Submit the captcha using API v2
    const submitResponse = await fetch(`${TWOCAPTCHA_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task,
      }),
    });
    const submitResult =
      (await submitResponse.json()) as TwoCaptchaCreateTaskResponse;

    if (submitResult.errorId !== 0 || !submitResult.taskId) {
      debug(
        '2Captcha submit error: %s - %s',
        submitResult.errorCode,
        submitResult.errorDescription,
      );
      return null;
    }

    const taskId = submitResult.taskId;
    debug('2Captcha task ID: %s', taskId);

    // Poll for result (typically takes 20-60 seconds)
    const maxAttempts = 30; // 2.5 minutes max
    const pollInterval = 5000; // 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const resultResponse = await fetch(`${TWOCAPTCHA_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: apiKey,
          taskId,
        }),
      });
      const result =
        (await resultResponse.json()) as TwoCaptchaGetResultResponse;

      if (result.errorId !== 0) {
        debug(
          '2Captcha error: %s - %s',
          result.errorCode,
          result.errorDescription,
        );
        return null;
      }

      if (result.status === 'ready' && result.solution) {
        debug('2Captcha solved successfully');
        return (
          result.solution.gRecaptchaResponse || result.solution.token || null
        );
      }

      debug(
        '2Captcha still solving... (attempt %d/%d)',
        attempt + 1,
        maxAttempts,
      );
    }

    debug('2Captcha timeout - took too long to solve');
    return null;
  } catch (error) {
    debug('2Captcha error: %o', error);
    return null;
  }
}

/**
 * Inject the solved CAPTCHA token into the page
 */
export async function injectCaptchaToken(
  page: Page,
  token: string,
): Promise<boolean> {
  debug('Injecting CAPTCHA token into page...');

  try {
    await page.evaluate((captchaToken: string) => {
      // Set the g-recaptcha-response textarea
      const textarea = document.querySelector(
        '#g-recaptcha-response, textarea[name="g-recaptcha-response"]',
      ) as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = captchaToken;
        textarea.style.display = 'block'; // Make visible temporarily
      }

      // Also try to set it in any hidden inputs
      const hiddenInputs = document.querySelectorAll(
        'input[name="g-recaptcha-response"]',
      ) as NodeListOf<HTMLInputElement>;
      hiddenInputs.forEach(input => {
        input.value = captchaToken;
      });

      // Call the callback if it exists (for invisible reCAPTCHA)
      const win = window as unknown as {
        grecaptcha?: unknown;
        ___grecaptcha_cfg?: {
          clients?: Array<{
            L?: { L?: { callback?: (token: string) => void } };
          }>;
        };
      };
      if (typeof win.grecaptcha !== 'undefined') {
        try {
          // Try to find and call the callback
          const callback = win.___grecaptcha_cfg?.clients?.[0]?.L?.L?.callback;
          if (typeof callback === 'function') {
            callback(captchaToken);
          }
        } catch {
          // Callback not found, that's ok
        }
      }
    }, token);

    debug('CAPTCHA token injected');
    return true;
  } catch (error) {
    debug('Could not inject via page script: %o', error);
    return injectTokenWithoutEval(page, token);
  }
}

/**
 * Write the token straight into the response field, without running any page
 * script.
 *
 * Sites that fingerprint automation monkeypatch `eval`, which is what
 * `page.evaluate` relies on -- Amex does exactly this, so the code path above
 * always throws there. Playwright's own actions run through a separate channel
 * that the page cannot patch, so filling the field still works.
 *
 * This covers checkbox reCAPTCHA, where the form reads the token out of the
 * response field on submit. Invisible variants additionally expect their
 * completion callback to fire, which genuinely does need page script, so a
 * failure there is reported rather than hidden.
 */
async function injectTokenWithoutEval(
  page: Page,
  token: string,
): Promise<boolean> {
  const selectors = [
    '#g-recaptcha-response',
    'textarea[name="g-recaptcha-response"]',
    'input[name="g-recaptcha-response"]',
  ];

  for (const selector of selectors) {
    const field = page.locator(selector).first();
    try {
      if ((await field.count()) === 0) continue;
      // The response field is hidden by design, so it has to be filled without
      // the usual visibility and enabled checks.
      await field.fill(token, { force: true, timeout: 5000 });
      debug('CAPTCHA token injected via %s (no page script)', selector);
      return true;
    } catch (error) {
      debug(
        'Could not fill %s: %s',
        selector,
        error instanceof Error ? error.message : error,
      );
    }
  }

  debug('Failed to inject CAPTCHA token: no writable response field found');
  return false;
}

/**
 * Full flow: detect, solve, and inject CAPTCHA
 */
export async function handleCaptchaIfPresent(page: Page): Promise<boolean> {
  const captcha = await detectRecaptcha(page);

  if (!captcha) {
    return true; // No captcha, proceed normally
  }

  debug(
    'CAPTCHA detected (type: %s, sitekey: %s)',
    captcha.type,
    captcha.sitekey,
  );

  if (!isCaptchaServiceConfigured()) {
    debug('CAPTCHA detected but 2Captcha not configured');
    return false;
  }

  const token = await solveRecaptcha(page.url(), captcha.sitekey, captcha.type);

  if (!token) {
    debug('Failed to solve CAPTCHA');
    return false;
  }

  const injected = await injectCaptchaToken(page, token);

  if (!injected) {
    debug('Failed to inject CAPTCHA token');
    return false;
  }

  debug('CAPTCHA handled successfully');
  return true;
}
