// TF Bank (Avarda MyPages) API types.
//
// Mirrors the Carta You model shape so the loot-core/client wiring is identical.
// The only real difference is the service layer: TF Bank is a pure-fetch
// integration via the `avarda-mypages` client, not browser automation.

export type Endpoint<BodyType, ResponseType> = {
  body: BodyType;
  response: ResponseType;
};

export type TFBankEndpoints = {
  '/configure': Endpoint<ConfigureBody, void>;
  '/status': Endpoint<undefined, TFBankStatusResponse>;
  '/login': Endpoint<undefined, TFBankLoginResponse>;
  '/accounts': Endpoint<undefined, TFBankAccount[]>;
  '/transactions': Endpoint<TransactionsBody, TransactionsResponse>;
  '/deconfigure': Endpoint<undefined, void>;
  '/sms-setup': Endpoint<undefined, SmsSetupResponse>;
  '/sms-status': Endpoint<undefined, SmsStatusResponse>;
  '/otp': Endpoint<OtpBody, OtpResponse>;
  '/otp-clear': Endpoint<undefined, { success: boolean }>;
};

export type TFBankResponse<T extends keyof TFBankEndpoints> =
  | { data: TFBankEndpoints[T]['response']; error?: never }
  | { data?: never; error: TFBankErrorInterface };

export type TFBankErrorCode =
  | 'TFBANK_NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'BAD_REQUEST'
  | 'TFBANK_SESSION_EXPIRED'
  | 'INTERNAL_ERROR'
  | 'NOT_FOUND'
  | 'TIMED_OUT'
  | 'SMS_2FA_REQUIRED';

export type TFBankErrorInterface = {
  error_code: TFBankErrorCode;
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

export type TFBankStatusResponse = {
  configured: boolean;
  lastLogin?: string;
};

export type TFBankLoginResponse = {
  success: boolean;
  accounts: TFBankAccount[];
};

export type TFBankAccount = {
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

// Token type for the UI flow.
export type TFBankToken = {
  accounts: TFBankAccount[];
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
