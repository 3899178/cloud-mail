// Runtime-neutral contracts: safe for Cloudflare Workers and browsers. No storage or Node imports.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export class MailError extends Error {
  constructor(code) { super(code); this.name = 'MailError'; this.code = code; }
}
export function fail(code) { throw new MailError(code); }
export function identifier(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(code);
  return value;
}
function base64(bytes) {
  let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unbase64(text) {
  if (typeof text !== 'string' || !/^[\w-]+$/.test(text) || text.length > 8192) throw new Error();
  const raw = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error();
  return bytes;
}
function encode(value) { return base64(encoder.encode(JSON.stringify(value))); }
function decode(value) { return JSON.parse(decoder.decode(unbase64(value))); }
function refObject(value) {
  if (!value || !['external', 'cloud-mail'].includes(value.source)) fail('INVALID_REF');
  identifier(value.accountId, 'INVALID_REF');
  if (typeof value.id !== 'string' || !value.id.length || encoder.encode(value.id).length > 512 || /[\x00-\x1f]/.test(value.id)) fail('INVALID_REF');
  return { source: value.source, accountId: value.accountId, id: value.id };
}
export function encodeSourceRef(value) { return 'mr1_' + encode(refObject(value)); }
export function decodeSourceRef(ref) {
  try {
    if (typeof ref !== 'string' || !ref.startsWith('mr1_') || ref.length > 2048) throw new Error();
    const value = refObject(decode(ref.slice(4)));
    if (encodeSourceRef(value) !== ref) throw new Error();
    return value;
  } catch { fail('INVALID_REF'); }
}
function cursorObject(value) {
  if (!value || !Number.isSafeInteger(value.receivedAt) || value.receivedAt < 0) fail('INVALID_CURSOR');
  decodeSourceRef(value.ref);
  return { receivedAt: value.receivedAt, ref: value.ref };
}
export function encodeCursor(value) {
  try { return 'mc1_' + encode(cursorObject(value)); } catch { fail('INVALID_CURSOR'); }
}
export function decodeCursor(cursor) {
  try {
    if (typeof cursor !== 'string' || !cursor.startsWith('mc1_') || cursor.length > 4096) throw new Error();
    const value = cursorObject(decode(cursor.slice(4)));
    if (encodeCursor(value) !== cursor) throw new Error();
    return value;
  } catch { fail('INVALID_CURSOR'); }
}
async function hmacKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail('INVALID_KEY');
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function digest(body) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof body === 'string' ? encoder.encode(body) : body))); }
function scope(method, path) {
  if (typeof method !== 'string' || !/^[A-Z]+$/.test(method) || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.length > 4096) fail('UNAUTHORIZED');
}
export async function signGatewayAssertion({ key, ownerId, method, path, body = '', now = Date.now(), nonce = base64(crypto.getRandomValues(new Uint8Array(18))) }) {
  identifier(ownerId); identifier(nonce); scope(method, path);
  if (!Number.isSafeInteger(now) || nonce.length < 16) fail('INVALID_INPUT');
  const payload = encode({ v: 1, ownerId, iat: now, exp: now + 60000, nonce, method, path, bodyHash: await digest(body) });
  return payload + '.' + base64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(payload))));
}
export async function verifyGatewayAssertion({ key, token, method, path, body = new Uint8Array(), now = Date.now(), consumeNonce }) {
  try {
    scope(method, path);
    if (typeof token !== 'string' || token.length > 8192) throw new Error();
    const [payload, signature, extra] = token.split('.');
    if (extra !== undefined || !await crypto.subtle.verify('HMAC', await hmacKey(key), unbase64(signature), encoder.encode(payload))) throw new Error();
    const claims = decode(payload);
    identifier(claims.ownerId); identifier(claims.nonce);
    if (claims.v !== 1 || claims.nonce.length < 16 || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp - claims.iat !== 60000 || claims.iat > now + 5000 || claims.exp <= now || claims.method !== method || claims.path !== path || claims.bodyHash !== await digest(body)) throw new Error();
    if (await consumeNonce(claims.ownerId, claims.nonce, claims.exp) !== true) throw new Error();
    return { ownerId: claims.ownerId };
  } catch { fail('UNAUTHORIZED'); }
}
