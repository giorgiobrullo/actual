import { AvardaMyPages, TF_BANK_ITALY } from 'avarda-mypages';
import createDebug from 'debug';

import type { TFBankAccount } from '#app-tfbank/models/tfbank';
import { AuthFailedError } from '#app-tfbank/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';

import * as smsOtpService from './sms-otp-service';

const debug = createDebug('actual:tfbank:auth');

const CARD_BASE = 'https://cardmanagement.production.avarda.com';
const MY_BASE = 'https://mypages-api.production.avarda.com';

// A live session wraps the authenticated Avarda client plus the accounts we
// discovered during login. The access token is short-lived (~5 min), so the
// session TTL is derived from the token's own expiry.
type TFBankSession = {
  client: AvardaMyPages;
  accounts: TFBankAccount[];
  createdAt: number;
  expiresAt: number;
};

let cachedSession: TFBankSession | null = null;

// Fallback TTL if the token carries no decodable expiry. Kept short because
// Avarda tokens are ~5 minutes.
const FALLBACK_TTL_MS = 4 * 60 * 1000;
// Refresh/re-login this far before the token actually expires.
const EXPIRY_SKEW_MS = 20 * 1000;

export function hasValidSession(): boolean {
  if (!cachedSession) return false;
  return Date.now() + EXPIRY_SKEW_MS < cachedSession.expiresAt;
}

export function getCachedSession(): TFBankSession | null {
  if (hasValidSession()) return cachedSession;
  cachedSession = null;
  return null;
}

