// Amex API Types - Based on discovered API structure

export type TestImapBody = {
  host: string;
  port?: number;
  user: string;
  password: string;
};

export type TestImapResponse = {
  success: boolean;
  message: string;
};

export type DebugImapBody = {
  host: string;
  port?: number;
  user: string;
  password: string;
  folder?: string;
};

export type DebugImapResponse = {
  success: boolean;
  message: string;
  emails?: Array<{
    subject: string;
    from: string;
    date: string;
    bodyPreview: string;
    foundCode: string | null;
  }>;
};

export type TestCaptchaBody = {
  apiKey: string;
};

export type TestCaptchaResponse = {
  success: boolean;
  balance?: number;
};

export type TestProxyBody = {
  proxy: string;
};

export type TestProxyResponse = {
  success: boolean;
  ip?: string;
  message?: string;
};

export type AmexEndpoints = {
  '/configure': Endpoint<ConfigureBody, void>;
  '/status': Endpoint<undefined, AmexStatusResponse>;
  '/login': Endpoint<undefined, AmexLoginResponse>;
  '/accounts': Endpoint<undefined, AmexAccount[]>;
  '/transactions': Endpoint<TransactionsBody, TransactionsResponse>;
  '/test-imap': Endpoint<TestImapBody, TestImapResponse>;
  '/debug-imap': Endpoint<DebugImapBody, DebugImapResponse>;
  '/test-captcha': Endpoint<TestCaptchaBody, TestCaptchaResponse>;
  '/test-proxy': Endpoint<TestProxyBody, TestProxyResponse>;
};

export type Endpoint<BodyType, ResponseType> = {
  body: BodyType;
  response: ResponseType;
};

export type AmexResponse<T extends keyof AmexEndpoints> =
  | {
      data: AmexEndpoints[T]['response'];
      error?: undefined;
    }
  | {
      data?: undefined;
      error: AmexErrorInterface;
    };

export type AmexErrorCode =
  | 'AMEX_NOT_CONFIGURED'
  | 'AMEX_AUTH_FAILED'
  | 'AMEX_SESSION_EXPIRED'
  | 'AMEX_2FA_REQUIRED'
  | 'INTERNAL_ERROR'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'TIMED_OUT';

export type AmexErrorInterface = {
  error_code: AmexErrorCode;
  error_type: string;
};

export type ConfigureBody = {
  username: string;
  password: string;
  imap?: ImapConfig;
  proxy?: string | null;
  captchaApiKey?: string | null;
};

export type ImapConfig = {
  host: string;
  port?: number;
  user: string;
  password: string;
  folder?: string;
};

export type TransactionsBody = {
  account_token: string;
  startDate?: string;
  endDate?: string;
};

export type AmexStatusResponse = {
  configured: boolean;
  lastLogin?: string;
  captchaSolverConfigured?: boolean;
  proxyConfigured?: boolean;
};

export type AmexLoginResponse = {
  success: boolean;
  requires2FA?: boolean;
  accounts: AmexAccount[];
};

export type AmexAccount = {
  account_token: string;
  name: string;
  display_number: string; // Last 4 digits
  balance?: number;
  credit_limit?: number; // Total credit limit for identification
  available_credit?: number;
};

// Raw API response types from Amex
export type AmexRawTransaction = {
  identifier: string;
  description: string;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
  sub_type?: 'payment' | string; // 'payment' = credit card repayment from bank account
  post_date: string;
  charge_date: string;
  foreign_details?: {
    amount: number | string;
    // API uses different field names
    currency?: string;
    conversion_rate?: number;
    iso_alpha_currency_code?: string;
    exchange_rate?: string;
    commission_amount?: number;
    currency_description?: string;
  };
  extended_details?: {
    merchant?: {
      name: string;
      address?: {
        city?: string;
        country?: string;
        value?: string;
      };
    };
  };
  [key: string]: unknown;
};

export type AmexRawTransactionsResponse = {
  transactions: AmexRawTransaction[];
  total_count: number;
};

// Normalized transaction for Actual
export type Transaction = {
  transactionId: string;
  amount: number;
  payeeName: string;
  notes: string;
  date: string;
  booked?: boolean; // true = posted/cleared transaction
  [key: string]: unknown;
};

export type TransactionsResponse = {
  transactions: Transaction[];
  startingBalance?: number;
};
