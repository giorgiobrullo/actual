import type { NextFunction, Request, Response } from 'express';

import type {
  CartaYouEndpoints,
  CartaYouErrorCode,
  CartaYouErrorInterface,
} from '#app-cartayou/models/cartayou';

export class CartaYouError extends Error {
  errorCode: CartaYouErrorCode;
  errorType: string;

  constructor(errorCode: CartaYouErrorCode, errorType: string) {
    super(errorType);
    this.errorCode = errorCode;
    this.errorType = errorType;
    this.name = 'CartaYouError';
  }

  toJSON(): CartaYouErrorInterface {
    return {
      error_code: this.errorCode,
      error_type: this.errorType,
    };
  }
}

export class CartaYouSetupError extends CartaYouError {
  constructor() {
    super(
      'CARTAYOU_NOT_CONFIGURED',
      'Carta You credentials are not configured',
    );
  }
}

export class AuthFailedError extends CartaYouError {
  constructor(message: string = 'Authentication failed') {
    super('AUTH_FAILED', message);
  }
}

export class SessionExpiredError extends CartaYouError {
  constructor() {
    super('CARTAYOU_SESSION_EXPIRED', 'Session expired. Please log in again.');
  }
}

export class Sms2FARequiredError extends CartaYouError {
  constructor() {
    super('SMS_2FA_REQUIRED', 'SMS 2FA verification is required');
  }
}

export function badRequestVariableError(
  variable: string,
  endpoint: string,
): CartaYouError {
  return new CartaYouError(
    'BAD_REQUEST',
    `Missing required parameter '${variable}' for ${endpoint}`,
  );
}

/**
 * Error handling middleware for Carta You endpoints
 */
export function handleErrorInHandler<T extends keyof CartaYouEndpoints>(
  handler: (req: Request) => Promise<CartaYouEndpoints[T]['response']>,
) {
  return async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const result = await handler(req);
      res.send({ status: 'ok', data: { data: result } });
    } catch (error) {
      if (error instanceof CartaYouError) {
        res.send({ status: 'ok', data: { error: error.toJSON() } });
      } else {
        console.error('Carta You internal error:', error);
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
