import createDebug from 'debug';

import type {
  AmexAccount,
  AmexRawTransaction,
  AmexRawTransactionsResponse,
  ImapConfig,
  Transaction,
} from '#app-amex/models/amex';
import { AmexSetupError, SessionExpiredError } from '#app-amex/utils/errors';
import { SecretName, secretsService } from '#services/secrets-service';

import {
  buildCookieHeader,
  clearSession,
  getSessionCookies,
  hasValidSession,
} from './amex-auth';

const debug = createDebug('actual:amex:services');

// Amex API endpoints
const AMEX_API_BASE = 'https://global.americanexpress.com/api';
const TRANSACTIONS_ENDPOINT = `${AMEX_API_BASE}/servicing/v1/financials/transactions`;
const STATEMENT_PERIODS_ENDPOINT = `${AMEX_API_BASE}/servicing/v1/financials/statement_periods`;
const ACCOUNTS_ENDPOINT = `${AMEX_API_BASE}/servicing/v1/member/accounts`;

// Statement period from Amex API
type StatementPeriod = {
  statement_start_date: string;
  statement_end_date: string;
  index: number;
};

/**
 * Check if Amex is configured with credentials
 */
export function isConfigured(): boolean {
  const username = secretsService.get(SecretName.amex_username);
  const password = secretsService.get(SecretName.amex_password);
  return Boolean(username && password);
}

/**
 * Configure Amex credentials and optionally IMAP for 2FA
 */
export function configure(
  username: string,
  password: string,
  imap?: ImapConfig,
): void {
  secretsService.set(SecretName.amex_username, username);
  secretsService.set(SecretName.amex_password, password);

  if (imap) {
    secretsService.set(SecretName.amex_imap_host, imap.host);
    secretsService.set(SecretName.amex_imap_port, String(imap.port || 993));
    secretsService.set(SecretName.amex_imap_user, imap.user);
    secretsService.set(SecretName.amex_imap_password, imap.password);
    secretsService.set(SecretName.amex_imap_folder, imap.folder || '');
    debug('Amex credentials and IMAP configured');
  } else {
    debug('Amex credentials configured (no IMAP)');
  }
}

/**
 * Clear Amex credentials and IMAP settings
 */
export function deconfigure(): void {
  secretsService.set(SecretName.amex_username, '');
  secretsService.set(SecretName.amex_password, '');
  secretsService.set(SecretName.amex_imap_host, '');
  secretsService.set(SecretName.amex_imap_port, '');
  secretsService.set(SecretName.amex_imap_user, '');
  secretsService.set(SecretName.amex_imap_password, '');
  secretsService.set(SecretName.amex_imap_folder, '');
  clearSession();
  debug('Amex credentials and IMAP settings cleared');
}

/**
 * Configure proxy for browser automation
 * @param proxy - Proxy URL (e.g., "socks5://10.0.0.1:1080") or null to clear
 */
export function configureProxy(proxy: string | null): void {
  if (proxy) {
    secretsService.set(SecretName.amex_proxy, proxy);
    debug('Amex proxy configured: %s', proxy);
  } else {
    secretsService.set(SecretName.amex_proxy, '');
    debug('Amex proxy cleared');
  }
}

/**
 * Check if proxy is configured
 */
export function isProxyConfigured(): boolean {
  const proxy = secretsService.get(SecretName.amex_proxy);
  return Boolean(proxy);
}

/**
 * Get configured proxy URL
 */
export function getProxy(): string | null {
  return secretsService.get(SecretName.amex_proxy) || null;
}

/**
 * Test proxy connection by fetching external IP through it
 * Uses the browser (same as login flow) to ensure accurate test
 */
export async function testProxy(
  proxyUrl: string,
): Promise<{ success: boolean; ip?: string; message?: string }> {
  debug('Testing proxy: %s', proxyUrl);

  const { closeStealthContext, launchStealthContext } =
    await import('#services/stealth-browser');
  let context = null;

  try {
    context = await launchStealthContext({ proxyServer: proxyUrl });
    const page = context.pages()[0] ?? (await context.newPage());

    // Fetch IP from httpbin (reliable, returns JSON)
    await page.goto('https://httpbin.org/ip', { timeout: 30000 });

    // Extract the IP from the JSON response
    const content = await page.textContent('body');
    const json = JSON.parse(content || '{}');
    const ip = json.origin;

    debug('Proxy test successful, exit IP: %s', ip);
    return { success: true, ip };
  } catch (error) {
    debug('Proxy test failed: %o', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (context) {
      await closeStealthContext(context);
    }
  }
}

/**
 * Make an authenticated API request to Amex
 */
async function makeApiRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const cookies = await getSessionCookies();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Content-Type': 'application/json',
    Cookie: buildCookieHeader(cookies),
    ...((options.headers as Record<string, string>) || {}),
  };

  debug('Making API request to: %s', url);

  const response = await fetch(url, {
    ...options,
    headers,
  });

  debug('API response status: %d', response.status);

  if (response.status === 401 || response.status === 403) {
    // Session expired, clear it and throw error
    clearSession();
    throw new SessionExpiredError('Amex session expired, please re-login');
  }

  if (!response.ok) {
    const text = await response.text();
    debug('API error response: %s', text);
    throw new Error(`Amex API error: ${response.status} ${text}`);
  }

  return (await response.json()) as T;
}

