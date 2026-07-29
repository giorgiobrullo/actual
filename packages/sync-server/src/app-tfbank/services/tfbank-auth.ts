import { AvardaMyPages, TF_BANK_ITALY } from 'avarda-mypages';
import type { CardConfigCard } from 'avarda-mypages';
import createDebug from 'debug';

import type { TFBankAccount } from '#app-tfbank/models/tfbank';
import { AuthFailedError } from '#app-tfbank/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';

import * as smsOtpService from './sms-otp-service';
import { isProbeEnabled, probeAccountDiscovery } from './tfbank-probe';

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

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Build the TF Bank account from a card in `/api/v1/config` plus its limits.
 *
 * `cornicheAccountId` is stored as `account_id` because that is what
 * `/api/v3/transactions/{id}` takes, so bank-sync can pass it straight through.
 * The card is identified separately by `cornicheCardPan`, which is what credit
 * limits and the overview are keyed by.
 */
export function buildAccount(
  card: CardConfigCard,
  limits: unknown,
): TFBankAccount {
  const lim = (limits && typeof limits === 'object' ? limits : {}) as Record<
    string,
    unknown
  >;
  const last4 =
    String(card.maskedCardNumber ?? card.cornicheCardPan ?? '')
      .replace(/\D/g, '')
      .slice(-4) || '0000';
  return {
    account_id: card.cornicheAccountId,
    name: 'TF Bank',
    display_number: last4,
    balance: num(lim.usedBalance ?? lim.openingBalance),
    credit_limit: num(lim.loanLimit),
    available_credit: num(lim.availableBalance),
  };
}

/**
 * Perform the full TF Bank login and discover the cards on the account.
 *
 * Discovery is `/api/v1/config`, the only endpoint that exposes the card
 * identifiers; the endpoints themselves live in the avarda-mypages client so
 * this file has no URLs of its own.
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
    // A login costs the user an SMS, so when the discovery probe is enabled it
    // piggybacks on this one rather than logging in again on its own.
    if (isProbeEnabled()) {
      try {
        await probeAccountDiscovery(client);
      } catch (e) {
        debug('probe failed: %s', e instanceof Error ? e.message : e);
      }
    }

    const cards = await client.getCards();
    debug('config returned %d card(s)', cards.length);

    // Credit limits are per card, so they are fetched per card rather than once
    // for the customer.
    accounts = await Promise.all(
      cards.map(async card => {
        const limits = await client
          .getCreditLimits(card.cornicheCardPan)
          .catch(e => {
            debug(
              'credit limits failed for %s: %s',
              card.cornicheCardPan,
              e instanceof Error ? e.message : e,
            );
            return {};
          });
        return buildAccount(card, limits);
      }),
    );

    for (const account of accounts) {
      debug(
        'discovered account_id=%s (**** %s)',
        account.account_id,
        account.display_number,
      );
    }
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
