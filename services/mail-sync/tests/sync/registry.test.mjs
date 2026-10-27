import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, owner } from '../core/helpers.mjs';
test('pooled provider leases serialize per account and abort closes the active connection', async t => {
  const { store } = await fixture(t); const a = account(store);
  store.credentials.set(owner, a.id, 'protocol', JSON.stringify({ password: 'fixture', config: { imap: { host: 'mail.test', port: 993, secure: true }, smtp: { host: 'mail.test', port: 465, secure: true } } }));
  const { createProviderRegistry } = await import('../../src/providers/registry.mjs'); let connections = 0; let closed = 0;
  const registry = createProviderRegistry({ store, sessionFactory: async () => { connections++; let usable = true; return { usable: () => usable, close: async () => { usable = false; closed++; } }; } }); t.after(() => registry.close());
  const controller = new AbortController(); const first = await registry.open({ ownerId: owner, account: a, signal: controller.signal });
  let acquired = false; const second = registry.open({ ownerId: owner, account: a }).then(s => { acquired = true; return s; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acquired, false);
  controller.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1, 'abort closes the active transport');
  await first.close(); await (await second).close(); assert.equal(connections, 2);
});
