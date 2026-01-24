import * as asyncStorage from '../../platform/server/asyncStorage';
import { logger } from '../../platform/server/log';
import { type AmexEndpoints, type AmexResponse } from '../../types/models/amex';
import { createApp } from '../app';
import { BankSyncError } from '../errors';
import { post as _post } from '../post';
import { getServer } from '../server-config';

type AE = AmexEndpoints;

type KeysRequiringBody = {
  [K in keyof AE]: [AE[K]['body']] extends [undefined] ? never : K;
}[keyof AE];

type KeysWithoutBody = {
  [K in keyof AE]: [AE[K]['body']] extends [undefined] ? K : never;
}[keyof AE];

function post<T extends KeysRequiringBody>(
  path: T,
  body: AE[T]['body'],
): Promise<AmexResponse<T>>;
function post<T extends KeysWithoutBody>(path: T): Promise<AmexResponse<T>>;

async function post(path: keyof AE, body?: unknown) {
  const userToken = await asyncStorage.getItem('user-token');
  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return await _post(serverConfig.AMEX_SERVER + path, body, {
    'X-ACTUAL-TOKEN': userToken,
  });
}

async function configure({
  username,
  password,
  imap,
}: {
  username: string | null;
  password: string | null;
  imap?: {
    host: string;
    port?: number;
    user: string;
    password: string;
  };
}) {
  return await post('/configure', {
    username,
    password,
    imap,
  });
}

async function getStatus() {
  return await post('/status');
}

async function login() {
  return await post('/login');
}

async function getAccounts() {
  return await post('/accounts');
}

async function deconfigure() {
  return await post('/deconfigure');
}

async function testImap({
  host,
  port,
  user,
  password,
}: {
  host: string;
  port?: number;
  user: string;
  password: string;
}) {
  return await post('/test-imap', {
    host,
    port,
    user,
    password,
  });
}

async function debugImap({
  host,
  port,
  user,
  password,
  folder,
}: {
  host: string;
  port?: number;
  user: string;
  password: string;
  folder?: string;
}) {
  return await post('/debug-imap', {
    host,
    port,
    user,
    password,
    folder,
  });
}

export async function downloadAmexTransactions(
  accountToken: string,
  startDate: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log(`Pulling transactions from Amex since ${startDate}`);

  const { error, data } = await post('/transactions', {
    account_token: accountToken,
    startDate,
  });

  if (error) {
    logger.log('got error', error);
    throw new BankSyncError(
      error.error_type,
      error.error_code,
      error.error_code,
    );
  }

  return data;
}

export type AccountHandlers = {
  'amex-configure': typeof configure;
  'amex-status': typeof getStatus;
  'amex-login': typeof login;
  'amex-accounts': typeof getAccounts;
  'amex-deconfigure': typeof deconfigure;
  'amex-test-imap': typeof testImap;
  'amex-debug-imap': typeof debugImap;
};

export const app = createApp<AccountHandlers>();
app.method('amex-configure', configure);
app.method('amex-status', getStatus);
app.method('amex-login', login);
app.method('amex-accounts', getAccounts);
app.method('amex-deconfigure', deconfigure);
app.method('amex-test-imap', testImap);
app.method('amex-debug-imap', debugImap);
