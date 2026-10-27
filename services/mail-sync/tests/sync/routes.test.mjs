import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner } from '../core/helpers.mjs';
import { signGatewayAssertion } from '../../../../shared/unified-mail/index.mjs';

test('binding/actions/download routes use asserted owner, keep credentials write-only and statuses observed', async t => {
  const { store, options } = await fixture(t); const gatewayKey = new Uint8Array(32).fill(9);
  const { createSyncApp } = await import('../../src/app.mjs');
  const registry = { async open() { throw Object.assign(Error('secret credential'), { authenticationFailed: true }); }, async invalidate() {} };
  const app = createSyncApp({ store, gatewayKey, clock: options.clock, registry });
  async function request(path, body, who = owner, method = 'POST') {
    const bytes = body === undefined ? '' : JSON.stringify(body);
    const assertion = await signGatewayAssertion({ key: gatewayKey, ownerId: who, path, method, body: bytes, now: options.clock() });
    return app.request(path, { method, headers: { 'x-gateway-assertion': assertion, 'Content-Type': 'application/json' }, body: bytes || undefined });
  }
  const result = await request('/v1/accounts', { provider: 'imap', address: 'user@example.test', ownerId: 'other', credentials: { password: 'private-password', config: { imap: { host: 'mail.example.test', port: 993, secure: true }, smtp: { host: 'mail.example.test', port: 465, secure: true } } } });
  assert.equal(result.status, 201, 'binding route exists');
  const { account } = await result.json(); assert.equal(account.status, 'pending');
  assert.ok(!JSON.stringify(account).includes('private-password'));
  const connect = await request(`/v1/accounts/${account.id}/connect`, {});
  assert.equal((await connect.json()).account.status, 'needs-auth');
  const foreign = await request(`/v1/accounts/${account.id}/connect`, {}, 'other'); assert.equal(foreign.status, 404);
  const paused = await request(`/v1/accounts/${account.id}/pause`, {}); assert.equal((await paused.json()).account.status, 'paused');
  assert.equal(store.accounts.list('other').length, 0);
});
