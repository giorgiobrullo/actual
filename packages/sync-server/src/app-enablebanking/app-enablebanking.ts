import express, { type Request } from 'express';
import { type ParamsDictionary } from 'express-serve-static-core';

import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '../util/middlewares.js';

import { type EnableBankingEndpoints } from './models/enablebanking.js';
import { enableBankingservice } from './services/enablebanking-services.js';
import {
  BadRequestError,
  badRequestVariableError,
  handleErrorInHandler,
  NotReadyError,
} from './utils/errors.js';
const app = express();
app.use(requestLoggerMiddleware);
export { app as handlers };

app.use(express.json());
app.use(validateSessionMiddleware);

function post<T extends keyof EnableBankingEndpoints>(
  path: T,
  handler: (
    req: Request<
      ParamsDictionary,
      EnableBankingEndpoints[T]['response'],
      EnableBankingEndpoints[T]['body']
    >,
  ) => Promise<EnableBankingEndpoints[T]['response']>,
) {
  app.post(path, handleErrorInHandler<T>(handler));
}
post('/configure', async req => {
  const { applicationId, secret } = req.body;

  await enableBankingservice.setupSecrets(applicationId, secret);
  return;
});

post('/status', async () => {
  const data = {
    configured: await enableBankingservice.isConfigured(),
  };
  return data;
});

post('/countries', async () => {
  const application = await enableBankingservice.getApplication();
  return application.countries;
});

post('/get_aspsps', async req => {
  const { country } = req.body;
  const responseData = (await enableBankingservice.getASPSPs(country)).aspsps;
  return responseData;
});

post('/start_auth', async (req: Request) => {
  const { aspsp, country } = req.body;

  const origin = req.headers.origin;
  if (!origin) {
    throw new BadRequestError(
      "'origin' header should be passed to '/start_auth'.",
    );
  }
  return await enableBankingservice.startAuth(
    country,
    aspsp,
    origin,
    180 * 24 * 3600,
  );
});

post('/get_session', async (req: Request) => {
  const { state } = req.body;
  if (!state) {
    throw new BadRequestError(
      "Variable 'state' should be passed to '/enable_banking/get_session'.",
    );
  }

  const session_id = enableBankingservice.getSessionIdFromState(state);
  if (!session_id) {
    throw new NotReadyError('Authorization flow has not yet finished.');
  }
  return await enableBankingservice.getAccounts(session_id);
});

post('/complete_auth', async (req: Request) => {
  const { state, code } = req.body;

  if (!state) {
    throw badRequestVariableError('state', '/enable_banking/complete_auth');
  }

  if (!code) {
    throw badRequestVariableError('code', '/enable_banking/complete_auth');
  }

  await enableBankingservice.authorizeSession(state, code);

  return;
});

post('/get_accounts', async (req: Request) => {
  const { session_id } = req.body;

  if (!session_id) {
    throw badRequestVariableError('session_id', '/enable_banking/get_accounts');
  }

  return await enableBankingservice.getAccounts(session_id);
});

post('/transactions', async (req: Request) => {
  const { startDate, endDate, account_id, bank_id, isInitialSync } = req.body;

  if (!account_id) {
    throw badRequestVariableError('account_id', '/enablebanking/transactions');
  }

  let transactions;
  if (isInitialSync) {
    // For initial sync: use strategy=longest to get all historical data,
    // then also fetch with default strategy to get pending transactions
    // (strategy=longest doesn't return pending transactions)
    const [historicalTransactions, pendingTransactions] = await Promise.all([
      enableBankingservice.getTransactions(
        account_id,
        startDate,
        endDate,
        bank_id,
        'longest',
      ),
      enableBankingservice.getTransactions(
        account_id,
        startDate,
        endDate,
        bank_id,
        // No strategy = default, which returns pending transactions
      ),
    ]);

    // Merge and deduplicate by transaction date+amount+payeeName
    // (since transaction IDs from different strategies might differ)
    const seen = new Set<string>();
    transactions = [];

    for (const tx of [...historicalTransactions, ...pendingTransactions]) {
      const key = `${tx.date}|${tx.amount}|${tx.payeeName}`;
      if (!seen.has(key)) {
        seen.add(key);
        transactions.push(tx);
      }
    }
  } else {
    transactions = await enableBankingservice.getTransactions(
      account_id,
      startDate,
      endDate,
      bank_id,
    );
  }

  const currentBalance =
    await enableBankingservice.getCurrentBalance(account_id);

  const startingBalance = transactions.reduce(
    (acc, t) => acc - t.amount,
    currentBalance,
  );

  return {
    transactions,
    startingBalance: Math.round(startingBalance * 100), // We are sending cents because that is how it is stored in the DB.
  };
});
