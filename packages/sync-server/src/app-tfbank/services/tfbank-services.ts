import createDebug from 'debug';

import type { Transaction } from '#app-tfbank/models/tfbank';
import { TFBankSetupError } from '#app-tfbank/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';

import {
  clearSession,
  getAuthenticatedClient,
  hasValidSession,
} from './tfbank-auth';

const debug = createDebug('actual:tfbank:services');

const CARD_BASE = 'https://cardmanagement.production.avarda.com';

export function isConfigured(): boolean {
  const username = secretsService.get(SecretName.tfbank_username);
  const password = secretsService.get(SecretName.tfbank_password);
  return Boolean(username && password);
}

export function configure(username: string, password: string): void {
  secretsService.set(SecretName.tfbank_username, username);
  secretsService.set(SecretName.tfbank_password, password);
  debug('TF Bank credentials configured');
}

export function deconfigure(): void {
  secretsService.set(SecretName.tfbank_username, '');
  secretsService.set(SecretName.tfbank_password, '');
  clearSession();
  debug('TF Bank credentials cleared');
}

export function getStatus(): {
  configured: boolean;
  hasSession: boolean;
  lastLogin?: string;
} {
  return {
    configured: isConfigured(),
    hasSession: hasValidSession(),
  };
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function firstString(rec: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Normalize an Avarda card transaction into Actual's shape.
 *
 * Amount is kept in decimal form; sync.ts converts it to cents. Credit-card
 * convention: purchases are money out (negative), payments/refunds are money in
 * (positive). The exact field names / sign are finalized against the live
 * SAMPLE captured during login (see tfbank-auth) then folded into the client.
 */
function normalizeTransaction(raw: unknown): Transaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const rawDate = firstString(rec, [
    'transactionDate',
    'bookingDate',
    'date',
    'valueDate',
    'purchaseDate',
  ]);
  if (!rawDate) {
    debug('skip txn (no date): %s', JSON.stringify(rec).slice(0, 200));
    return null;
  }
  const date = rawDate.split('T')[0];

  const amount = num(rec.amount ?? rec.transactionAmount ?? rec.billingAmount);
  if (amount === undefined) {
    debug('skip txn (no amount): %s', JSON.stringify(rec).slice(0, 200));
    return null;
  }

  const transactionId =
    firstString(rec, [
      'transactionId',
      'id',
      'reference',
      'transactionReference',
    ]) || `${date}-${amount}`;

  const payeeName =
    firstString(rec, ['merchantName', 'description', 'text', 'merchant']) ||
    'TF Bank';

  const noteParts: string[] = [];
  const category = firstString(rec, ['merchantCategory', 'category']);
  if (category) noteParts.push(category);

  return {
    transactionId,
    amount,
    payeeName,
    notes: noteParts.join(' | '),
    date,
    booked: true,
  };
}

/** Coerce a transactions payload (array or wrapped) into an array. */
function toArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['transactions', 'items', 'data', 'results']) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/**
 * Fetch card transactions for an account. `accountId` is the cornicheAccountId
 * stored at link time; the endpoint requires a from/to date window.
 */
export async function getTransactions(
  accountId: string,
  startDate?: string,
  _endDate?: string,
): Promise<Transaction[]> {
  if (!isConfigured()) {
    throw new TFBankSetupError();
  }

  const client = await getAuthenticatedClient();
  const token = client.accessToken ?? '';

  const to = new Date().toISOString().slice(0, 10);
  const from = startDate
    ? startDate.slice(0, 10)
    : new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);

  const url =
    `${CARD_BASE}/api/v3/transactions/${encodeURIComponent(accountId)}` +
    `?transactionDateFrom=${from}&transactionDateTo=${to}&locale=it-IT`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Origin: 'https://areacliente.tfbank.it',
      Referer: 'https://areacliente.tfbank.it/',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    debug('transactions %d -> %s', res.status, body.slice(0, 300));
    throw new Error(`TF Bank transactions request failed: ${res.status}`);
  }

  const payload = await res.json();
  const raw = toArray(payload);
  debug('fetched %d raw transaction(s) for %s', raw.length, from);

  const transactions = raw
    .map(normalizeTransaction)
    .filter((t): t is Transaction => t !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  debug('returning %d transaction(s)', transactions.length);
  return transactions;
}
