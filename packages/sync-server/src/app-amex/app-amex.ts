import express, { type Express, type Request, type Router } from 'express';

import {
  configureCaptchaService,
  isCaptchaServiceConfigured,
  testCaptchaApiKey,
} from '../services/captcha-service.js';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '../util/middlewares.js';

import {
  type AmexEndpoints,
  type ConfigureBody,
  type DebugImapBody,
  type TestImapBody,
  type TransactionsBody,
} from './models/amex.js';
import { getCachedAccounts, performLogin } from './services/amex-auth.js';
import * as amexServices from './services/amex-services.js';
import {
  debugCheckAmexEmails,
  testImapConnection,
} from './services/imap-service.js';
import {
  AmexSetupError,
  badRequestVariableError,
  handleErrorInHandler,
} from './utils/errors.js';

const app: Express = express();

app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);
app.use(express.json());

/**
 * Helper to create typed POST handlers
 */
function post<T extends keyof AmexEndpoints>(
  endpoint: T,
  handler: (
    req: Request<unknown, unknown, AmexEndpoints[T]['body']>,
  ) => Promise<AmexEndpoints[T]['response']>,
) {
  app.post(
    endpoint,
    handleErrorInHandler<T>(
      handler as (req: Request) => Promise<AmexEndpoints[T]['response']>,
    ),
  );
}

/**
 * POST /configure
 * Configure Amex credentials (username/password) and optionally IMAP for 2FA
 */
post('/configure', async req => {
  const body = req.body as ConfigureBody;

  if (!body.username) {
    throw badRequestVariableError('username', '/configure');
  }
  if (!body.password) {
    throw badRequestVariableError('password', '/configure');
  }

  amexServices.configure(body.username, body.password, body.imap);

  // Optionally test the credentials by attempting login
  // This is commented out for now as it adds latency
  // await performLogin();
});

/**
 * POST /status
 * Check if Amex is configured and has active session
 */
post('/status', async () => {
  const status = amexServices.getStatus();
  return {
    configured: status.configured,
    lastLogin: status.hasSession ? new Date().toISOString() : undefined,
    captchaSolverConfigured: isCaptchaServiceConfigured(),
  };
});

/**
 * POST /configure-captcha
 * Configure 2Captcha API key for solving CAPTCHAs
 */
app.post('/configure-captcha', (req, res) => {
  const { apiKey } = req.body as { apiKey?: string };

  if (!apiKey) {
    return res.status(400).json({
      error: { error_code: 'BAD_REQUEST', error_type: 'Missing apiKey' },
    });
  }

  configureCaptchaService(apiKey);
  return res.json({ data: { success: true } });
});

/**
 * POST /test-captcha
 * Test 2Captcha API key by checking balance
 */
app.post('/test-captcha', async (req, res) => {
  const { apiKey } = req.body as { apiKey?: string };

  if (!apiKey) {
    return res.status(400).json({
      error: { error_code: 'BAD_REQUEST', error_type: 'Missing apiKey' },
    });
  }

  const result = await testCaptchaApiKey(apiKey);

  if (!result.success) {
    return res.status(400).json({
      error: { error_code: 'BAD_REQUEST', error_type: result.error },
    });
  }

  return res.json({ data: { success: true, balance: result.balance } });
});

/**
 * POST /login
 * Perform login and return accounts
 */
post('/login', async () => {
  if (!amexServices.isConfigured()) {
    throw new AmexSetupError();
  }

  // Perform login (this also discovers accounts via response interception)
  await performLogin();

  // Get accounts from the cached session (discovered during login)
  const accounts = getCachedAccounts();

  return {
    success: true,
    accounts,
  };
});

/**
 * POST /accounts
 * Get list of linked Amex accounts
 */
post('/accounts', async () => {
  if (!amexServices.isConfigured()) {
    throw new AmexSetupError();
  }

  // Return accounts from the cached session (discovered during login)
  return getCachedAccounts();
});

/**
 * POST /transactions
 * Fetch transactions for an account
 */
post('/transactions', async req => {
  const body = req.body as TransactionsBody;

  if (!body.account_token) {
    throw badRequestVariableError('account_token', '/transactions');
  }

  const transactions = await amexServices.getTransactions(
    body.account_token,
    body.startDate,
    body.endDate,
  );

  return {
    transactions,
  };
});

/**
 * POST /debug-imap
 * Debug endpoint to check recent emails and see what's in the inbox
 */
post('/debug-imap', async req => {
  const body = req.body as DebugImapBody;

  if (!body.host) {
    throw badRequestVariableError('host', '/debug-imap');
  }
  if (!body.user) {
    throw badRequestVariableError('user', '/debug-imap');
  }
  if (!body.password) {
    throw badRequestVariableError('password', '/debug-imap');
  }

  const result = await debugCheckAmexEmails({
    host: body.host,
    port: body.port,
    user: body.user,
    password: body.password,
    folder: body.folder,
  });
  return result;
});

/**
 * POST /test-imap
 * Test IMAP connection with provided credentials
 */
post('/test-imap', async req => {
  const body = req.body as TestImapBody;

  if (!body.host) {
    throw badRequestVariableError('host', '/test-imap');
  }
  if (!body.user) {
    throw badRequestVariableError('user', '/test-imap');
  }
  if (!body.password) {
    throw badRequestVariableError('password', '/test-imap');
  }

  const result = await testImapConnection({
    host: body.host,
    port: body.port,
    user: body.user,
    password: body.password,
  });

  return result;
});

/**
 * POST /deconfigure
 * Clear Amex credentials
 */
app.post(
  '/deconfigure',
  handleErrorInHandler<'/configure'>(async () => {
    amexServices.deconfigure();
  }),
);

export const handlers: Router = app;
