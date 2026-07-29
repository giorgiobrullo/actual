import { describe, expect, it, vi } from 'vitest';

import { createSmsOtpService } from './sms-otp-service';

// Partial mock: the shims read SecretName from this module, so only the
// storage side is replaced.
vi.mock('#services/secrets-service', async importOriginal => ({
  ...(await importOriginal<object>()),
  secretsService: { get: () => 'secret', set: vi.fn() },
}));

/**
 * Each bank re-exports the shared SMS-OTP service member by member so its OTP
 * store stays isolated. That is easy to get wrong: adding a member to the
 * service and forgetting a shim leaves `undefined` on the import, which throws
 * only when that bank actually tries to log in -- something no unit test
 * reaches, and typechecking a single package missed.
 */
const shims = {
  tfbank: () => import('#app-tfbank/services/sms-otp-service'),
  cartayou: () => import('#app-cartayou/services/sms-otp-service'),
};

describe('per-bank SMS-OTP shims', () => {
  const expected = Object.keys(
    createSmsOtpService({ secretName: 'x', debugNamespace: 'x' }),
  ).sort();

  for (const [bank, load] of Object.entries(shims)) {
    it(`${bank} re-exports every member of the shared service`, async () => {
      const shim = await load();
      const missing = expected.filter(
        key => typeof (shim as Record<string, unknown>)[key] !== 'function',
      );

      expect(missing).toEqual([]);
    });
  }
});
