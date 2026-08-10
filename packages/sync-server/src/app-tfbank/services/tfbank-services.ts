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
 * convention: purchases are money out (negative), payments and refunds are
 * money in (positive). Avarda reports every amount as a positive magnitude and
 * expresses direction through `type` instead, so the sign is applied here.
 */
export function normalizeTransaction(raw: unknown): Transaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const rawDate = firstString(rec, ['date', 'transactionDate', 'bookingDate']);
  if (!rawDate) {
    debug('skip txn (no date): %s', JSON.stringify(rec).slice(0, 200));
    return null;
  }
  const date = rawDate.split('T')[0];

  const magnitude = num(rec.amount ?? rec.totalAmount);
  if (magnitude === undefined) {
    debug('skip txn (no amount): %s', JSON.stringify(rec).slice(0, 200));
    return null;
  }

  // Anything that returns money to the card is an inflow; everything else is a
  // purchase. Matching is loose because `type` is a server-side enum whose full
  // set we have not seen.
  const type = firstString(rec, ['type', 'transactionType']);
  const isInflow = /refund|return|payment|credit|repayment/i.test(type);
  const amount = isInflow ? Math.abs(magnitude) : -Math.abs(magnitude);

  // `orderReference` is Avarda's own per-transaction reference and is what
  // makes reruns idempotent. The date/amount/description composite is only a
  // fallback for rows that carry no reference.
  const transactionId =
    firstString(rec, ['orderReference', 'transactionId', 'id']) ||
    `${date}-${magnitude}-${firstString(rec, ['description'])}`;

  // Repayments describe themselves by IBAN, which is unreadable as a payee, so
  // they get the same fixed name the other card integrations use and keep the
  // account details in the notes instead.
  const description = firstString(rec, ['description', 'merchantName']);
  const isRepayment =
    isInflow && /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/.test(description);
  const payeeName = isRepayment
    ? 'Credit Card Payment'
    : description || 'TF Bank';

  // Labelled parts only: the bare type ('CardTransaction' on every purchase)
  // carries no information and just crowds out anything that does.
  const noteParts: string[] = [];
  if (isRepayment) {
    noteParts.push('⚠️ Convert to transfer from bank account');
    noteParts.push(`From: ${description}`);
  }
  const text = firstString(rec, ['notes']);
  if (text && text !== description) noteParts.push(text);
  const category = firstString(rec, ['merchantCategory', 'category']);
  if (category) noteParts.push(`Category: ${category}`);
  const foreignAmount = num(rec.foreignAmount ?? rec.originalAmount);
  const foreignCurrency = firstString(rec, [
    'foreignCurrency',
    'originalCurrency',
  ]);
  if (foreignAmount !== undefined && foreignCurrency) {
    noteParts.push(`Original: ${foreignAmount} ${foreignCurrency}`);
  }
  if (type && !/cardtransaction|incomingpayment/i.test(type)) {
    noteParts.push(`Type: ${type}`);
  }

  return {
    transactionId,
    amount,
    payeeName,
    notes: noteParts.join(' | '),
    date,
    booked: true,
  };
}

/**
 * Coerce a transactions payload into a flat array.
 *
 * The card API groups rows under `transactions` keyed by period rather than
 * returning a plain list, so object values are flattened as well.
 */
function toArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const rec = payload as Record<string, unknown>;
  for (const key of ['transactions', 'items', 'data', 'results']) {
    const value = rec[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap(v =>
        Array.isArray(v) ? v : [],
      );
    }
  }
  return [];
}

/**
 * Fetch card transactions for an account.
 *
 * `accountId` is the `cornicheAccountId` stored at link time. Endpoint details
 * (the required date window and the locale enum) live in the avarda-mypages
 * client.
 */
export async function getTransactions(
  accountId: string,
  startDate?: string,
  endDate?: string,
): Promise<Transaction[]> {
  if (!isConfigured()) {
    throw new TFBankSetupError();
  }

  const client = await getAuthenticatedClient();

  const transactionDateTo = (endDate ?? new Date().toISOString()).slice(0, 10);
  const transactionDateFrom = (
    startDate ?? new Date(Date.now() - 730 * 86_400_000).toISOString()
  ).slice(0, 10);

  const payload = await client.getTransactions({
    cornicheAccountId: accountId,
    transactionDateFrom,
    transactionDateTo,
  });

  const raw = toArray(payload);
  debug(
    'fetched %d raw transaction(s) between %s and %s',
    raw.length,
    transactionDateFrom,
    transactionDateTo,
  );

  const transactions = raw
    .map(normalizeTransaction)
    .filter((t): t is Transaction => t !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  debug('returning %d transaction(s)', transactions.length);
  return transactions;
}
