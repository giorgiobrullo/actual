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

  // Counts login attempts. A counter rather than a clock: attempts can start in
  // the same millisecond as a message arrives, and "which attempt was this code
  // issued for" is exactly what needs deciding. Zero means no attempt has
  // declared itself, in which case any code is accepted.
  let attemptEpoch = 0;

  // The attempt each code value was *first* seen during, and when. Phones
  // re-deliver the same SMS (a retried Shortcut, a duplicate webhook), and a
  // re-delivery must not make an old code look freshly minted, so neither is
  // refreshed on repeat.
  const firstSeen = new Map<string, { epoch: number; at: number }>();

  // Codes already handed to a caller. A code is single-use: the bank invalidates
  // it once redeemed, so serving it twice can only produce a failed login.
  const consumed = new Set<string>();

  // Codes are short-lived; anything older than this cannot be relevant, and
  // forgetting it keeps the maps from growing for the process lifetime.
  const CODE_MEMORY_MS = 30 * 60 * 1000;

  function forgetOldCodes(): void {
    const cutoff = Date.now() - CODE_MEMORY_MS;
    for (const [code, seen] of firstSeen) {
      if (seen.at < cutoff) {
        firstSeen.delete(code);
        consumed.delete(code);
      }
    }
  }

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
    const now = Date.now();

    const repeat = Boolean(code && firstSeen.has(code));
    if (code && !repeat) {
      firstSeen.set(code, { epoch: attemptEpoch, at: now });
    }
    latestOTP = { code, timestamp: now, message };
    forgetOldCodes();

    debug(
      'Stored SMS message, extracted code: %s%s',
      code,
      repeat ? ' (re-delivery of a code we have already seen)' : '',
    );
    return { success: true, code };
  }

  /**
   * Mark the start of a login attempt, immediately before the step that makes
   * the bank send the SMS.
   *
   * Without this, an attempt can pick up a code minted for an earlier one: a
   * code that arrives too late to be used, then gets re-delivered by the phone
   * during the next attempt, looks new by arrival time but is tied to the
   * previous session and fails at redemption.
   */
  function beginAttempt(): void {
    attemptEpoch += 1;
    latestOTP = { code: null, timestamp: 0, message: '' };
    debug(
      'Login attempt %d started; ignoring codes from earlier ones',
      attemptEpoch,
    );
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

  /**
   * Wait for a code that belongs to the current login attempt.
   *
   * A code qualifies only if it was first seen during the attempt opened by
   * {@link beginAttempt} and has not already been handed out. Arrival time
   * alone is not enough: a re-delivered SMS arrives now but carries a code
   * minted for an earlier session, which the bank will refuse.
   */
  async function waitForOTP(
    timeoutMs: number = 120000,
    pollIntervalMs: number = 1000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let rejected: string | null = null;

    debug('Waiting for OTP (timeout: %dms)', timeoutMs);
    while (Date.now() < deadline) {
      const code = latestOTP.code;

      if (code && !consumed.has(code)) {
        if ((firstSeen.get(code)?.epoch ?? 0) === attemptEpoch) {
          consumed.add(code);
          debug('OTP received: %s', code);
          return code;
        }
        // Logged once per code so a stale one does not fill the log while we
        // keep waiting for the real thing.
        if (rejected !== code) {
          rejected = code;
          debug('Ignoring %s: it was issued before this attempt started', code);
        }
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
    beginAttempt,
    waitForOTP,
  };
}

export type SmsOtpService = ReturnType<typeof createSmsOtpService>;
