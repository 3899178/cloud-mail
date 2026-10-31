import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner } from '../core/helpers.mjs';
import { createAccountLifecycle } from '../../src/core/lifecycle.mjs';
import { Readable } from 'node:stream';
import { signGatewayAssertion } from '../../../../shared/unified-mail/index.mjs';

test('Proton MFA is owner/account bound, expiring and one-use; session is vault-only', async t => {
  const { store, options, tick } = await fixture(t);
  store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const module = await import('../../src/providers/proton.mjs').catch(() => ({}));
  assert.equal(typeof module.createProton, 'function', 'Proton coordinator exists');
  const lifecycle = createAccountLifecycle({ store });
  const calls = [];
  const transport = { async rpc(body) { calls.push(body); return body.op === 'auth.start' ? { step: 'totp', challenge: 'private-challenge' } : { material: { auth: { RefreshToken: 'secret-refresh' }, mailboxPassword: 'secret-mailbox' } }; } };
  const proton = module.createProton({ store, lifecycle, clock: options.clock, transport });
  const start = await proton.start(owner, 'proton', { password: 'secret-login' });
  assert.equal(start.step, 'totp'); assert.equal(start.challenge, undefined);
  await assert.rejects(proton.complete('other', 'proton', { state: start.state, code: '123456' }), { code: 'UNAUTHORIZED' });
  await proton.complete(owner, 'proton', { state: start.state, code: '123456' });
  assert.equal(JSON.parse(store.credentials.get(owner, 'proton', 'proton')).auth.RefreshToken, 'secret-refresh');
  assert.equal(store.accounts.get(owner, 'proton').status, 'pending');
  await assert.rejects(proton.complete(owner, 'proton', { state: start.state, code: '123456' }), { code: 'UNAUTHORIZED' });
  const expired = await proton.start(owner, 'proton', { password: 'secret-login' }); tick(300000);
  await assert.rejects(proton.complete(owner, 'proton', { state: expired.state, code: '123456' }), { code: 'UNAUTHORIZED' });
  assert.equal(calls.filter(c => c.op === 'auth.complete').length, 1);
});

test('service installs Proton adapter and preserves stable IDs and event checkpoints across resync', async t => {
  const { store, options } = await fixture(t);
  store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const calls = []; let token = 'event-1'; let unread = true; let trashed = false;
  const transport = {
    async rpc(r) {
      calls.push(r);
      if (r.op === 'auth.start') return { material: { auth: { RefreshToken: 'secret' } } };
      if (r.op === 'open') return { material: r.material, session: 'private-session', expiresAt: options.clock() + 600000 };
      if (r.op === 'folders') return { folders: [{ id: '0', kind: 'inbox' }] };
      if (r.op === 'snapshot') return { uidValidity: 'proton-message-id-v1', cursor: token, messages: trashed ? [] : [{ id: 'stable-message', stableId: 'stable-message', fingerprint: 'stable-message', receivedAt: options.clock() + 1, unread }] };
      if (r.op === 'validate') return { valid: true };
      if (r.op === 'flags') unread = r.unread;
      if (r.op === 'trash') trashed = true;
      return { ok: true };
    },
    async fetch(r) { calls.push(r); return Readable.from(['From: sender@example.test\r\nTo: user@proton.me\r\nSubject: Proton fixture\r\n\r\nreal body']); },
  };
  const { createMailService } = await import('../../src/sync/service.mjs');
  const service = createMailService({ store, clock: options.clock, proton: { transport } }); t.after(() => service.close());
  assert.equal(typeof service.proton?.start, 'function', 'service has one integrated Proton coordinator');
  await service.proton.start(owner, 'proton', { password: 'secret' });
  assert.equal((await service.engine.syncAccount({ ownerId: owner, accountId: 'proton' })).status, 'active');
  const first = store.messages.list(owner).items[0]; assert.equal(first.subject, 'Proton fixture');
  token = 'real-event-after-reset'; await service.engine.syncAccount({ ownerId: owner, accountId: 'proton' });
  assert.equal(store.messages.list(owner).items[0].ref, first.ref);
  assert.equal(store.checkpoints.get(owner, 'proton', '0').cursor, token);
  assert.equal(calls.filter(r => r.op === 'fetch').length, 1);
  assert.equal((await service.actions.execute({ ownerId: owner, accountId: 'proton', ref: first.ref, kind: 'mark-read' })).state, 'succeeded');
  assert.equal(unread, false);
  assert.equal((await service.actions.execute({ ownerId: owner, accountId: 'proton', ref: first.ref, kind: 'delete' })).state, 'succeeded');
  await service.engine.syncAccount({ ownerId: owner, accountId: 'proton' }); assert.equal(store.messages.list(owner).items.length, 0);
});

