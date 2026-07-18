// Carta You / Advanzia API Types

export type Endpoint<BodyType, ResponseType> = {
  body: BodyType;
  response: ResponseType;
};

export type CartaYouEndpoints = {
  '/configure': Endpoint<ConfigureBody, void>;
  '/status': Endpoint<undefined, CartaYouStatusResponse>;
  '/login': Endpoint<undefined, CartaYouLoginResponse>;
  '/accounts': Endpoint<undefined, CartaYouAccount[]>;
  '/transactions': Endpoint<TransactionsBody, TransactionsResponse>;
  '/deconfigure': Endpoint<undefined, void>;
  '/sms-setup': Endpoint<undefined, SmsSetupResponse>;
  '/sms-status': Endpoint<undefined, SmsStatusResponse>;
  '/otp': Endpoint<OtpBody, OtpResponse>;
  '/otp-clear': Endpoint<undefined, { success: boolean }>;
};

export type CartaYouResponse<T extends keyof CartaYouEndpoints> =
  | { data: CartaYouEndpoints[T]['response']; error?: never }
  | { data?: never; error: CartaYouErrorInterface };

export type CartaYouErrorCode =
  | 'CARTAYOU_NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'BAD_REQUEST'
  | 'CARTAYOU_SESSION_EXPIRED'
  | 'INTERNAL_ERROR'
  | 'NOT_FOUND'
  | 'TIMED_OUT'
  | 'SMS_2FA_REQUIRED';

export type CartaYouErrorInterface = {
  error_code: CartaYouErrorCode;
  error_type: string;
};

export type ConfigureBody = {
  username: string | null;
  password: string | null;
};

export type TransactionsBody = {
  account_id: string;
  startDate?: string;
  endDate?: string;
};

export type CartaYouStatusResponse = {
  configured: boolean;
  lastLogin?: string;
};

export type CartaYouLoginResponse = {
  success: boolean;
  accounts: CartaYouAccount[];
};

export type CartaYouAccount = {
  account_id: string;
  name: string;
  display_number: string; // Last 4 digits
  balance?: number;
  credit_limit?: number;
  available_credit?: number;
};

export type Transaction = {
  transactionId: string;
  amount: number;
  payeeName: string;
  notes: string;
  date: string;
  booked?: boolean;
  [key: string]: unknown;
};

export type TransactionsResponse = {
  transactions: Transaction[];
  startingBalance?: number;
};

// Raw transaction type from Carta You API
// Based on actual API response from /api/accounts/{id}/transactions
export type CartaYouRawTransaction = {
  amount: number;
  currency: string;
  transactionTime: string | null;
  transactionDate: string; // "2026-01-19T00:00:00"
  transactionDateTime: string;
  classification: 'PURCHASE' | 'PAYMENT' | string;
  status: 'APPROVED' | 'REVERSED' | 'REVERSAL' | string;
  reference: string;
  merchantName: string;
  text: string;
  merchantCategory: string;
  foreignAmount: {
    amount: number;
    currency: string;
    conversionRate: number;
  } | null;
  uniqueReference: string;
  type: string;
};

// API response for transactions endpoint
export type CartaYouTransactionsApiResponse = {
  transactions: CartaYouRawTransaction[];
  months: Array<{ year: number; monthStartingAtZero: number }>;
  mostRecent: boolean;
  accountId: string;
};

// Token type for UI flow
export type CartaYouToken = {
  accounts: CartaYouAccount[];
};

// SMS OTP types
export type SmsSetupResponse = {
  secret: string;
  configured: boolean;
};

export type SmsStatusResponse = {
  configured: boolean;
};

export type OtpBody = {
  since?: number;
};

export type OtpResponse = {
  code: string | null;
  timestamp: number;
  found: boolean;
};
