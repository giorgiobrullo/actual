import { inspect } from 'util';

import createDebug from 'debug';
import type { Request, Response } from 'express';

import type {
  AmexEndpoints,
  AmexErrorCode,
  AmexErrorInterface,
  AmexResponse,
} from '#app-amex/models/amex';

const debug = createDebug('actual:amex:errors');

export class AmexError extends Error {
  error_code: AmexErrorCode;
  constructor(error_code: AmexErrorCode = 'INTERNAL_ERROR', message?: string) {
    super(message);
    this.error_code = error_code;
  }
  data(): AmexErrorInterface {
    return {
      error_code: this.error_code,
      error_type: this.message ?? '',
    };
  }
}

function makeErrorClass(error_code: AmexErrorCode) {
  return class SpecificAmexError extends AmexError {
    constructor(message?: string) {
      super(error_code, message);
    }
  };
}

export class AmexSetupError extends AmexError {
  constructor(message?: string) {
    super(
      'AMEX_NOT_CONFIGURED',
      message ?? 'Amex credentials are not configured yet.',
    );
  }
}

export const AuthFailedError = makeErrorClass('AMEX_AUTH_FAILED');
export const SessionExpiredError = makeErrorClass('AMEX_SESSION_EXPIRED');
export const TwoFactorRequiredError = makeErrorClass('AMEX_2FA_REQUIRED');
export const BadRequestError = makeErrorClass('BAD_REQUEST');
export const ResourceNotFoundError = makeErrorClass('NOT_FOUND');
export const TimeoutError = makeErrorClass('TIMED_OUT');

export function badRequestVariableError(name: string, endpoint: string) {
  return new BadRequestError(
    `Variable '${name}' not defined and is necessary for '${endpoint}'.`,
  );
}

export function handleErrorInHandler<T extends keyof AmexEndpoints>(
  func: (req: Request) => Promise<AmexEndpoints[T]['response']> | never,
) {
  return (
    req: Request,
    res: Response<{ status: 'ok'; data: AmexResponse<T> }>,
  ) => {
    // Makes sure we respond with a valid JSON Response
    func(req)
      .then(data => {
        res.send({
          status: 'ok',
          data: { data },
        });
      })
      .catch(err => {
        if (!(err instanceof AmexError)) {
          debug(
            'Error in Amex %s: %s',
            req.originalUrl,
            inspect(err, { depth: null }),
          );
          err = new AmexError(
            'INTERNAL_ERROR',
            err.message ?? 'Something went wrong while using the Amex API.',
          );
        }
        debug('Returning error: %o', err.data());
        res.send({
          status: 'ok',
          data: { error: err.data() },
        });
      });
  };
}