test('late Proton auth cannot overwrite pause or recreate deleted account', async t => {
  const { store } = await fixture(t); store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const module = await import('../../src/providers/proton.mjs').catch(() => ({}));
  assert.equal(typeof module.createProton, 'function', 'Proton coordinator exists');
  const lifecycle = createAccountLifecycle({ store }); let finish; let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const proton = module.createProton({ store, lifecycle, transport: { rpc() { entered(); return new Promise(resolve => { finish = resolve; }); } } });
  const auth = proton.start(owner, 'proton', { password: 'secret' }); await ready;
  const pause = lifecycle.transition(owner, 'proton', { begin: () => store.accounts.setStatus(owner, 'proton', 'paused'), commit: () => {} });
  finish({ material: { auth: { RefreshToken: 'late-secret' } } });
  await assert.rejects(auth, { code: 'BUSY' }); await pause;
  assert.throws(() => store.credentials.get(owner, 'proton', 'proton'), { code: 'NOT_FOUND' });
  assert.equal(store.accounts.get(owner, 'proton').status, 'paused');
});

test('new auth start invalidates prior state even if provider fails and oversized sessions fail closed', async t => {
  const { store, options } = await fixture(t); store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const { createProton } = await import('../../src/providers/proton.mjs'); const lifecycle = createAccountLifecycle({ store }); let failStart = false; let huge = false;
  const proton = createProton({ store, lifecycle, clock: options.clock, transport: { async rpc(r) {
    if (failStart) throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
    if (huge) return { material: { auth: { RefreshToken: 'x'.repeat(17000) } } };
    return { step: 'totp', challenge: 'private-challenge' };
  } } });
  const original = await proton.start(owner, 'proton', { password: 'password' }); failStart = true;
  await assert.rejects(proton.start(owner, 'proton', { password: 'password' }));
  assert.throws(() => store.oauthStates.resolve(original.state), { code: 'UNAUTHORIZED' });
  failStart = false; huge = true;
  await assert.rejects(proton.start(owner, 'proton', { password: 'password' }), { code: 'AUTH_REQUIRED' });
  assert.throws(() => store.credentials.get(owner, 'proton', 'proton'), { code: 'NOT_FOUND' });
});

test('Proton stored attachments reach send MIME unchanged and manual challenges remain explicit', async t => {
  const { store, options } = await fixture(t);store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const { createProton } = await import('../../src/providers/proton.mjs'); const lifecycle = createAccountLifecycle({ store }); let uploaded;
  const transport = { async rpc(r) { if (r.op === 'auth.start') return { step: 'manual-verification', challenge: 'must-not-leak' };if (r.op === 'open') return { material: r.material, session: 'session', expiresAt: options.clock() + 600000 };return {}; }, async send(r, mime) { const chunks = [];for await (const chunk of mime) chunks.push(chunk);uploaded = Buffer.concat(chunks);return { accepted: true }; } };
  const proton = createProton({ store, lifecycle, clock: options.clock, transport });
  assert.deepEqual(await proton.start(owner, 'proton', { password: 'password' }), { step: 'manual-verification' });
  store.credentials.set(owner, 'proton', 'proton', JSON.stringify({ auth: { RefreshToken: 'private' } }));
  const session = await proton.adapter({ ownerId: owner, account: store.accounts.get(owner, 'proton') });
  await session.send({ from: 'user@proton.me', to: ['recipient@example.test'], cc: [], bcc: [], text: 'Body', attachments: [{ filename: 'original.bin', contentType: 'application/octet-stream', content: Readable.from([Buffer.from([0, 1, 255, 13, 10])]) }] });
  const { simpleParser } = await import('mailparser'); const parsed = await simpleParser(uploaded);
  assert.deepEqual(parsed.attachments[0].content, Buffer.from([0, 1, 255, 13, 10])); await session.close();
});

