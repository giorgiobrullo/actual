import * as asyncStorage from '#platform/server/asyncStorage';
import { logger } from '#platform/server/log';
import { createApp } from '#server/app';
import { BankSyncError } from '#server/errors';
import { post as _post } from '#server/post';
import { getServer } from '#server/server-config';
import type {
  CartaYouEndpoints,
  CartaYouResponse,
} from '#types/models/cartayou';

type CY = CartaYouEndpoints;

type KeysRequiringBody = {
  [K in keyof CY]: [CY[K]['body']] extends [undefined] ? never : K;
}[keyof CY];

type KeysWithoutBody = {
  [K in keyof CY]: [CY[K]['body']] extends [undefined] ? K : never;
}[keyof CY];

function post<T extends KeysRequiringBody>(
  path: T,
  body: CY[T]['body'],
): Promise<CartaYouResponse<T>>;
function post<T extends KeysWithoutBody>(path: T): Promise<CartaYouResponse<T>>;

async function post(path: keyof CY, body?: unknown) {
  const userToken = await asyncStorage.getItem('user-token');
  const serverConfig = getServer();
  if (!serverConfig) {
    throw new Error('Failed to get server config.');
  }

  return await _post(serverConfig.CARTAYOU_SERVER + path, body, {
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

export async function downloadCartaYouTransactions(
  accountId: string,
  startDate: string,
) {
  const userToken = await asyncStorage.getItem('user-token');
  if (!userToken) return;

  logger.log(`Pulling transactions from Carta You since ${startDate}`);

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

export type CartaYouHandlers = {
  'cartayou-configure': typeof configure;
  'cartayou-status': typeof getStatus;
  'cartayou-login': typeof login;
  'cartayou-accounts': typeof getAccounts;
  'cartayou-deconfigure': typeof deconfigure;
  'cartayou-sms-setup': typeof smsSetup;
  'cartayou-sms-status': typeof smsStatus;
  'cartayou-otp': typeof getOtp;
  'cartayou-otp-clear': typeof clearOtp;
};

export const app = createApp<CartaYouHandlers>();
app.method('cartayou-configure', configure);
app.method('cartayou-status', getStatus);
app.method('cartayou-login', login);
app.method('cartayou-accounts', getAccounts);
app.method('cartayou-deconfigure', deconfigure);
app.method('cartayou-sms-setup', smsSetup);
app.method('cartayou-sms-status', smsStatus);
app.method('cartayou-otp', getOtp);
app.method('cartayou-otp-clear', clearOtp);
