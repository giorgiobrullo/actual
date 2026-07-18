// Amex API Types

export type AmexEndpoints = {
  '/configure': Endpoint<ConfigureBody, void>;
  '/status': Endpoint<undefined, AmexStatusResponse>;
  '/login': Endpoint<undefined, AmexLoginResponse>;
  '/accounts': Endpoint<undefined, AmexAccount[]>;
  '/transactions': Endpoint<TransactionsBody, TransactionsResponse>;
  '/deconfigure': Endpoint<undefined, void>;
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

export type ImapConfig = {
  host: string;
  port?: number;
  user: string;
  password: string;
  folder?: string; // e.g., "INBOX/giorgiobrux" or "INBOX.subfolder"
};

export type ConfigureBody = {
  username: string | null;
  password: string | null;
  imap?: ImapConfig;
  proxy?: string | null;
  captchaApiKey?: string | null;
};

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

export type TestCaptchaBody = {
  apiKey: string;
};

export type TestCaptchaResponse = {
  success: boolean;
  balance?: number;
};

export type TestProxyBody = {
  proxy: string; // e.g., "socks5://localhost:1055"
};

export type TestProxyResponse = {
  success: boolean;
  ip?: string; // The exit IP address seen through the proxy
  message?: string; // Error message if failed
};

export type AmexLoginResponse = {
  success: boolean;
  requires2FA?: boolean;
  accounts: AmexAccount[];
};

export type AmexAccount = {
  account_token: string;
  name: string;
  display_number: string;
  balance?: number;
  credit_limit?: number; // Total credit limit for identification
  available_credit?: number;
};

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

// Token type for UI flow (similar to EnableBankingToken)
export type AmexToken = {
  accounts: AmexAccount[];
};

// Normalized type for client-side account selection (matches Akahu/EnableBanking pattern)
export type SyncServerAmexAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number;
  mask?: string;
};
