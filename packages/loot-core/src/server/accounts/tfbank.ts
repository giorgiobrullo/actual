import * as asyncStorage from '#platform/server/asyncStorage';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { BankSyncError } from '#server/errors';
import { post as _post } from '#server/post';
import { getServer } from '#server/server-config';
import type { TFBankEndpoints, TFBankResponse } from '#types/models/tfbank';

type TF = TFBankEndpoints;

type KeysRequiringBody = {
  [K in keyof TF]: [TF[K]['body']] extends [undefined] ? never : K;
}[keyof TF];

type KeysWithoutBody = {
  [K in keyof TF]: [TF[K]['body']] extends [undefined] ? K : never;
}[keyof TF];

function post<T extends KeysRequiringBody>(
  path: T,
  body: TF[T]['body'],
): Promise<TFBankResponse<T>>;
function post<T extends KeysWithoutBody>(path: T): Promise<TFBankResponse<T>>;

async function post(path: keyof TF, body?: unknown) {
  const userToken = await asyncStorage.getItem('user-token');
  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return await _post(serverConfig.TFBANK_SERVER + path, body, {
    'X-ACTUAL-TOKEN': userToken,
  });
}

async function configure({
  username,
  password,
}: {
  username: string | null;
  password: string | null;
}) {
  return await post('/configure', {
    username,
    password,
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

async function smsSetup() {
  return await post('/sms-setup');
}

async function smsStatus() {
  return await post('/sms-status');
}

async function getOtp({ since }: { since?: number } = {}) {
  return await post('/otp', { since });
}

async function clearOtp() {
  return await post('/otp-clear');
}

export async function downloadTFBankTransactions(
  accountId: string,
  startDate: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log(`Pulling transactions from TF Bank since ${startDate}`);

  const { error, data } = await post('/transactions', {
    account_id: accountId,
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

export type TFBankHandlers = {
  'tfbank-configure': typeof configure;
  'tfbank-status': typeof getStatus;
  'tfbank-login': typeof login;
  'tfbank-accounts': typeof getAccounts;
  'tfbank-deconfigure': typeof deconfigure;
  'tfbank-sms-setup': typeof smsSetup;
  'tfbank-sms-status': typeof smsStatus;
  'tfbank-otp': typeof getOtp;
  'tfbank-otp-clear': typeof clearOtp;
};

export const app = createApp<TFBankHandlers>();
app.method('tfbank-configure', configure);
app.method('tfbank-status', getStatus);
app.method('tfbank-login', login);
app.method('tfbank-accounts', getAccounts);
app.method('tfbank-deconfigure', deconfigure);
app.method('tfbank-sms-setup', smsSetup);
app.method('tfbank-sms-status', smsStatus);
app.method('tfbank-otp', getOtp);
app.method('tfbank-otp-clear', clearOtp);
