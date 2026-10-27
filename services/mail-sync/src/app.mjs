import { Hono } from 'hono';
import { MailError, fail, verifyGatewayAssertion } from '../../../shared/unified-mail/index.mjs';
import { createWorkLimits } from './core/limits.mjs';
import { createMailService } from './sync/service.mjs';
import { mountMailRoutes } from './routes/mail.mjs';

const statuses = { UNAUTHORIZED: 401, NOT_FOUND: 404, CONFLICT: 409, INVALID_TRANSITION: 409, BUSY: 503, PAYLOAD_TOO_LARGE: 413, INVALID_REF: 400, INVALID_CURSOR: 400, INVALID_INPUT: 400, AUTH_REQUIRED: 401, PROVIDER_UNAVAILABLE: 503, SYNC_FAILED: 502, RATE_LIMITED: 429, RESYNC_REQUIRED: 409, INCOMPLETE_SWEEP: 409 };
async function boundedBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); fail('PAYLOAD_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function createSyncApp({ store, gatewayKey, clock = Date.now, registry, clients, adapters, proton }) {
  if (!(gatewayKey instanceof Uint8Array) || gatewayKey.byteLength !== 32) fail('INVALID_KEY');
  const key = new Uint8Array(gatewayKey); const app = new Hono(); const work = createWorkLimits();
  const service = createMailService({ store, clock, registry, clients, adapters, proton, limits: work }); app.services = service;
  app.onError((error, c) => {
    const code = error instanceof MailError && statuses[error.code] ? error.code : 'INTERNAL_ERROR';
    return c.json({ error: { code } }, statuses[code] ?? 500);
  });
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND' } }, 404));
  app.get('/health', c => c.json({ status: 'ok' }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const token = c.req.header('x-gateway-assertion'); if (!token) fail('UNAUTHORIZED');
    const body = await work.parse(() => boundedBody(c.req.raw));
    const url = new URL(c.req.url);
    const claims = await verifyGatewayAssertion({ key, token, method: c.req.method, path: url.pathname + url.search, body, now: clock(), consumeNonce: (ownerId, nonce, exp) => store.assertions.consume(ownerId, nonce, exp) });
    c.set('ownerId', claims.ownerId);
    c.set('body', body);
    await next();
  });
  app.get('/v1/accounts', c => c.json({ accounts: store.accounts.list(c.get('ownerId')) }));
  app.get('/v1/accounts/:id', c => c.json({ account: store.accounts.get(c.get('ownerId'), c.req.param('id')) }));
  app.get('/v1/messages', c => {
    const limit = c.req.query('limit');
    return c.json(store.messages.list(c.get('ownerId'), { limit: limit === undefined ? 50 : Number(limit), cursor: c.req.query('cursor'), accountId: c.req.query('accountId') }));
  });
  app.get('/v1/messages/:ref', c => c.json({ message: store.messages.get(c.get('ownerId'), c.req.param('ref')) }));
  app.get('/v1/operations/:id', c => c.json({ operation: store.operations.get(c.get('ownerId'), c.req.param('id')) }));
  app.get('/v1/devices', c => c.json({ devices: store.devices.list(c.get('ownerId')) }));
  mountMailRoutes(app, { store, service });
  return app;
}
