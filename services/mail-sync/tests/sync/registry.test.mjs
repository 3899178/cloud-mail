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

test('idle provider connections stay bounded while 50 accounts retain durable state', async t => {
  const { store } = await fixture(t); const { createProviderRegistry } = await import('../../src/providers/registry.mjs');
  let active=0, peak=0;
  const registry=createProviderRegistry({store,sessionFactory:async()=>{ active++;peak=Math.max(peak,active);let closed=false;return {usable:()=>!closed,close:async()=>{if(!closed){closed=true;active--;}}}; }});t.after(()=>registry.close());
  for(let i=0;i<50;i++) {
    const a=store.accounts.create(owner,{id:`pool-${i}`,provider:'imap',address:'fixture@example.test'});
    store.credentials.set(owner,a.id,'protocol',JSON.stringify({password:'fixture',config:{imap:{host:'fixture.test',port:993,secure:true},smtp:{host:'fixture.test',port:465,secure:true}}}));
    const lease=await registry.open({ownerId:owner,account:a});await lease.close();
    assert.ok(active<=2, `idle connections ${active} exceed bound`);
  }
  assert.ok(peak<=3);assert.equal(store.accounts.list(owner).length,50);
});
