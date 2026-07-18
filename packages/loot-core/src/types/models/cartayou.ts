// Carta You / Advanzia API Types

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

export type Endpoint<BodyType, ResponseType> = {
  body: BodyType;
  response: ResponseType;
};

export type CartaYouResponse<T extends keyof CartaYouEndpoints> =
  | {
      data: CartaYouEndpoints[T]['response'];
      error?: undefined;
    }
  | {
      data?: undefined;
      error: CartaYouErrorInterface;
    };

export type CartaYouErrorCode =
  | 'CARTAYOU_NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'CARTAYOU_SESSION_EXPIRED'
  | 'SMS_2FA_REQUIRED'
  | 'INTERNAL_ERROR'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'TIMED_OUT';

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
  display_number: string;
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

// Normalized type for client-side account selection (matches Akahu/EnableBanking pattern)
export type SyncServerCartaYouAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number;
  mask?: string;
};
