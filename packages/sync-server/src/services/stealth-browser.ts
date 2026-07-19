import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Camoufox } from 'camoufox-js';
import type { BrowserContext } from 'playwright-core';

/**
 * Launches a Camoufox (Firefox-based anti-detect browser) context configured
 * for maximum stealth against aggressive bot detection (e.g. Amex Italy's
 * invisible reCAPTCHA).
 *
 * Why Camoufox over a patched Chromium (patchright): Camoufox spoofs its
 * fingerprint at the browser-engine (C++) level rather than via JS runtime
 * patches, and ships built-in cursor humanization — both of which matter for
 * targets that score behaviour and low-level signals, not just the obvious
 * `navigator.webdriver` tells.
 *
 *  - `user_data_dir`: makes Camoufox return a persistent BrowserContext (the
 *    shape the scrapers expect: cookies(), newPage(), pages(), close()).
 *  - `headless: 'virtual'`: runs a real headful browser inside a Camoufox-
 *    managed Xvfb display, so the server needs no manual xvfb-run wrapper.
 *  - `humanize: true`: human-like mouse movement between actions.
 *  - `os: 'windows'`: presents the most common desktop OS fingerprint.
 *  - `locale` / `timezone`: default to Italian, matching the banks and the
 *    server's Italian residential IP so geo/locale signals stay consistent.
 *
 * The caller owns the returned context and must call `closeStealthContext`
 * (which also removes the throwaway user-data dir) when done.
 */
export async function launchStealthContext(options?: {
  locale?: string;
  timezone?: string;
  proxyServer?: string;
}): Promise<BrowserContext> {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'stealth-profile-'),
  );

  const context = await Camoufox({
    user_data_dir: userDataDir,
    headless: 'virtual',
    humanize: true,
    os: 'windows',
    locale: options?.locale ?? 'it-IT',
    timezone: options?.timezone ?? 'Europe/Rome',
    proxy: options?.proxyServer,
  });

  // Stash the temp dir on the context so closeStealthContext can clean it up
  // without the caller having to track it separately.
  (context as BrowserContext & { _userDataDir?: string })._userDataDir =
    userDataDir;

  return context;
}

export async function closeStealthContext(
  context: BrowserContext,
): Promise<void> {
  const userDataDir = (context as BrowserContext & { _userDataDir?: string })
    ._userDataDir;

  try {
    await context.close();
  } finally {
    if (userDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; a leftover temp profile is harmless.
      }
    }
  }
}