for (const phase of ['mfa', 'refresh']) test(`late Proton ${phase} cannot survive account removal`, async t => {
  const { store, options } = await fixture(t);store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const { createProton } = await import('../../src/providers/proton.mjs'); const lifecycle = createAccountLifecycle({ store });let finish;let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const proton = createProton({ store, lifecycle, clock: options.clock, transport: { rpc(r) { if (r.op === 'auth.start') return Promise.resolve({ step: 'totp', challenge: 'private' });entered();return new Promise(resolve => { finish = resolve; }); } } });
  let work;
  if (phase === 'mfa') { const start = await proton.start(owner, 'proton', { password: 'secret' });work = proton.complete(owner, 'proton', { state: start.state, code: '123456' }); }
  else { store.credentials.set(owner, 'proton', 'proton', JSON.stringify({ auth: { RefreshToken: 'old' } }));work = proton.adapter({ ownerId: owner, account: store.accounts.get(owner, 'proton') }); }
  await ready;const removal = lifecycle.transition(owner, 'proton', { commit: () => store.accounts.remove(owner, 'proton') });
  finish({ material: { auth: { RefreshToken: 'late' } }, session: 'late-session', expiresAt: options.clock() + 600000 });
  await assert.rejects(work, { code: 'BUSY' });await removal;assert.throws(() => store.accounts.get(owner, 'proton'), { code: 'NOT_FOUND' });
});

test('signed Proton HTTP interaction uses asserted owner, hides helper secrets, blocks paused accounts', async t => {
  const { store, options } = await fixture(t); const key = new Uint8Array(32).fill(9);
  store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  const { createSyncApp } = await import('../../src/app.mjs');
  const app = createSyncApp({ store, gatewayKey: key, clock: options.clock, proton: { transport: { async rpc(r) { return r.op === 'auth.start' ? { step: 'totp', challenge: 'HELPER-SECRET' } : { material: { auth: { RefreshToken: 'VAULT-SECRET' } } }; } } } });t.after(() => app.services.close());
  async function send(path,body,who=owner) { const bytes = JSON.stringify(body);const token = await signGatewayAssertion({ key, ownerId: who, path, method: 'POST', body: bytes, now: options.clock() });return app.request(path, { method: 'POST', headers: { 'x-gateway-assertion': token }, body: bytes }); }
  const path = '/v1/accounts/proton/proton/start';const started = await send(path, { password: 'private-login', ownerId: 'other' });assert.equal(started.status, 200);const data = await started.json();assert.equal(data.step, 'totp');assert.ok(!JSON.stringify(data).includes('HELPER-SECRET'));
  const foreign = await send('/v1/accounts/proton/proton/complete', { state: data.state, code: '123456' }, 'other');assert.equal(foreign.status, 401);
  const completed = await send('/v1/accounts/proton/proton/complete', { state: data.state, code: '123456' });assert.deepEqual(await completed.json(), { step: 'ready' });assert.equal(store.accounts.get(owner, 'proton').status, 'pending');
  const paused = await send('/v1/accounts/proton/pause', {});assert.equal(paused.status, 200);
  const blocked = await send(path, { password: 'private' });assert.equal(blocked.status, 409);
  const accounts = store.accounts.list(owner);assert.ok(!JSON.stringify(accounts).includes('SECRET'));
});

test('complete Proton metadata leaves historical exclusion, later old-date admission and new-folder guards to the engine', async t => {
  const { store, options } = await fixture(t);store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  store.credentials.set(owner, 'proton', 'proton', JSON.stringify({ auth: { RefreshToken: 'private' } }));
  const record = id => ({ id, stableId: id, fingerprint: id, receivedAt: options.clock() - 10000, unread: true });
  let folders = ['0'];let inventory = { '0': [record('history')] };let token = 'real-event-1';const fetched = [];
  const transport = {
    async rpc(r) {
      if (r.op === 'open') return { material: r.material, session: 'session', expiresAt: options.clock() + 600000 };
      if (r.op === 'folders') return { folders: folders.map(id => ({ id, kind: 'normal' })) };
      if (r.op === 'snapshot') return { uidValidity: 'proton-message-id-v1', cursor: token, messages: inventory[r.folder] || [] };
      if (r.op === 'validate') return { valid: true };return { ok: true };
    },
    async fetch(r) { fetched.push(r.id);return Readable.from([`Subject: ${r.id}\r\n\r\nbody`]); },
  };
  const { createMailService } = await import('../../src/sync/service.mjs');const service = createMailService({ store, clock: options.clock, proton: { transport } });t.after(() => service.close());
  const sync = () => service.engine.syncAccount({ ownerId: owner, accountId: 'proton' });
  assert.equal((await sync()).status, 'active');assert.equal(store.sources.catalog(owner, 'proton').length, 1);assert.equal(store.messages.list(owner).items.length, 0);assert.deepEqual(fetched, []);
  inventory['0'].push(record('arrived-after-baseline'));token = 'real-event-2';assert.equal((await sync()).status, 'active');
  const published = store.messages.list(owner).items;assert.equal(published.length, 1);assert.equal(published[0].subject, 'arrived-after-baseline');assert.deepEqual(fetched, ['arrived-after-baseline']);
  folders = ['0', '6'];inventory = { '0': [], '6': [record('history'), record('arrived-after-baseline')] };token = 'real-event-after-reset';
  assert.equal((await sync()).status, 'active');assert.equal(store.messages.list(owner).items[0].ref, published[0].ref);assert.deepEqual(fetched, ['arrived-after-baseline']);
  folders.push('new-rule');inventory['new-rule'] = [record('unknown-old-date')];token = 'must-not-commit';
  const ambiguous = await sync();assert.equal(ambiguous.status, 'paused');assert.equal(ambiguous.errorCode, 'RESYNC_REQUIRED');
  assert.equal(store.checkpoints.get(owner, 'proton', '6').cursor, 'real-event-after-reset');assert.equal(store.checkpoints.get(owner, 'proton', 'new-rule'), null);assert.equal(store.messages.list(owner).items.length, 1);
});

