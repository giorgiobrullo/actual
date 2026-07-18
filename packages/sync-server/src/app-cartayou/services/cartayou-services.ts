import createDebug from 'debug';

import type {
  CartaYouAccount,
  CartaYouRawTransaction,
  CartaYouTransactionsApiResponse,
  Transaction,
} from '#app-cartayou/models/cartayou';
import {
  CartaYouSetupError,
  SessionExpiredError,
} from '#app-cartayou/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';

import {
  buildCookieHeader,
  clearSession,
  getCachedSession,
  hasValidSession,
  performLogin,
} from './cartayou-auth';

const debug = createDebug('actual:cartayou:services');

// Carta You API endpoints (to be refined based on actual API)
const CARTAYOU_API_BASE = 'https://my.cartayou.it/api';

/**
 * Check if Carta You is configured with credentials
 */
export function isConfigured(): boolean {
  const username = secretsService.get(SecretName.cartayou_username);
  const password = secretsService.get(SecretName.cartayou_password);
  return Boolean(username && password);
}

/**
 * Configure Carta You credentials
 */
export function configure(username: string, password: string): void {
  secretsService.set(SecretName.cartayou_username, username);
  secretsService.set(SecretName.cartayou_password, password);
  debug('Carta You credentials configured');
}

/**
 * Clear Carta You credentials
 */
export function deconfigure(): void {
  secretsService.set(SecretName.cartayou_username, '');
  secretsService.set(SecretName.cartayou_password, '');
  clearSession();
  debug('Carta You credentials cleared');
}

/**
 * Generate a random UUID for correlation ID
 */
function generateCorrelationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Make an authenticated API request using session cookies
 */