export function getCachedAccounts(): TFBankAccount[] {
  return getCachedSession()?.accounts ?? cachedSession?.accounts ?? [];
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Recursively find the first string/number value for `key` in a payload. */
function deepFind(value: unknown, key: string, depth = 0): string | undefined {
  if (depth > 6 || value == null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFind(item, key, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  const direct = rec[key];
  if (typeof direct === 'string' || typeof direct === 'number') {
    return String(direct);
  }
  for (const v of Object.values(rec)) {
    const found = deepFind(v, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text() };
}

/**
 * Build the TF Bank account. `cornicheAccountId` (a GUID from
 * /api/card/details) is the account id used by /api/v3/transactions/{id}; it is
 * stored as `account_id` so bank-sync passes it straight through. Balance,
 * limit and available credit come from GetCreditLimits.
 */
export function buildAccount(
  cornicheAccountId: string,
  limits: unknown,
  cardDetails: unknown,
): TFBankAccount {
  const lim = (limits && typeof limits === 'object' ? limits : {}) as Record<
    string,
    unknown
  >;
  const maskedPan = deepFind(cardDetails, 'maskedCardNumber') ?? '';
  const last4 = maskedPan.replace(/\D/g, '').slice(-4) || '0000';
  return {
    account_id: cornicheAccountId,
    name: 'TF Bank',
    display_number: last4,
    balance: num(lim.usedBalance ?? lim.openingBalance),
    credit_limit: num(lim.loanLimit),
    available_credit: num(lim.availableBalance),
  };
}

/**
 * Perform the full TF Bank login and discover the account.
 *
 * Contract (from the card-management module bundle):
 *   GET /api/card/details            -> { cornicheAccountId, cornicheCardPan, ... }
 *   GET /api/v3/transactions/{cornicheAccountId}?transactionDateFrom&transactionDateTo&locale
 *   GET /api/v3/CreditCard/overview/{cornicheCardPan}?numberOfTransactions=N
 * card/details 404s on the card-management host, so it's fetched from the
 * mypages host (where /api/client/details lives), with the card host as a
 * fallback. Logs the card/details payload + a transactions sample so the shapes
 * can be finalized, then folded into the avarda-mypages client.
 */
export async function performLogin(): Promise<TFBankSession> {
  const email = secretsService.get(SecretName.tfbank_username);
  const password = secretsService.get(SecretName.tfbank_password);

  if (!email || !password) {
    throw new AuthFailedError('TF Bank credentials not configured');
  }

  debug('Starting TF Bank login flow...');

  const client = new AvardaMyPages(TF_BANK_ITALY);

  // Clear any stale OTP so we only accept a code that arrives after `validate`
  // triggers a fresh SMS.
  smsOtpService.clearOTP();

  try {
    await client.login({
      email,
      password,
      getOtp: async () => {
        debug('Waiting for SMS OTP via webhook...');
        const code = await smsOtpService.waitForOTP(120000, 1000);
        if (!code) {
          throw new AuthFailedError(
            'OTP verification timeout - SMS code was not received. Make sure your iPhone is on and the automation is configured.',
          );
        }
        debug('Received OTP code');
        return code;
      },
    });
  } catch (error) {
    if (error instanceof AuthFailedError) throw error;
    debug('Login failed: %s', error);
    throw new AuthFailedError(
      `Login failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  } finally {
    smsOtpService.clearOTP();
  }

  let accounts: TFBankAccount[] = [];
  try {
    const token = client.getSession()?.accessToken ?? '';
    const H: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://areacliente.tfbank.it',
      Referer: 'https://areacliente.tfbank.it/',
    };

    // card/details -> corniche GUIDs (try mypages host first, then card host).
    let cardDetails: unknown = null;
    for (const base of [MY_BASE, CARD_BASE]) {
      try {
        const { status, body } = await rawGet(`${base}/api/card/details`, H);
        debug('card/details [%s] %d -> %s', base, status, body.slice(0, 900));
        if (status >= 200 && status < 300 && body) {
          cardDetails = JSON.parse(body);
          break;
        }
      } catch (e) {
        debug(
          'card/details [%s] err %s',
          base,
          e instanceof Error ? e.message : e,
        );
      }
    }

    const cornicheAccountId = deepFind(cardDetails, 'cornicheAccountId');
    const cornicheCardPan = deepFind(cardDetails, 'cornicheCardPan');
    debug(
      'cornicheAccountId=%s cornicheCardPan=%s',
      cornicheAccountId,
      cornicheCardPan,
    );

    const limits = await client.getCreditLimits();
    debug('GetCreditLimits raw payload: %s', JSON.stringify(limits));

    // Sample transactions to lock in the shape (2-year window).
    if (cornicheAccountId) {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 730 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      try {
        const { status, body } = await rawGet(
          `${CARD_BASE}/api/v3/transactions/${cornicheAccountId}?transactionDateFrom=${from}&transactionDateTo=${to}&locale=it-IT`,
          H,
        );
        debug('SAMPLE transactions %d -> %s', status, body.slice(0, 1800));
      } catch (e) {
        debug('SAMPLE transactions err %s', e instanceof Error ? e.message : e);
      }
    }

    const accountId = cornicheAccountId ?? email;
    accounts = [buildAccount(accountId, limits, cardDetails)];
    debug(
      'Built account id=%s (%s)',
      accountId,
      cornicheAccountId
        ? 'RESOLVED from card/details'
        : 'FALLBACK — card/details did not yield a GUID',
    );
  } catch (error) {
    debug('Failed discovering account: %s', error);
  }

  const now = Date.now();
  const tokenExpiry = client.getSession()?.expiresAt ?? null;
  cachedSession = {
    client,
    accounts,
    createdAt: now,
    expiresAt: tokenExpiry ?? now + FALLBACK_TTL_MS,
  };

  debug(
    'Session created with %d account(s), expires at %s',
    accounts.length,
    new Date(cachedSession.expiresAt).toISOString(),
  );

  return cachedSession;
}

/**
 * Return an authenticated Avarda client, refreshing the token if it is close
 * to expiry, or performing a fresh login (new SMS) if there is no live session.
 */
export async function getAuthenticatedClient(): Promise<AvardaMyPages> {
  if (hasValidSession() && cachedSession) {
    return cachedSession.client;
  }

  // Try a token refresh on the stale session before falling back to a full
  // re-login (which would trigger another SMS).
  if (cachedSession) {
    try {
      await cachedSession.client.refreshToken();
      const expiresAt =
        cachedSession.client.getSession()?.expiresAt ??
        Date.now() + FALLBACK_TTL_MS;
      cachedSession = { ...cachedSession, expiresAt };
      debug('Refreshed TF Bank token');
      return cachedSession.client;
    } catch (error) {
      debug('Token refresh failed, re-logging in: %s', error);
    }
  }

  const session = await performLogin();
  return session.client;
}

export function clearSession(): void {
  cachedSession = null;
  debug('Session cleared');
}
