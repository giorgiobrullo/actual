import { randomBytes } from 'crypto';

import createDebug from 'debug';

import { SecretName, secretsService } from '#services/secrets-service';

const debug = createDebug('actual:cartayou:sms-otp');

// In-memory storage for latest OTP
let latestOTP: { code: string | null; timestamp: number; message: string } = {
  code: null,
  timestamp: 0,
  message: '',
};

/**
 * Generate a new shared secret for SMS webhook authentication
 */
export function generateSecret(): string {
  const secret = randomBytes(32).toString('hex');
  secretsService.set(SecretName.cartayou_sms_secret, secret);
  debug('Generated new SMS webhook secret');
  return secret;
}

/**
 * Get the current shared secret
 */
export function getSecret(): string | null {
  return secretsService.get(SecretName.cartayou_sms_secret);
}

/**
 * Check if SMS webhook is configured
 */
export function isConfigured(): boolean {
  return Boolean(getSecret());
}

/**
 * Validate the shared secret from a webhook request
 */
export function validateSecret(providedSecret: string): boolean {
  const storedSecret = getSecret();
  if (!storedSecret) return false;
  return providedSecret === storedSecret;
}

/**
 * Extract OTP code from SMS message body
 * Carta You typically sends 6-digit codes
 */
function extractOTPFromMessage(message: string): string | null {
  // Look for 6-digit codes first (most common)
  const sixDigitMatch = message.match(/\b(\d{6})\b/);
  if (sixDigitMatch) {
    return sixDigitMatch[1];
  }

  // Fall back to 4-5 digit codes
  const otherMatch = message.match(/\b(\d{4,5})\b/);
  if (otherMatch) {
    return otherMatch[1];
  }

  return null;
}

/**
 * Store an incoming SMS message and extract OTP
 */
export function storeMessage(message: string): {
  success: boolean;
  code: string | null;
} {
  const code = extractOTPFromMessage(message);

  latestOTP = {
    code,
    timestamp: Date.now(),
    message,
  };

  debug('Stored SMS message, extracted code: %s', code);

  return { success: true, code };
}

/**
 * Get the latest OTP if it's newer than the provided timestamp
 */
export function getOTP(since: number = 0): {
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

  return {
    code: null,
    timestamp: latestOTP.timestamp,
    found: false,
  };
}

/**
 * Clear the stored OTP (after successful use)
 */
export function clearOTP(): void {
  latestOTP = { code: null, timestamp: 0, message: '' };
  debug('Cleared stored OTP');
}

/**
 * Wait for an OTP to arrive within the timeout period
 * Polls every second
 */
export async function waitForOTP(
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
