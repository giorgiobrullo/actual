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
 * the caller — derived from a working transactions probe / the JWT.
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

/** Recursively collect id-like string/number values from a parsed payload. */
function collectIds(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (
        /(^id$|Id$|number$|Number$|guid|reference)/i.test(key) &&
        (typeof v === 'string' || typeof v === 'number') &&
        String(v).length > 0
      ) {
        out.add(String(v));
      }
      collectIds(v, out, depth + 1);
    }
  }
}

async function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text() };
}

/**
 * Perform the full TF Bank login and hunt for the transactions endpoint.
 *
 * GetCreditLimits has no account id and /api/v3/transactions/{branchid|email|
 * ssn} all return 400, so this probes the card/overview/accounts endpoints,
 * harvests any id-like fields from their responses, and retries the
 * transactions endpoint with each — all within the login's token lifetime.
 * Everything is logged (incl. the access token as a manual-exploration backup)
 * so the endpoint + shapes can be finalized. Caches the authenticated client.
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
    const session = client.getSession();
    const claims = session?.claims ?? {};
    const token = session?.accessToken ?? '';
    debug('JWT claims: %s', JSON.stringify(claims));
    debug('ACCESS_TOKEN %s', token);

    const H: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://areacliente.tfbank.it',
      Referer: 'https://areacliente.tfbank.it/',
    };

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

    let invoiceId: string | undefined;
    try {
      const invoices = await client.getInvoices();
      debug(
        'invoices raw payload: %s',
        JSON.stringify(invoices).slice(0, 2000),
      );
      const first = (invoices as { invoices?: Array<{ invoiceId?: unknown }> })
        ?.invoices?.[0]?.invoiceId;
      if (first != null) invoiceId = String(first);
    } catch (e) {
      debug('getInvoices failed: %s', e instanceof Error ? e.message : e);
    }

    // Step 1: probe list/overview endpoints and harvest id-like values.
    const branch = String(claims.branchid ?? '');
    const foundIds = new Set<string>();
    if (branch) foundIds.add(branch);
    const probeUrls = [
      `${CARD_BASE}/api/v3/CreditCard/overview`,
      `${CARD_BASE}/api/v3/CreditCard/overview/${branch}`,
      `${CARD_BASE}/api/v1/CreditCard`,
      `${CARD_BASE}/api/v1/cards`,
      `${CARD_BASE}/api/v3/cards`,
      `${CARD_BASE}/api/v1/accounts`,
      `${CARD_BASE}/api/v3/transactions`,
      invoiceId ? `${CARD_BASE}/api/v1/invoices/${invoiceId}` : '',
      `${MY_BASE}/api/accounts`,
      `${MY_BASE}/api/cards`,
    ].filter(Boolean);

    for (const url of probeUrls) {
      try {
        const { status, body } = await rawGet(url, H);
        debug('PROBE %d %s -> %s', status, url, body.slice(0, 500));
        if (status >= 200 && status < 300) {
          try {
            collectIds(JSON.parse(body), foundIds);
          } catch {
            /* non-JSON body */
          }
        }
      } catch (e) {
        debug('PROBE ERR %s -> %s', url, e instanceof Error ? e.message : e);
      }
    }

    // Step 2: try the transactions endpoint with every harvested id.
    let workingId: string | null = null;
    for (const id of foundIds) {
      try {
        const { status, body } = await rawGet(
          `${CARD_BASE}/api/v3/transactions/${encodeURIComponent(id)}`,
          H,
        );
        debug('TXN-TRY %d id=%s -> %s', status, id, body.slice(0, 600));
        if (status >= 200 && status < 300) {
          workingId = id;
          break;
        }
      } catch (e) {
        debug(
          'TXN-TRY ERR id=%s -> %s',
          id,
          e instanceof Error ? e.message : e,
        );
      }
    }

    const accountId = workingId ?? String(claims.sub ?? 'tfbank');
    accounts = [buildAccountFromLimits(limits, accountId)];
    debug(
      'Built 1 account id=%s (transactions %s) — %d harvested ids: %s',
      accountId,
      workingId ? 'RESOLVED' : 'still unresolved, see PROBE/TXN-TRY lines',
      foundIds.size,
      [...foundIds].join(','),
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
