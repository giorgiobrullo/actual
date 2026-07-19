import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'patchright';
import type { BrowserContext } from 'patchright';

/**
 * Launches a patchright browser context configured for maximum stealth,
 * following patchright's own recommendations for staying undetected:
 *
 *  - `launchPersistentContext` (NOT `launch` + `newContext`): patchright only
 *    patches persistent contexts. A context from `browser.newContext()` is
 *    left unpatched and is trivially detectable.
 *  - `headless: false`: the headless shell advertises `HeadlessChrome` and is
 *    missing features real Chrome has. The server runs this under Xvfb so a
 *    headful browser works without a physical display.
 *  - `channel: 'chrome'`: real Google Chrome is less fingerprintable than the
 *    bundled open-source Chromium.
 *  - no fixed viewport (`viewport: null`): a hardcoded viewport is an
 *    automation tell; use the real window size instead.
 *
 * The caller owns the returned context and must call `closeStealthContext`
 * (which also removes the throwaway user-data dir) when done.
 */
export async function launchStealthContext(options?: {
  locale?: string;
  proxyServer?: string;
}): Promise<BrowserContext> {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'stealth-profile-'),
  );

  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] =
    {
      headless: false,
      channel: 'chrome',
      viewport: null,
      locale: options?.locale,
    };

  if (options?.proxyServer) {
    launchOptions.proxy = { server: options.proxyServer };
  }

  const context = await chromium.launchPersistentContext(
    userDataDir,
    launchOptions,
  );

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
