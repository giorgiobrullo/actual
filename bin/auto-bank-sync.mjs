#!/usr/bin/env node
/**
 * Unattended bank sync for a self-hosted server.
 *
 * Actual is local-first: the budget database lives on the client and the sync
 * server only stores relayed messages, so the server cannot run a bank sync on
 * its own. The way around that is to be a client -- @actual-app/api boots the
 * whole loot-core engine headlessly, downloads the budget, syncs, and pushes
 * the resulting messages back.
 *
 * This deliberately runs from a build of *this* repo rather than the published
 * @actual-app/api. Bank providers are dispatched client-side by loot-core, so
 * a stock upstream build would reject the custom ones (amex, cartayou, tfbank)
 * as unrecognized. Building both from the same commit also means the client and
 * the sync server can never drift apart.
 *
 * Runs once and exits -- scheduling belongs to systemd, not to a process that
 * has to stay alive and healthy for months.
 *
 * Exit codes: 0 success, 1 at least one account failed to sync, 2 misconfigured.
 */
import * as api from '@actual-app/api';

const {
  ACTUAL_SERVER_URL: serverURL,
  ACTUAL_SESSION_TOKEN: sessionToken,
  ACTUAL_SYNC_ID: syncId,
  ACTUAL_DATA_DIR: dataDir = '/data',
} = process.env;

const log = message => console.log(`[auto-bank-sync] ${message}`);

const missing = Object.entries({
  ACTUAL_SERVER_URL: serverURL,
  ACTUAL_SESSION_TOKEN: sessionToken,
  ACTUAL_SYNC_ID: syncId,
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    `[auto-bank-sync] missing required environment: ${missing.join(', ')}`,
  );
  process.exit(2);
}

let exitCode = 0;

await api.init({ serverURL, sessionToken, dataDir });
log(`authenticated against ${serverURL}`);

try {
  await api.downloadBudget(syncId);
  log(`budget ${syncId} downloaded`);

  try {
    await api.runBankSync();
    log('all linked accounts synced');
  } catch (err) {
    // `accounts-bank-sync` walks every linked account and collects failures as
    // it goes; only the outer `api/bank-sync` handler rethrows, and just the
    // first error. So this branch means "something failed", not "we stopped
    // there" -- the remaining accounts have already been attempted. Which
    // account failed and why is in the sync server's own log.
    exitCode = 1;
    log(`at least one account failed: ${err.message}`);
  }

  // Bank sync only writes to the local database; without this the imported
  // transactions never leave this container.
  await api.sync();
  log('changes pushed to the server');
} finally {
  await api.shutdown();
}

process.exit(exitCode);
