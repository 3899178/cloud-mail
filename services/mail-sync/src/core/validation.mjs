import { fail } from '../../../../shared/unified-mail/index.mjs';
export function text(value, max = 1024, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || Buffer.byteLength(value) > max || value.includes('\0')) fail('INVALID_INPUT');
  return value;
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT');
  return value;
}
export function choice(value, allowed) { if (!allowed.includes(value)) fail('INVALID_INPUT'); return value; }
// Never persist a provider exception/message in an error DTO.
export function errorCode(value) {
  if (value == null) return null;
  return choice(value, ['AUTH_REQUIRED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'STORAGE_FULL', 'SYNC_FAILED', 'SEND_UNCERTAIN', 'RESYNC_REQUIRED', 'CAPACITY_EXCEEDED']);
}
