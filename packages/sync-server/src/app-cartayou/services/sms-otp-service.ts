import { SecretName } from '#services/secrets-service';
import { createSmsOtpService } from '#services/sms-otp-service';

// Carta You's SMS-OTP handling is the shared service bound to Carta You's
// secret and debug namespace. Re-exported member-by-member so existing
// imports (`import * as smsOtpService from './sms-otp-service'`) keep working.
const service = createSmsOtpService({
  secretName: SecretName.cartayou_sms_secret,
  debugNamespace: 'actual:cartayou:sms-otp',
});

export const generateSecret = service.generateSecret;
export const getSecret = service.getSecret;
export const isConfigured = service.isConfigured;
export const validateSecret = service.validateSecret;
export const storeMessage = service.storeMessage;
export const getOTP = service.getOTP;
export const clearOTP = service.clearOTP;
export const beginAttempt = service.beginAttempt;
export const waitForOTP = service.waitForOTP;
