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

  // First, let's see what iframes exist on the page for debugging
  const iframeInfo = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    return iframes.map(f => ({
      src: f.src?.substring(0, 100),
      title: f.title,
      id: f.id,
    }));
  });
  if (iframeInfo.length > 0) {
    debug('Found %d iframes: %o', iframeInfo.length, iframeInfo);
  }

  // Check for reCAPTCHA v2/invisible iframe
  const recaptchaFrame = await page.$(
    'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], iframe[src*="hcaptcha"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]',
  );

  if (recaptchaFrame) {
    debug('Found CAPTCHA iframe');

    // Try to extract sitekey from various places
    const sitekey = await page.evaluate(() => {
      // Check for data-sitekey attribute
      const recaptchaDiv = document.querySelector('.g-recaptcha[data-sitekey]');
      if (recaptchaDiv) {
        return recaptchaDiv.getAttribute('data-sitekey');
      }

      // Check in grecaptcha render parameters
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const match = script.textContent?.match(
          /grecaptcha\.render\([^,]+,\s*\{[^}]*sitekey:\s*['"]([^'"]+)['"]/,
        );
        if (match) return match[1];
      }

      // Check iframe src for sitekey
      const iframe = document.querySelector(
        'iframe[src*="recaptcha"]',
      ) as HTMLIFrameElement;
      if (iframe?.src) {
        const url = new URL(iframe.src);
        return url.searchParams.get('k');
      }

      return null;
    });

    if (sitekey) {
      // Determine type
      const isInvisible = await page.$('.g-recaptcha[data-size="invisible"]');
      return {
        sitekey,
        type: isInvisible ? 'invisible' : 'v2',
      };
    }
  }

  // Check for reCAPTCHA v3 (usually in scripts)
  const v3Sitekey = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      // Look for grecaptcha.execute calls with sitekey
      const match = script.textContent?.match(
        /grecaptcha\.execute\(['"]([^'"]+)['"]/,
      );
      if (match) return match[1];
    }
    return null;
  });

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
    debug('Failed to inject CAPTCHA token: %o', error);
    return false;
  }
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
