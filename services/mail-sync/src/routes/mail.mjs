import { fail, decodeSourceRef } from '../../../../shared/unified-mail/index.mjs';
import { mailConfig } from '../providers/imap.mjs';
import { text } from '../core/validation.mjs';
function json(c) {
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(c.get('body'))); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT'); return value; } catch { fail('INVALID_INPUT'); }
}
function protocol(provider, address, credentials) {
  if (!credentials || typeof credentials !== 'object') fail('INVALID_INPUT');
  const authType = credentials.authType === 'oauth' ? 'oauth' : 'password';
  if (provider === 'outlook' && authType !== 'oauth') fail('INVALID_INPUT');
  if (authType === 'oauth' && !['gmail', 'outlook'].includes(provider)) fail('INVALID_INPUT');
  const config = mailConfig(provider, credentials.config);
  return { authType, config, user: text(credentials.user || address, 320), ...(authType === 'password' ? { password: text(credentials.password, 8192) } : {}) };
}
export function mountMailRoutes(app, { store, service, callbackGatewayOwner = 'oauth-callback' }) {
  const owner = c => c.get('ownerId');
  app.post('/v1/accounts', c => {
    const body = json(c); const address = text(body.address, 320);
    if (!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+$/.test(address)) fail('INVALID_INPUT');
    const credentials = body.credentials ? protocol(body.provider, address, body.credentials) : null;
    const account = store.accounts.create(owner(c), { provider: body.provider, address });
    if (credentials) store.credentials.set(owner(c), account.id, 'protocol', JSON.stringify(credentials));
    return c.json({ account }, 201);
  });
  app.put('/v1/accounts/:id/credentials', async c => {
    const account = store.accounts.get(owner(c), c.req.param('id')); const value = protocol(account.provider, account.address, json(c));
    await service.engine.stopAccount(owner(c), account.id); await service.actions.stopAccount(owner(c), account.id); await service.registry.invalidate(owner(c), account.id); store.credentials.set(owner(c), account.id, 'protocol', JSON.stringify(value));
    return c.json({ account: store.accounts.setStatus(owner(c), account.id, 'pending') });
  });
  app.post('/v1/accounts/:id/connect', async c => c.json({ account: await service.engine.syncAccount({ ownerId: owner(c), accountId: c.req.param('id'), signal: c.req.raw.signal }) }));
  app.post('/v1/accounts/:id/pause', async c => {
    const account = store.accounts.setStatus(owner(c), c.req.param('id'), 'paused');
    await service.engine.stopAccount(owner(c), account.id);
    await service.actions.stopAccount(owner(c), account.id);
    await service.registry.invalidate(owner(c), account.id); return c.json({ account });
  });
  app.post('/v1/accounts/:id/resume', async c => {
    store.accounts.setStatus(owner(c), c.req.param('id'), 'pending');
    return c.json({ account: await service.engine.syncAccount({ ownerId: owner(c), accountId: c.req.param('id'), signal: c.req.raw.signal }) });
  });
  app.delete('/v1/accounts/:id', async c => {
    store.accounts.get(owner(c), c.req.param('id')); await service.engine.stopAccount(owner(c), c.req.param('id')); await service.actions.stopAccount(owner(c), c.req.param('id')); await service.registry.invalidate(owner(c), c.req.param('id'));
    store.accounts.remove(owner(c), c.req.param('id')); return c.json({ removed: true });
  });
  app.post('/v1/accounts/:id/oauth/start', async c => {
    const account = store.accounts.get(owner(c), c.req.param('id')); const result = await service.oauth.start(owner(c), account.id);
    store.credentials.set(owner(c), account.id, 'protocol', JSON.stringify({ authType: 'oauth', config: mailConfig(account.provider) })); return c.json(result);
  });
  app.post('/v1/oauth/resolve', c => {
    if (owner(c) !== callbackGatewayOwner) fail('UNAUTHORIZED'); return c.json(service.oauth.resolve(json(c).state));
  });
  app.post('/v1/oauth/complete', async c => {
    const { accountId } = await service.oauth.complete(owner(c), json(c)); await service.registry.invalidate(owner(c), accountId);
    store.accounts.setStatus(owner(c), accountId, 'pending');
    return c.json({ account: await service.engine.syncAccount({ ownerId: owner(c), accountId, signal: c.req.raw.signal }) });
  });
  app.get('/v1/messages/:ref/attachments/:id', async c => {
    const message = store.messages.get(owner(c), c.req.param('ref')); const a = message.attachments.find(a => a.id === c.req.param('id')); if (!a) fail('NOT_FOUND');
    const bytes = await store.attachments.read(owner(c), message.ref, a.id);
    c.header('Content-Type', 'application/octet-stream'); c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(a.filename).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16))}`); return c.body(bytes);
  });
  app.post('/v1/messages/:ref/read', async c => {
    const ref = c.req.param('ref'); const { unread } = json(c); if (typeof unread !== 'boolean') fail('INVALID_INPUT');
    return c.json({ operation: await service.actions.execute({ ownerId: owner(c), accountId: decodeSourceRef(ref).accountId, ref, kind: unread ? 'mark-unread' : 'mark-read', signal: c.req.raw.signal }) });
  });
  app.post('/v1/messages/:ref/trash', async c => {
    const ref = c.req.param('ref'); return c.json({ operation: await service.actions.execute({ ownerId: owner(c), accountId: decodeSourceRef(ref).accountId, ref, kind: 'delete', signal: c.req.raw.signal }) });
  });
  app.post('/v1/send', async c => {
    const body = json(c); if (!['send', 'reply', 'forward'].includes(body.kind)) fail('INVALID_INPUT');
    return c.json({ operation: await service.actions.execute({ ownerId: owner(c), accountId: body.accountId, ref: body.ref, kind: body.kind, message: body.message, signal: c.req.raw.signal }) });
  });
  app.get('/v1/operations', c => c.json({ operations: store.operations.list(owner(c)) }));
}