/**
 * Get list of accounts from Amex
 */
export async function getAccounts(): Promise<AmexAccount[]> {
  if (!isConfigured()) {
    throw new AmexSetupError();
  }

  // For now, we'll need to get account info from the transactions endpoint
  // or implement a separate accounts fetch. The user discovered the account_token
  // comes from the account list.
  // TODO: Implement proper account fetching

  debug('Fetching accounts...');

  try {
    const response = await makeApiRequest<{ accounts: AmexAccount[] }>(
      ACCOUNTS_ENDPOINT,
    );
    return response.accounts || [];
  } catch (e) {
    debug('Failed to fetch accounts: %o', e);
    // Return empty for now - user may need to manually provide account_token
    return [];
  }
}

/**
 * Normalize an Amex transaction to Actual format
 *
 * Note: Amount is kept in decimal form (e.g., 10.50) because
 * the sync.ts normalizeBankSyncTransactions will convert it to cents.
 */
function normalizeTransaction(raw: AmexRawTransaction): Transaction {
  const isPayment = raw.sub_type === 'payment';

  // Convert amount based on transaction type
  let amount: number;
  if (isPayment) {
    // Payments to the credit card should always be positive (deposit/reduces debt)
    // The API returns negative amounts for payments, so we use Math.abs
    amount = Math.abs(raw.amount);
  } else {
    // Regular transactions: DEBIT is negative (money spent), CREDIT is positive (refund)
    amount = raw.type === 'DEBIT' ? -raw.amount : raw.amount;
  }

  // Extract payee name from extended_details or description
  let payeeName =
    raw.extended_details?.merchant?.name || raw.description || 'Unknown';

  // For payments, use a clearer payee name
  if (isPayment) {
    payeeName = 'Credit Card Payment';
  }

  // Build notes with context for AI categorization
  const noteParts: string[] = [];

  // For payments, add reminder to convert to transfer
  if (isPayment) {
    noteParts.push('⚠️ Convert to transfer from bank account');
    // Include original description for reference
    if (raw.description) {
      noteParts.push(raw.description);
    }
  } else {
    // Include original description if different from payee (helps AI understand context)
    if (raw.description && raw.description !== payeeName) {
      noteParts.push(raw.description);
    }
  }

  // Location info (not relevant for payments)
  if (!isPayment && raw.extended_details?.merchant?.address) {
    const addr = raw.extended_details.merchant.address;
    const locationParts: string[] = [];
    if (addr.city) locationParts.push(addr.city);
    // Include country if not Italy (for context on foreign purchases)
    const country =
      (addr as { country_name?: string }).country_name || addr.country;
    if (country && country !== 'ITALY' && country !== 'IT') {
      locationParts.push(country);
    }
    if (locationParts.length > 0) {
      noteParts.push(locationParts.join(', '));
    }
  }

  // Payment method (Apple Pay, Google Pay, etc.) - not relevant for payments
  if (!isPayment) {
    const walletProvider = (
      raw.extended_details as {
        additional_attributes?: { wallet_provider?: string };
      }
    )?.additional_attributes?.wallet_provider;
    if (walletProvider) {
      noteParts.push(`via ${walletProvider} Pay`);
    }
  }

  // Foreign currency details (not relevant for payments)
  if (!isPayment && raw.foreign_details) {
    const fd = raw.foreign_details;
    const currency = fd.iso_alpha_currency_code || fd.currency;
    const rate = fd.exchange_rate || fd.conversion_rate;
    if (currency && rate) {
      noteParts.push(`Original: ${fd.amount} ${currency} @ ${rate}`);
    } else if (fd.amount) {
      noteParts.push(`Original: ${fd.amount}`);
    }
  }

  return {
    transactionId: raw.identifier,
    amount, // Keep in decimal - sync.ts will convert to cents
    payeeName: payeeName.trim(),
    notes: noteParts.join(' | '),
    date: raw.post_date, // Use post_date as the transaction date
    booked: true, // Posted transactions are cleared
    // Include raw data for debugging/future use
    rawChargeDate: raw.charge_date,
    rawType: raw.type,
    rawSubType: raw.sub_type,
  };
}

