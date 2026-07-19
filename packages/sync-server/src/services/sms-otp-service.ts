import { randomBytes } from 'crypto';

import createDebug from 'debug';

import { secretsService } from '#services/secrets-service';

/**
 * Shared SMS-OTP service used by the browser-automation bank integrations
 * (Carta You, TF Bank, ...) whose login requires an SMS verification code
 * forwarded from the user's phone to a `/<bank>/sms-webhook` endpoint.
 *
 * Each bank gets its own instance (own secret + own in-memory OTP store) via
 * `createSmsOtpService`, so codes never cross between banks.
 */
export function createSmsOtpService({
  secretName,
  debugNamespace,
}: {
  secretName: string;
  debugNamespace: string;
}) {
  const debug = createDebug(debugNamespace);

  // In-memory storage for the latest OTP for this bank
  let latestOTP: { code: string | null; timestamp: number; message: string } = {
    code: null,
    timestamp: 0,
    message: '',
  };

  function generateSecret(): string {
    const secret = randomBytes(32).toString('hex');
    secretsService.set(secretName, secret);
    debug('Generated new SMS webhook secret');
    return secret;
  }

  function getSecret(): string | null {
    return secretsService.get(secretName);
  }

  function isConfigured(): boolean {
    return Boolean(getSecret());
  }

  function validateSecret(providedSecret: string): boolean {
    const storedSecret = getSecret();
    if (!storedSecret) return false;
    return providedSecret === storedSecret;
  }

  // Extract the OTP code from an SMS body. Prefer 6-digit codes (most common),
  // fall back to 4-5 digits.
  function extractOTPFromMessage(message: string): string | null {
    const sixDigitMatch = message.match(/\b(\d{6})\b/);
    if (sixDigitMatch) return sixDigitMatch[1];
    const otherMatch = message.match(/\b(\d{4,5})\b/);
    if (otherMatch) return otherMatch[1];
    return null;
  }

  function storeMessage(message: string): {
    success: boolean;
    code: string | null;
  } {
    const code = extractOTPFromMessage(message);
    latestOTP = { code, timestamp: Date.now(), message };
    debug('Stored SMS message, extracted code: %s', code);
    return { success: true, code };
  }

  function getOTP(since: number = 0): {
    code: string | null;
    timestamp: number;
    found: boolean;
  } {
    if (latestOTP.timestamp > since && latestOTP.code) {
      return {
        code: latestOTP.code,
        timestamp: latestOTP.timestamp,
        found: true,
      };
    }
    return { code: null, timestamp: latestOTP.timestamp, found: false };
  }

  function clearOTP(): void {
    latestOTP = { code: null, timestamp: 0, message: '' };
    debug('Cleared stored OTP');
  }

  async function waitForOTP(
    timeoutMs: number = 120000,
    pollIntervalMs: number = 1000,
  ): Promise<string | null> {
    const startTime = Date.now();
    const startTimestamp = latestOTP.timestamp;
    debug('Waiting for OTP (timeout: %dms)', timeoutMs);
    while (Date.now() - startTime < timeoutMs) {
      const result = getOTP(startTimestamp);
      if (result.found && result.code) {
        debug('OTP received: %s', result.code);
        return result.code;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    debug('OTP wait timed out');
    return null;
  }

  return {
    generateSecret,
    getSecret,
    isConfigured,
    validateSecret,
    storeMessage,
    getOTP,
    clearOTP,
    waitForOTP,
  };
}

export type SmsOtpService = ReturnType<typeof createSmsOtpService>;
