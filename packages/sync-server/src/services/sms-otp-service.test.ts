import { describe, expect, it, vi } from 'vitest';

import { createSmsOtpService } from './sms-otp-service';

vi.mock('#services/secrets-service', () => ({
  secretsService: { get: () => 'secret', set: vi.fn() },
}));

function makeService() {
  return createSmsOtpService({
    secretName: 'test_sms_secret',
    debugNamespace: 'test:sms-otp',
  });
}

describe('sms-otp-service', () => {
  it('accepts a code that arrives during the attempt', async () => {
    const service = makeService();
    service.beginAttempt();
    service.storeMessage('Your code is 123456');

    await expect(service.waitForOTP(500, 10)).resolves.toBe('123456');
  });

  it('accepts a code that arrived after the attempt began but before the wait', async () => {
    // Carta You reaches its OTP field only after a page navigation, so the SMS
    // routinely lands before anything starts waiting for it.
    const service = makeService();
    service.beginAttempt();
    service.storeMessage('Your code is 123456');
    await new Promise(resolve => setTimeout(resolve, 20));

    await expect(service.waitForOTP(500, 10)).resolves.toBe('123456');
  });

  it('ignores a code left over from a previous attempt, even if re-delivered', async () => {
    // The regression this was written for: an attempt times out, its SMS lands
    // late, the phone forwards it again during the next attempt, and the old
    // code gets redeemed against a new session -- which the bank rejects.
    const service = makeService();

    service.beginAttempt();
    expect(await service.waitForOTP(30, 10)).toBeNull();
    service.storeMessage('Your code is 111111');

    service.beginAttempt();
    service.storeMessage('Your code is 111111');

    expect(await service.waitForOTP(60, 10)).toBeNull();
  });

  it('still accepts a genuinely new code after a stale one was re-delivered', async () => {
    const service = makeService();

    service.beginAttempt();
    expect(await service.waitForOTP(30, 10)).toBeNull();
    service.storeMessage('Your code is 111111');

    service.beginAttempt();
    service.storeMessage('Your code is 111111');
    service.storeMessage('Your code is 222222');

    await expect(service.waitForOTP(60, 10)).resolves.toBe('222222');
  });

  it('never hands out the same code twice', async () => {
    const service = makeService();

    service.beginAttempt();
    service.storeMessage('Your code is 123456');
    expect(await service.waitForOTP(60, 10)).toBe('123456');

    // A re-delivery of the code we just redeemed is worthless: it is single-use.
    service.beginAttempt();
    service.storeMessage('Your code is 123456');
    expect(await service.waitForOTP(60, 10)).toBeNull();
  });

  it('accepts any code when no attempt has been declared', async () => {
    // Keeps the HTTP /otp route and any caller that never calls beginAttempt()
    // behaving as before.
    const service = makeService();
    service.storeMessage('Your code is 654321');

    await expect(service.waitForOTP(60, 10)).resolves.toBe('654321');
  });

  it('prefers a six digit code over shorter runs of digits', async () => {
    const service = makeService();
    service.beginAttempt();
    service.storeMessage('TF Bank: 12 is your bank id, code 987654');

    await expect(service.waitForOTP(60, 10)).resolves.toBe('987654');
  });
});