/**
 * Fetch transactions for a single statement period
 */
async function fetchStatementTransactions(
  accountToken: string,
  statementEndDate?: string,
): Promise<AmexRawTransaction[]> {
  const params = new URLSearchParams();
  params.set('limit', '1000');
  params.set('status', 'posted');

  if (statementEndDate) {
    params.set('statement_end_date', statementEndDate);
  }

  const url = `${TRANSACTIONS_ENDPOINT}?${params.toString()}`;

  const headers: Record<string, string> = {
    account_token: accountToken,
  };

  const response = await makeApiRequest<AmexRawTransactionsResponse>(url, {
    headers,
  });

  debug(
    'Fetched %d transactions for statement ending %s',
    response.transactions?.length || 0,
    statementEndDate || 'current',
  );

  return response.transactions || [];
}

/**
 * Fetch statement periods for an account
 * Returns the list of billing cycles with exact start/end dates
 */
async function fetchStatementPeriods(
  accountToken: string,
): Promise<StatementPeriod[]> {
  const headers: Record<string, string> = {
    account_token: accountToken,
  };

  try {
    const response = await makeApiRequest<StatementPeriod[]>(
      STATEMENT_PERIODS_ENDPOINT,
      { headers },
    );

    debug('Fetched %d statement periods', response?.length || 0);
    return response || [];
  } catch (err) {
    debug('Error fetching statement periods: %o', err);
    return [];
  }
}

/**
 * Fetch transactions for an account
 *
 * The Amex API works with statement periods:
 * - No statement_end_date: returns current/unbilled transactions
 * - With statement_end_date: returns transactions from that billing period
 *
 * We first fetch the actual statement periods from the API to get exact billing cycle dates,
 * then fetch transactions for each relevant period.
 */
export async function getTransactions(
  accountToken: string,
  // startDate/endDate params kept for API compatibility but ignored
  // We fetch all statement periods and let sync.ts handle deduplication
  _startDate?: string,
  _endDate?: string,
): Promise<Transaction[]> {
  if (!isConfigured()) {
    throw new AmexSetupError();
  }

  debug('Fetching transactions for account: %s', accountToken);

  const allTransactions: AmexRawTransaction[] = [];
  const seenIds = new Set<string>();

  // 1. First, get current/unbilled transactions (no statement_end_date)
  const currentTransactions = await fetchStatementTransactions(accountToken);
  for (const tx of currentTransactions) {
    if (!seenIds.has(tx.identifier)) {
      seenIds.add(tx.identifier);
      allTransactions.push(tx);
    }
  }
  debug('Fetched %d current/unbilled transactions', allTransactions.length);

  // 2. Fetch all statement periods and iterate through them
  // The Amex API gives us exact billing cycles, so we fetch all of them
  // Deduplication in sync.ts will handle not re-importing existing transactions
  const statementPeriods = await fetchStatementPeriods(accountToken);

  if (statementPeriods.length > 0) {
    debug(
      'Fetching transactions from %d statement periods',
      statementPeriods.length,
    );

    // Iterate through all statement periods
    for (const period of statementPeriods) {
      debug(
        'Fetching period %d: %s to %s',
        period.index,
        period.statement_start_date,
        period.statement_end_date,
      );

      try {
        const historicalTransactions = await fetchStatementTransactions(
          accountToken,
          period.statement_end_date,
        );

        let newCount = 0;
        for (const tx of historicalTransactions) {
          if (!seenIds.has(tx.identifier)) {
            seenIds.add(tx.identifier);
            allTransactions.push(tx);
            newCount++;
          }
        }

        debug(
          'Found %d new transactions for period ending %s',
          newCount,
          period.statement_end_date,
        );
      } catch (err) {
        debug(
          'Error fetching statement %s: %o',
          period.statement_end_date,
          err,
        );
        // Continue to next period on error
      }
    }
  } else {
    debug('No statement periods returned from API');
  }

  debug('Total unique transactions fetched: %d', allTransactions.length);

  // Normalize transactions
  const transactions = allTransactions.map(normalizeTransaction);

  // Sort by date descending (newest first)
  transactions.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  // Note: We don't filter by startDate/endDate here because:
  // 1. We fetch complete statement periods from the API
  // 2. sync.ts handles deduplication via imported_id matching
  // 3. Filtering would prevent importing historical transactions on first sync

  debug('Returning %d transactions', transactions.length);

  return transactions;
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