for (const phase of ['before-headers', 'body']) test(`cached Proton fetch inherits the current lease through ${phase} and unbind drains promptly`, async t => {
  const { store, options } = await fixture(t);store.accounts.create(owner, { id: 'proton', provider: 'proton', address: 'user@proton.me' });
  store.credentials.set(owner, 'proton', 'proton', JSON.stringify({ auth: { RefreshToken: 'private' } }));
  let second = false;let openCount = 0;let activeSignal;let aborted = false;let started;let releaseStall = () => {};
  const stalled = new Promise(resolve => { started = resolve; });
  const transport = {
    async rpc(r) {
      if (r.op === 'open') { openCount++;return { material: r.material, session: 'session', expiresAt: options.clock() + 600000 }; }
      if (r.op === 'folders') return { folders: [{ id: '0', kind: 'inbox' }] };
      if (r.op === 'snapshot') return { uidValidity: 'proton-message-id-v1', cursor: second ? 'event-2' : 'event-1', messages: (second ? ['first', 'second'] : ['first']).map(id => ({ id, stableId: id, fingerprint: id, receivedAt: options.clock() + 1, unread: true })) };
      if (r.op === 'validate') return { valid: true };return { ok: true };
    },
    async fetch(r, { signal }) {
      if (r.id === 'first') return Readable.from(['Subject: first\r\n\r\nbody']);
      activeSignal = signal;signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      if (phase === 'before-headers') return new Promise((resolve,reject) => {
        releaseStall = () => reject(Object.assign(new Error('fixture-cancelled'), { name: 'AbortError' }));signal.addEventListener('abort', releaseStall, { once: true });started();
      });
      const source = new Readable({ read() {} });source.push('Subject: second\r\n\r\npartial body');releaseStall = () => source.destroy();started();return source;
    },
  };
  const { createMailService } = await import('../../src/sync/service.mjs');const service = createMailService({ store, clock: options.clock, proton: { transport } });t.after(() => service.close());
  assert.equal((await service.engine.syncAccount({ ownerId: owner, accountId: 'proton' })).status, 'active');
  second = true;const work = service.engine.syncAccount({ ownerId: owner, accountId: 'proton' });await stalled;
  if (phase === 'body') await new Promise(resolve => setImmediate(resolve));
  const removal = service.lifecycle.transition(owner, 'proton', { begin: () => store.accounts.setStatus(owner, 'proton', 'paused'), commit: async () => { await service.registry.invalidate(owner, 'proton');store.accounts.remove(owner, 'proton'); } });
  try {
    assert.equal(openCount, 1, 'second sync reused the cached helper session');assert.equal(activeSignal.aborted, true, 'cached fetch transport must see current lease abort');assert.equal(aborted, true);
    let timer;try { await Promise.race([removal, new Promise((resolve,reject) => { timer = setTimeout(() => reject(new Error('unbind did not drain promptly')), 1000); })]); } finally { clearTimeout(timer); }
    await work;assert.throws(() => store.accounts.get(owner, 'proton'), { code: 'NOT_FOUND' });
  } finally { releaseStall();await Promise.allSettled([work, removal]); }
});