async function makeApiRequest<T>(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<T> {
  const session = getCachedSession();
  if (!session) {
    throw new SessionExpiredError();
  }

  const cookieHeader = buildCookieHeader(session.cookies);

  // Verify we have the essential frontCookie
  if (!session.cookies['frontCookie']) {
    debug('Warning: frontCookie not found in session cookies');
    debug('Available cookies: %o', Object.keys(session.cookies));
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Cookie: cookieHeader,
      Accept: '*/*',
      'Content-Type': 'application/json',
      // Required headers that the browser sends
      Referer: 'https://my.cartayou.it/',
      'x-correlationid': generateCorrelationId(),
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    debug('API request failed: %d %s', response.status, response.statusText);
    if (response.status === 401 || response.status === 403) {
      clearSession();
      throw new SessionExpiredError();
    }
    throw new Error(`API request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

/**
 * Get accounts from session or by fetching
 */
export async function getAccounts(): Promise<CartaYouAccount[]> {
  if (!isConfigured()) {
    throw new CartaYouSetupError();
  }

  // Try to get from cached session first
  const session = getCachedSession();
  if (session && session.accounts.length > 0) {
    return session.accounts;
  }

  // Need to login to discover accounts
  const newSession = await performLogin();
  return newSession.accounts;
}

/**
 * Normalize a Carta You transaction to Actual format
 *
 * Note: Amount is kept in decimal form (e.g., 10.50) because
 * the sync.ts normalizeBankSyncTransactions will convert it to cents.
 */
function normalizeTransaction(raw: CartaYouRawTransaction): Transaction {
  // Credit card amounts from API:
  // - Negative = purchases/charges
  // - Positive = payments/refunds/direct debits
  const amount = raw.amount;

  // Detect if this is a payment to the credit card
  const isPayment = raw.classification === 'PAYMENT' && amount > 0;

  // Extract payee name from merchantName or text
  // For payments, use a clearer payee name (matching AMEX behavior)
  let payeeName: string;
  if (isPayment) {
    payeeName = 'Credit Card Payment';
  } else {
    payeeName = raw.merchantName || raw.text || 'Unknown';
  }

  // Build notes
  const noteParts: string[] = [];

  // For payments, add reminder to convert to transfer (matching AMEX behavior)
  if (isPayment) {
    noteParts.push('⚠️ Convert to transfer from bank account');
    // Include original description for reference
    if (raw.merchantName) {
      noteParts.push(raw.merchantName);
    }
  } else {
    // Include original text if different from merchantName
    if (raw.text && raw.text !== raw.merchantName) {
      noteParts.push(raw.text);
    }
  }

  // Foreign currency details (not relevant for payments)
  if (!isPayment && raw.foreignAmount) {
    noteParts.push(
      `Original: ${raw.foreignAmount.amount} ${raw.foreignAmount.currency} @ ${raw.foreignAmount.conversionRate}`,
    );
  }

  // Category if available (not relevant for payments)
  if (!isPayment && raw.merchantCategory) {
    noteParts.push(`Category: ${raw.merchantCategory}`);
  }

  // Transaction status (for reversals, etc.)
  if (raw.status && raw.status !== 'APPROVED') {
    noteParts.push(`Status: ${raw.status}`);
  }

  // Extract date from transactionDate (format: "2026-01-19T00:00:00")
  const date = raw.transactionDate.split('T')[0];

  return {
    transactionId: raw.uniqueReference || raw.reference,
    amount,
    payeeName: payeeName.trim(),
    notes: noteParts.join(' | '),
    date,
    booked: raw.status === 'APPROVED',
  };
}

/**
 * Fetch transactions for a specific month
 *
 * API endpoints:
 * - /api/accounts/{accountId}/transactions - most recent (current + previous month)
 * - /api/accounts/{accountId}/transactions/{year}/{monthStartingAtZero} - specific month
 */
async function fetchMonthTransactions(
  accountId: string,
  year?: number,
  month?: number,
): Promise<CartaYouRawTransaction[]> {
  let url = `${CARTAYOU_API_BASE}/accounts/${accountId}/transactions`;

  // If year and month provided, fetch that specific month
  // Note: API uses 0-indexed months (0 = January, 11 = December)
  if (year !== undefined && month !== undefined) {
    url = `${url}/${year}/${month}`;
  }

  debug('Fetching transactions from: %s', url);

  const response = await makeApiRequest<CartaYouTransactionsApiResponse>(url);
  return response.transactions || [];
}

/**
 * Fetch all transactions for an account
 *
 * Fetches month by month from current backwards until API returns error/empty
 */
export async function getTransactions(
  accountId: string,
  _startDate?: string,
  _endDate?: string,
): Promise<Transaction[]> {
  if (!isConfigured()) {
    throw new CartaYouSetupError();
  }

  // Ensure we have a valid session
  if (!hasValidSession()) {
    await performLogin();
  }

  debug('Fetching all transactions for account: %s', accountId);

  const allRawTransactions: CartaYouRawTransaction[] = [];

  try {
    // First, fetch the most recent transactions (no year/month)
    const recentTransactions = await fetchMonthTransactions(accountId);
    allRawTransactions.push(...recentTransactions);
    debug('Fetched %d recent transactions', recentTransactions.length);

    // Start from current month and go backwards until we hit an error
    const now = new Date();
    let currentYear = now.getFullYear();
    let currentMonth = now.getMonth(); // 0-indexed

    // Skip current month since we already got it from the "recent" endpoint
    // Go back one month to start
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }

    // Keep fetching until we get an error or 3 consecutive empty months
    // (empty months don't mean account start - user may just not have spent that month)
    let consecutiveEmptyMonths = 0;
    const MAX_EMPTY_MONTHS = 3;

    while (consecutiveEmptyMonths < MAX_EMPTY_MONTHS) {
      try {
        const monthTransactions = await fetchMonthTransactions(
          accountId,
          currentYear,
          currentMonth,
        );

        if (monthTransactions.length === 0) {
          consecutiveEmptyMonths++;
          debug(
            'No transactions for %d/%d (%d consecutive empty)',
            currentYear,
            currentMonth,
            consecutiveEmptyMonths,
          );
        } else {
          consecutiveEmptyMonths = 0; // Reset counter when we find transactions
          allRawTransactions.push(...monthTransactions);
          debug(
            'Fetched %d transactions for %d/%d',
            monthTransactions.length,
            currentYear,
            currentMonth,
          );
        }
      } catch (error) {
        // Stop if we get an error (likely reached account creation date)
        debug(
          'Error fetching %d/%d, stopping: %o',
          currentYear,
          currentMonth,
          error,
        );
        break;
      }

      // Go back one month
      currentMonth--;
      if (currentMonth < 0) {
        currentMonth = 11;
        currentYear--;
      }
    }

    if (consecutiveEmptyMonths >= MAX_EMPTY_MONTHS) {
      debug('Stopped after %d consecutive empty months', MAX_EMPTY_MONTHS);
    }

    debug('Total raw transactions fetched: %d', allRawTransactions.length);

    // Deduplicate by uniqueReference (in case of overlap between recent and monthly)
    const seen = new Set<string>();
    const uniqueTransactions = allRawTransactions.filter(tx => {
      const key = tx.uniqueReference || tx.reference;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    debug('After deduplication: %d transactions', uniqueTransactions.length);

    // Normalize transactions
    const transactions = uniqueTransactions.map(normalizeTransaction);

    // Sort by date descending (newest first)
    transactions.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );

    debug('Returning %d transactions', transactions.length);

    return transactions;
  } catch (error) {
    debug('Error fetching transactions: %o', error);

    if (error instanceof SessionExpiredError) {
      throw error;
    }

    throw error;
  }
}

/**
 * Get current session status
 */
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
