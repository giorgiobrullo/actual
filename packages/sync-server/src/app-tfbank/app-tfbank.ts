import express from 'express';
import type { Express, Request, Router } from 'express';

import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import type {
  ConfigureBody,
  TFBankEndpoints,
  TransactionsBody,
} from './models/tfbank';
import * as smsOtpService from './services/sms-otp-service';
import { getCachedAccounts, performLogin } from './services/tfbank-auth';
import * as tfbankServices from './services/tfbank-services';
import {
  badRequestVariableError,
  handleErrorInHandler,
  TFBankSetupError,
} from './utils/errors';

const app: Express = express();

app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(express.text()); // Also accept text/plain

// ============================================
// UNAUTHENTICATED ENDPOINTS (before session middleware)
// ============================================

/**
 * POST /sms-webhook
 * Receive SMS from iOS Shortcuts (unauthenticated, validates via shared secret)
 */
app.post('/sms-webhook', (req, res) => {
  console.log('TF Bank SMS webhook received:', {
    contentType: req.headers['content-type'],
    bodyType: typeof req.body,
    body: req.body,
  });

  const { body: messageBody, secret } = req.body as {
    body?: string;
    secret?: string;
  };

  // Validate the shared secret
  if (!secret || !smsOtpService.validateSecret(secret)) {
    res.status(401).json({ error: 'Invalid or missing secret' });
    return;
  }

  if (!messageBody) {
    res.status(400).json({
      error: 'Missing message body',
      received: req.body,
      hint: 'Make sure Content-Type is application/json and body contains { "body": "...", "secret": "..." }',
    });
    return;
  }

  const result = smsOtpService.storeMessage(messageBody);
  res.json({ ok: true, code: result.code });
});

// ============================================
// AUTHENTICATED ENDPOINTS (after session middleware)
// ============================================

app.use(validateSessionMiddleware);

/**
 * Helper to create typed POST handlers
 */
function post<T extends keyof TFBankEndpoints>(
  endpoint: T,
  handler: (
    req: Request<unknown, unknown, TFBankEndpoints[T]['body']>,
  ) => Promise<TFBankEndpoints[T]['response']>,
) {
  app.post(
    endpoint,
    handleErrorInHandler<T>(
      handler as (req: Request) => Promise<TFBankEndpoints[T]['response']>,
    ),
  );
}

/**
 * POST /configure
 * Configure TF Bank credentials (email/password)
 */
post('/configure', async req => {
  const body = req.body as ConfigureBody;

  if (!body.username) {
    throw badRequestVariableError('username', '/configure');
  }
  if (!body.password) {
    throw badRequestVariableError('password', '/configure');
  }

  tfbankServices.configure(body.username, body.password);
});

/**
 * POST /status
 * Check if TF Bank is configured and has an active session
 */
post('/status', async () => {
  const status = tfbankServices.getStatus();
  return {
    configured: status.configured,
    lastLogin: status.hasSession ? new Date().toISOString() : undefined,
  };
});

/**
 * POST /login
 * Perform login and return accounts
 */
post('/login', async () => {
  if (!tfbankServices.isConfigured()) {
    throw new TFBankSetupError();
  }

  // Perform login (this also discovers accounts via GetCreditLimits)
  await performLogin();

  const accounts = getCachedAccounts();

  return {
    success: true,
    accounts,
  };
});

/**
 * POST /accounts
 * Get list of linked TF Bank accounts
 */
post('/accounts', async () => {
  if (!tfbankServices.isConfigured()) {
    throw new TFBankSetupError();
  }

  return getCachedAccounts();
});

/**
 * POST /transactions
 * Fetch transactions (and invoices) for an account
 */
post('/transactions', async req => {
  const body = req.body as TransactionsBody;

  if (!body.account_id) {
    throw badRequestVariableError('account_id', '/transactions');
  }

  const transactions = await tfbankServices.getTransactions(
    body.account_id,
    body.startDate,
    body.endDate,
  );

  return {
    transactions,
  };
});

/**
 * POST /deconfigure
 * Clear TF Bank credentials
 */
app.post(
  '/deconfigure',
  handleErrorInHandler<'/configure'>(async () => {
    tfbankServices.deconfigure();
  }),
);

/**
 * POST /sms-setup
 * Generate a new shared secret and return setup instructions
 */
post('/sms-setup', async _req => {
  const secret = smsOtpService.generateSecret();
  const isConfigured = smsOtpService.isConfigured();

  return {
    secret,
    configured: isConfigured,
  };
});

/**
 * POST /sms-status
 * Check if SMS webhook is configured
 */
post('/sms-status', async () => {
  return {
    configured: smsOtpService.isConfigured(),
  };
});

/**
 * POST /otp
 * Poll for the latest OTP code
 */
post('/otp', async req => {
  const { since } = req.body as { since?: number };
  const result = smsOtpService.getOTP(since ?? 0);

  return {
    code: result.code,
    timestamp: result.timestamp,
    found: result.found,
  };
});

/**
 * POST /otp-clear
 * Clear the stored OTP after successful use
 */
post('/otp-clear', async () => {
  smsOtpService.clearOTP();
  return { success: true };
});

export const handlers: Router = app;
