import type { NextFunction, Request, Response } from 'express';

import type {
  TFBankEndpoints,
  TFBankErrorCode,
  TFBankErrorInterface,
} from '#app-tfbank/models/tfbank';

export class TFBankError extends Error {
  errorCode: TFBankErrorCode;
  errorType: string;

  constructor(errorCode: TFBankErrorCode, errorType: string) {
    super(errorType);
    this.errorCode = errorCode;
    this.errorType = errorType;
    this.name = 'TFBankError';
  }

  toJSON(): TFBankErrorInterface {
    return {
      error_code: this.errorCode,
      error_type: this.errorType,
    };
  }
}

export class TFBankSetupError extends TFBankError {
  constructor() {
    super('TFBANK_NOT_CONFIGURED', 'TF Bank credentials are not configured');
  }
}

export class AuthFailedError extends TFBankError {
  constructor(message: string = 'Authentication failed') {
    super('AUTH_FAILED', message);
  }
}

export class SessionExpiredError extends TFBankError {
  constructor() {
    super('TFBANK_SESSION_EXPIRED', 'Session expired. Please log in again.');
  }
}

export class Sms2FARequiredError extends TFBankError {
  constructor() {
    super('SMS_2FA_REQUIRED', 'SMS 2FA verification is required');
  }
}

export function badRequestVariableError(
  variable: string,
  endpoint: string,
): TFBankError {
  return new TFBankError(
    'BAD_REQUEST',
    `Missing required parameter '${variable}' for ${endpoint}`,
  );
}

/**
 * Error handling middleware for TF Bank endpoints.
 */
export function handleErrorInHandler<T extends keyof TFBankEndpoints>(
  handler: (req: Request) => Promise<TFBankEndpoints[T]['response']>,
) {
  return async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const result = await handler(req);
      res.send({ status: 'ok', data: { data: result } });
    } catch (error) {
      if (error instanceof TFBankError) {
        res.send({ status: 'ok', data: { error: error.toJSON() } });
      } else {
        console.error('TF Bank internal error:', error);
        res.send({
          status: 'ok',
          data: {
            error: {
              error_code: 'INTERNAL_ERROR',
              error_type:
                error instanceof Error ? error.message : 'Unknown error',
            },
          },
        });
      }
    }
  };
}
