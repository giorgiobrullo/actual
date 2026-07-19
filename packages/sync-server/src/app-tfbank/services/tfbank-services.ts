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

/** Coerce an API payload that may be an array or a wrapped list into an array. */
function toArray(payload: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
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
 * Normalize an Avarda transaction into Actual's shape.
 *
 * Amount is kept in decimal form; sync.ts converts it to cents. The exact field
 * names and the amount-sign convention are confirmed on the first real sync
 * (task #20) — this reads the common Avarda names defensively and logs the raw
 * record so the shape can be locked in.
 */
function normalizeTransaction(
  raw: unknown,
  source: 'transaction' | 'invoice',
): Transaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const rawDate = firstString(rec, [
    'transactionDate',
    'bookingDate',
    'date',
    'valueDate',
    'invoiceDate',
    'dueDate',
  ]);
  if (!rawDate) {
    debug('Skipping %s with no date: %O', source, rec);
    return null;
  }
  const date = rawDate.split('T')[0];

  const amount = num(rec.amount ?? rec.transactionAmount ?? rec.totalAmount);
  if (amount === undefined) {
    debug('Skipping %s with no amount: %O', source, rec);
    return null;
  }

  const transactionId = firstString(rec, [
    'transactionId',
    'id',
    'reference',
    'uniqueReference',
    'invoiceId',
    'invoiceNumber',
  ]);

  const payeeName =
    firstString(rec, [
      'merchantName',
      'description',
      'text',
      'merchant',
      'title',
    ]) || (source === 'invoice' ? 'TF Bank Invoice' : 'TF Bank');

  const noteParts: string[] = [];
  const detail = firstString(rec, ['additionalInfo', 'note', 'details']);
  if (detail && detail !== payeeName) noteParts.push(detail);
  if (source === 'invoice') noteParts.push('Invoice');

  return {
    transactionId: transactionId || `${source}-${date}-${amount}`,
    amount,
    payeeName,
    notes: noteParts.join(' | '),
    date,
    booked: true,
  };
}

/**
 * Fetch all TF Bank activity for an account: recent card transactions plus the
 * invoice (fattura) history, normalized, de-duplicated and sorted newest-first.
 */
export async function getTransactions(
  accountId: string,
  _startDate?: string,
  _endDate?: string,
): Promise<Transaction[]> {
  if (!isConfigured()) {
    throw new TFBankSetupError();
  }

  const client = await getAuthenticatedClient();

  const results: Transaction[] = [];

  try {
    const txnPayload = await client.getTransactions(accountId);
    for (const raw of toArray(txnPayload, 'transactions', 'items', 'data')) {
      const tx = normalizeTransaction(raw, 'transaction');
      if (tx) results.push(tx);
    }
    debug('Fetched %d transaction(s)', results.length);
  } catch (error) {
    debug('Failed fetching transactions: %s', error);
  }

  try {
    const invoicePayload = await client.getInvoices();
    let invoiceCount = 0;
    for (const raw of toArray(invoicePayload, 'invoices', 'items', 'data')) {
      const tx = normalizeTransaction(raw, 'invoice');
      if (tx) {
        results.push(tx);
        invoiceCount++;
      }
    }
    debug('Fetched %d invoice(s)', invoiceCount);
  } catch (error) {
    debug('Failed fetching invoices: %s', error);
  }

  // Deduplicate by transactionId (invoices and transactions may overlap).
  const seen = new Set<string>();
  const unique = results.filter(tx => {
    if (seen.has(tx.transactionId)) return false;
    seen.add(tx.transactionId);
    return true;
  });

  unique.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  debug('Returning %d unique transaction(s)', unique.length);
  return unique;
}
