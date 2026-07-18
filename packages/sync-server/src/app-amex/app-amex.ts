import express from 'express';
import type { Express, Request, Router } from 'express';

import {
  configureCaptchaService,
  isCaptchaServiceConfigured,
  testCaptchaApiKey,
} from '#services/captcha-service';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';

import type {
  AmexEndpoints,
  ConfigureBody,
  DebugImapBody,
  TestImapBody,
  TestProxyBody,
  TransactionsBody,
} from './models/amex';
import { getCachedAccounts, performLogin } from './services/amex-auth';
import * as amexServices from './services/amex-services';
import {
  debugCheckAmexEmails,
  testImapConnection,
} from './services/imap-service';
import {
  AmexSetupError,
  BadRequestError,
  badRequestVariableError,
  handleErrorInHandler,
} from './utils/errors';

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
 * Configure Amex credentials (username/password) and optionally IMAP, proxy, and captcha.
 * If credentials are already configured, you can omit username/password to only update
 * proxy or captcha settings.
 */
post('/configure', async req => {
  const body = req.body as ConfigureBody;

  // Check if we need to update credentials
  const hasCredentials = body.username && body.password;
  const isAlreadyConfigured = amexServices.isConfigured();

  // Require credentials if not already configured
  if (!hasCredentials && !isAlreadyConfigured) {
    if (!body.username) {
      throw badRequestVariableError('username', '/configure');
    }
    if (!body.password) {
      throw badRequestVariableError('password', '/configure');
    }
  }

  // Configure credentials and IMAP if provided
  if (hasCredentials) {
    amexServices.configure(body.username!, body.password!, body.imap);
  }

  // Configure proxy if provided
  if (body.proxy !== undefined) {
    amexServices.configureProxy(body.proxy);
  }

  // Configure captcha API key if provided
  if (body.captchaApiKey !== undefined) {
    if (body.captchaApiKey) {
      configureCaptchaService(body.captchaApiKey);
    } else {
      // null means clear the captcha config
      configureCaptchaService('');
    }
  }
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
    proxyConfigured: amexServices.isProxyConfigured(),
  };
});

/**
 * POST /test-captcha
 * Test 2Captcha API key by checking balance
 */
post('/test-captcha', async req => {
  const { apiKey } = req.body as { apiKey?: string };

  if (!apiKey) {
    throw badRequestVariableError('apiKey', '/test-captcha');
  }

  const result = await testCaptchaApiKey(apiKey);

  if (!result.success) {
    throw new BadRequestError(result.error || 'Invalid API key');
  }

  return { success: true, balance: result.balance };
});

/**
 * POST /test-proxy
 * Test proxy connection by fetching external IP
 */
post('/test-proxy', async req => {
  const body = req.body as TestProxyBody;

  if (!body.proxy) {
    throw badRequestVariableError('proxy', '/test-proxy');
  }

  const result = await amexServices.testProxy(body.proxy);
  return result;
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
