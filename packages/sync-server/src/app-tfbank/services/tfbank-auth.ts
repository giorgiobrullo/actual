import { AvardaMyPages, TF_BANK_ITALY } from 'avarda-mypages';
import createDebug from 'debug';

import type { TFBankAccount } from '#app-tfbank/models/tfbank';
import { AuthFailedError } from '#app-tfbank/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';

import * as smsOtpService from './sms-otp-service';

const debug = createDebug('actual:tfbank:auth');

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

/** Extract a usable last-4 from an account identifier or card number. */
function last4(value: unknown): string {
  const str = String(value ?? '');
  const digits = str.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : str.slice(-4);
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Normalize the GetCreditLimits payload into TFBankAccount[].
 *
 * The exact response shape is confirmed on the first real sync (see the
 * TF Bank integration notes / task #20); until then this reads the fields
 * defensively under the common Avarda names and logs the raw payload so the
 * shape can be locked in.
 */
export function normalizeAccounts(raw: unknown): TFBankAccount[] {
  debug('GetCreditLimits raw payload: %O', raw);

  const candidates: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).accounts as unknown[]) ||
        ((raw as Record<string, unknown>).creditLimits as unknown[]) ||
        ((raw as Record<string, unknown>).items as unknown[]) || [raw]
      : [];

  const accounts: TFBankAccount[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;

    const accountId = String(
      rec.accountId ?? rec.accountNumber ?? rec.id ?? rec.customerId ?? '',
    );
    if (!accountId) continue;

    accounts.push({
      account_id: accountId,
      name: String(rec.productName ?? rec.name ?? rec.cardName ?? 'TF Bank'),
      display_number: last4(
        rec.maskedCardNumber ?? rec.cardNumber ?? accountId,
      ),
      balance: num(rec.balance ?? rec.currentBalance ?? rec.usedAmount),
      credit_limit: num(rec.creditLimit ?? rec.limit ?? rec.totalLimit),
      available_credit: num(
        rec.availableCredit ?? rec.available ?? rec.disposable,
      ),
    });
  }

  debug('Normalized %d TF Bank account(s)', accounts.length);
  return accounts;
}

/**
 * Perform the full TF Bank login: password + SMS OTP via the Avarda client,
 * then discover accounts from GetCreditLimits. Caches the authenticated client
 * for reuse by the transactions endpoint within the token's lifetime.
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

  // Discover accounts.
  let accounts: TFBankAccount[] = [];
  try {
    accounts = normalizeAccounts(await client.getCreditLimits());
  } catch (error) {
    debug('Failed discovering accounts from GetCreditLimits: %s', error);
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
