import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Camoufox } from 'camoufox-js';
import createDebug from 'debug';
import type { BrowserContext } from 'playwright-core';

import { config } from '#load-config';

const debug = createDebug('actual:stealth-browser');

/**
 * Persistent profiles live beside the rest of the server's state so they
 * survive container restarts, which is the entire point of keeping them.
 */
function profileRoot(): string {
  return path.join(config.get('dataDir'), 'browser-profiles');
}

/**
 * Profiles claimed by this process. The pid file below cannot express this on
 * its own: concurrent syncs run in the same server process, so they would all
 * see their own pid on the lock and happily share a profile Firefox expects to
 * own exclusively.
 */
const heldProfiles = new Set<string>();

/**
 * Firefox will not tolerate two browsers sharing a profile, so a profile is
 * claimed for the duration of a launch. The lock records a pid; a lock whose
 * process is gone is stale (the container was killed mid-scrape) and is taken
 * over rather than blocking every future run.
 */
function claimProfile(dir: string): boolean {
  if (heldProfiles.has(dir)) return false;

  const lockPath = path.join(dir, '.actual-lock');
  try {
    const owner = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (owner && owner !== process.pid) {
      try {
        // Signal 0 tests for existence without actually signalling.
        process.kill(owner, 0);
        return false;
      } catch {
        debug('taking over profile lock from dead pid %d', owner);
      }
    }
  } catch {
    // No lock file: free to claim.
  }

  fs.writeFileSync(lockPath, String(process.pid));
  heldProfiles.add(dir);
  return true;
}

function releaseProfile(dir: string): void {
  heldProfiles.delete(dir);
  try {
    fs.rmSync(path.join(dir, '.actual-lock'), { force: true });
  } catch {
    // Best effort: a stale lock is recovered from on the next launch.
  }
}

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
 * Pass `profile` to keep the browser profile between runs. A bank that offers
 * "remember this device" issues a cookie on successful login, and reCAPTCHA
 * scores prior interaction heavily, so a returning profile is challenged far
 * less than a first-time visitor. Without it every run looks brand new and is
 * challenged accordingly. Profiles are per bank so one bank's state can be
 * discarded without touching another's.
 *
 * The caller owns the returned context and must call `closeStealthContext`
 * when done, which releases a persistent profile or deletes a throwaway one.
 */
export async function launchStealthContext(options?: {
  locale?: string;
  timezone?: string;
  proxyServer?: string;
  profile?: string;
}): Promise<BrowserContext> {
  const persistent = Boolean(options?.profile);

  let userDataDir: string;
  if (options?.profile) {
    userDataDir = path.join(profileRoot(), options.profile);
    fs.mkdirSync(userDataDir, { recursive: true });

    if (!claimProfile(userDataDir)) {
      throw new Error(
        `Browser profile "${options.profile}" is in use by another run`,
      );
    }
    debug('using persistent profile %s', userDataDir);
  } else {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-profile-'));
  }

  const launch = () =>
    Camoufox({
      user_data_dir: userDataDir,
      headless: 'virtual',
      humanize: true,
      os: 'windows',
      locale: options?.locale ?? 'it-IT',
      timezone: options?.timezone ?? 'Europe/Rome',
      proxy: options?.proxyServer,
    });

  let context: BrowserContext;
  try {
    context = await launch();
  } catch (error) {
    if (!persistent) throw error;

    // A profile that cannot be opened is worse than no profile: it would fail
    // every run from here on. Losing it costs one re-challenged login.
    debug(
      'persistent profile failed to open (%s), recreating it',
      error instanceof Error ? error.message : error,
    );
    // Wiping the directory takes the lock file with it, so the claim is
    // released and retaken to keep the in-process and on-disk state agreeing.
    releaseProfile(userDataDir);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    claimProfile(userDataDir);
    context = await launch();
  }

  // Stashed on the context so closeStealthContext can clean up without the
  // caller having to track it separately.
  const tracked = context as BrowserContext & {
    _userDataDir?: string;
    _persistentProfile?: boolean;
  };
  tracked._userDataDir = userDataDir;
  tracked._persistentProfile = persistent;

  return context;
}

export async function closeStealthContext(
  context: BrowserContext,
): Promise<void> {
  const tracked = context as BrowserContext & {
    _userDataDir?: string;
    _persistentProfile?: boolean;
  };
  const userDataDir = tracked._userDataDir;

  try {
    await context.close();
  } finally {
    if (userDataDir) {
      try {
        if (tracked._persistentProfile) {
          // Kept on purpose: the cookies in here are what stop the next run
          // being treated as a new device.
          releaseProfile(userDataDir);
        } else {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup; a leftover temp profile is harmless.
      }
    }
  }
}
