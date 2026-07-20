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
 * Build the single TF Bank account from the GetCreditLimits summary.
 *
 * TF Bank exposes one card per login and GetCreditLimits carries no account id
 * (confirmed live: { loanLimit, usedBalance, availableBalance, reservedAmount,
 * openingBalance, repaymentDetails, currencyCode }), so the id is supplied by
 * the caller — derived from the JWT / a working transactions probe.
 */
export function buildAccountFromLimits(
  raw: unknown,
  accountId: string,
): TFBankAccount {
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    account_id: accountId,
    name: 'TF Bank',
    display_number: last4(accountId),
    balance: num(rec.usedBalance ?? rec.openingBalance ?? rec.balance),
    credit_limit: num(rec.loanLimit ?? rec.creditLimit ?? rec.limit),
    available_credit: num(rec.availableBalance ?? rec.availableCredit),
  };
}

/**
 * Perform the full TF Bank login: password + SMS OTP via the Avarda client,
 * then discover the account. Because GetCreditLimits has no account id, this
 * probes the JWT claims / client details / candidate ids against the
 * transactions endpoint to find the identifier it wants, logging raw shapes so
 * the transaction/invoice normalization can be finalized. Caches the
 * authenticated client for reuse within the token's lifetime.
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

  // Discover the account and capture the transactions identifier + raw shapes.
  let accounts: TFBankAccount[] = [];
  try {
    const claims = client.getSession()?.claims ?? {};
    debug('JWT claims: %s', JSON.stringify(claims));

    let clientDetails: Record<string, unknown> = {};
    try {
      clientDetails = ((await client.getClientDetails()) ?? {}) as Record<
        string,
        unknown
      >;
      debug('client details: %s', JSON.stringify(clientDetails));
    } catch (e) {
      debug('getClientDetails failed: %s', e instanceof Error ? e.message : e);
    }

    const limits = await client.getCreditLimits();
    debug('GetCreditLimits raw payload: %s', JSON.stringify(limits));

    // Candidate identifiers for /api/v3/transactions/{accountId}.
    const candidateIds = [
      clientDetails.accountNumber,
      clientDetails.accountId,
      clientDetails.customerId,
      claims.accountNumber,
      claims.accountId,
      claims.branchid,
      claims.customerId,
      claims.sub,
      claims.ssn,
    ]
      .filter(v => v != null && v !== '')
      .map(String);

    let workingId: string | null = null;
    for (const cand of candidateIds) {
      try {
        const txns = await client.getTransactions(cand);
        debug(
          'transactions OK with id=%s: %s',
          cand,
          JSON.stringify(txns).slice(0, 3000),
        );
        workingId = cand;
        break;
      } catch (e) {
        debug(
          'transactions FAILED id=%s: %s',
          cand,
          e instanceof Error ? e.message : e,
        );
      }
    }

    try {
      const invoices = await client.getInvoices();
      debug(
        'invoices raw payload: %s',
        JSON.stringify(invoices).slice(0, 3000),
      );
    } catch (e) {
      debug('getInvoices failed: %s', e instanceof Error ? e.message : e);
    }

    const accountId =
      workingId ??
      String(claims.sub ?? clientDetails.accountNumber ?? 'tfbank');
    accounts = [buildAccountFromLimits(limits, accountId)];
    debug(
      'Using accountId=%s (transactions probe %s)',
      accountId,
      workingId ? 'succeeded' : 'fell back — check logs for the real id',
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
