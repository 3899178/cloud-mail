import { fail, signGatewayAssertion } from '../../../shared/unified-mail/index.mjs';
const encoder = new TextEncoder();
export async function boundedBody(request, maximum = 65536) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {
        value,
        done
      } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        fail('PAYLOAD_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function parseJson(bytes) {
  try {
    const v = JSON.parse(new TextDecoder('utf-8', {
      fatal: true
    }).decode(bytes));
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('INVALID_INPUT');
    return v;
  } catch {
    fail('INVALID_INPUT');
  }
}
export function gatewayKey(c) {
  const key = c.env.MAIL_SYNC_GATEWAY_KEY;
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) fail('SYNC_UNAVAILABLE');
  return Uint8Array.from(key.match(/../g), b => parseInt(b, 16));
}
export async function syncRequest(c, {
  path,
  method = c.req.method,
  body = new Uint8Array(),
  ownerId = String(c.get('user').userId),
  headers = {},
  stream = false
}) {
  let url;
  try {
    url = new URL(c.env.MAIL_SYNC_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw 0;
  } catch {
    fail('SYNC_UNAVAILABLE');
  }
  const assertion = await signGatewayAssertion({
    key: gatewayKey(c),
    ownerId,
    method,
    path,
    body: stream ? '' : body
  });
  const request = new Request(url.origin + path, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': stream ? 'application/octet-stream' : 'application/json',
      'x-gateway-assertion': assertion,
      ...headers
    },
    body: ['GET', 'HEAD'].includes(method) ? undefined : body,
    signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(stream ? 120000 : 60000)])
  });
  let response;
  try {
    response = await (c.env.MAIL_SYNC || {
      fetch
    }).fetch(request);
  } catch {
    fail('SYNC_UNAVAILABLE');
  }
  if (!response.ok) {
    let code = 'SYNC_UNAVAILABLE';
    try {
      const data = parseJson(await boundedBody(response, 65536));
      if (['CONFLICT', 'NOT_FOUND', 'UNAUTHORIZED', 'INVALID_INPUT', 'INVALID_REF', 'INVALID_CURSOR', 'BUSY', 'PAYLOAD_TOO_LARGE', 'INVALID_TRANSITION', 'AUTH_REQUIRED', 'PROVIDER_UNAVAILABLE', 'SYNC_FAILED', 'RATE_LIMITED', 'RESYNC_REQUIRED', 'INCOMPLETE_SWEEP', 'STORAGE_FULL', 'UPLOAD_EXPIRED', 'UPLOAD_CORRUPT'].includes(data.error?.code)) code = data.error.code;
    } catch {}
    fail(code);
  }
  return response;
}
export async function proxyJson(c, path, body) {
  if (body === undefined) body = await boundedBody(c.req.raw);
  if (body.length) parseJson(body);
  const response = await syncRequest(c, {
    path,
    body
  });
  c.header('Cache-Control', 'no-store');
  return c.json({
    code: 200,
    message: 'success',
    data: parseJson(await boundedBody(response, 5 * 1024 * 1024))
  }, response.status);
}
export const jsonBytes = value => encoder.encode(JSON.stringify(value));
