import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fixture, account, owner, ingest } from '../core/helpers.mjs';
import { signGatewayAssertion } from '../../../../shared/unified-mail/index.mjs';
import { createSyncApp } from '../../src/app.mjs';
import { createSyncEngine } from '../../src/sync/engine.mjs';
import { createOAuth } from '../../src/providers/oauth.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, registry) {
  const f = await fixture(t); const a = account(f.store); const key = new Uint8Array(32).fill(9);
  const app = createSyncApp({ store: f.store, gatewayKey: key, clock: f.options.clock, registry });
  async function request(path, method = 'POST', body, signal) {
    const bytes = body === undefined ? '' : JSON.stringify(body);
    const token = await signGatewayAssertion({ key, ownerId: owner, path, method, body: bytes, now: f.options.clock() });
    return app.request(path, { method, signal, headers: { 'x-gateway-assertion': token }, body: bytes || undefined });
  }
  return { ...f, a, app, request };
}
test('failed-sweep hydration identities survive move, UID reset, deletion and restart without duplicates', async t => {
  for (const mode of ['move', 'reset', 'delete']) await t.test(mode, async t => {
    const { store, options } = await fixture(t); const a = account(store); const time = a.createdAt + 1;
    let validity = '1'; let broken = true;
    const data = new Map([['INBOX', [{ id: '1', key: 'identical', receivedAt: time, unread: true }, { id: '2', key: 'identical', receivedAt: time, unread: true }]], ['Archive', [{ id: '3', key: 'fail', receivedAt: time, unread: true }]]]);
    const registry = { async open() { return { folders: async () => [{ id: 'INBOX', kind: 'inbox' }, { id: 'Archive', kind: 'archive' }], snapshot: async folder => ({ uidValidity: validity, cursor: 'end', messages: data.get(folder) }), fetch: async (folder, m) => { if (m.key === 'fail' && broken) throw Error('fixture failure'); return Readable.from([Buffer.from(`Message-ID: <${m.key}@example.test>\r\nSubject: ${m.key}\r\n\r\noriginal`)]); }, close: async () => {} }; } };
    await createSyncEngine({ store, registry }).syncAccount({ ownerId: owner, accountId: a.id });
    const refs = store.messages.list(owner).items.map(m => m.ref).sort(); assert.equal(refs.length, 2); assert.equal(store.checkpoints.get(owner, a.id, 'INBOX'), null);
    store.close(); const { openStore } = await import('../../src/core/store.mjs'); const reopened = openStore(options); const close = store.close; store.close = () => { reopened.close(); close(); };
    broken = false; data.set('INBOX', []); data.set('Archive', mode === 'delete' ? [] : [{ id: '9', key: 'identical', receivedAt: time, unread: true }, { id: '10', key: 'identical', receivedAt: time, unread: true }]);
    if (mode === 'reset') validity = '2';
    assert.equal((await createSyncEngine({ store: reopened, registry }).syncAccount({ ownerId: owner, accountId: a.id })).status, 'active');
    assert.deepEqual(reopened.messages.list(owner).items.map(m => m.ref).sort(), mode === 'delete' ? [] : refs);
    assert.throws(() => reopened.sources.prune(owner, a.id, 'not-a-completed-sweep'), { code: 'INCOMPLETE_SWEEP' });
  });
});
test('unbind closes admission before invalidate waits and cannot delete an admitted send ledger', async t => {
  const invalidateStarted = deferred(); const releaseInvalidate = deferred(); let sends = 0;
  const registry = { async invalidate() { invalidateStarted.resolve(); await releaseInvalidate.promise; }, async open() { return { async send() { sends++; return { accepted: true }; }, close: async () => {} }; } };
  const { a, store, request } = await setup(t, registry);
  const removing = request(`/v1/accounts/${a.id}`, 'DELETE'); await invalidateStarted.promise;
  const late = await request('/v1/send', 'POST', { accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'late' } });
  releaseInvalidate.resolve(); await removing;
  assert.equal(late.status, 503); assert.equal(sends, 0); assert.equal(store.accounts.list(owner).length, 0);
});
test('pause waits admitted send, blocks new sends, and preserves uncertain result before unbind', async t => {
  const sendStarted = deferred(); const finishSend = deferred(); let sends = 0;
  const registry = { async invalidate() {}, async open() { return { async send() { sends++; sendStarted.resolve(); await finishSend.promise; throw Error('acceptance unknown'); }, close: async () => {} }; } };
  const { a, store, request } = await setup(t, registry);
  const sending = request('/v1/send', 'POST', { accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'first' } }); await sendStarted.promise;
  let drained = false; const pause = request(`/v1/accounts/${a.id}/pause`).then(r => { drained = true; return r; });
  while (store.accounts.get(owner, a.id).status !== 'paused') await turn();
  const timeout = setTimeout(() => finishSend.resolve(), 100);
  const late = await request('/v1/send', 'POST', { accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'late' } });
  clearTimeout(timeout);
  const wasDrained = drained;
  finishSend.resolve(); const result = await (await sending).json(); await pause;
  assert.equal(late.status, 503); assert.equal(wasDrained, false);
  assert.equal(result.operation.state, 'uncertain'); assert.equal(store.operations.get(owner, result.operation.id).state, 'uncertain'); assert.equal(sends, 1);
});
test('unbind cannot return removed while an already submitted send is awaiting its source outcome', async t => {
  const started = deferred(); const finish = deferred();
  const registry = { async invalidate() {}, async open() { return { async send() { started.resolve(); await finish.promise; return { accepted: true }; }, close: async () => {} }; } };
  const { a, store, request } = await setup(t, registry);
  const sending = request('/v1/send', 'POST', { accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'submitted' } }); await started.promise;
  let removed = false; const deleting = request(`/v1/accounts/${a.id}`, 'DELETE').then(r => { removed = true; return r; });
  await turn(); await turn(); assert.equal(removed, false); assert.equal(store.accounts.get(owner, a.id).id, a.id);
  assert.equal(store.operations.list(owner)[0].state, 'running');
  const late = await request('/v1/send', 'POST', { accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'late' } });
  finish.resolve(); const sent = await sending; const deletion = await deleting;
  assert.equal(late.status, 503); assert.equal(sent.status, 200); assert.equal((await sent.json()).operation.state, 'succeeded'); assert.equal((await deletion.json()).removed, true);
});
test('OAuth exchange/refresh cannot write through a concurrent pause or credential transition', async t => {
  for (const mode of ['complete', 'refresh']) await t.test(mode, async t => {
    const { store, app, request } = await setup(t, { async invalidate() {} });
    const a = store.accounts.create(owner, { id: 'google-race', provider: 'gmail', address: 'google@example.test' });
    const started = deferred(); const finish = deferred();
    app.services.oauth = createOAuth({ store, lifecycle: app.services.lifecycle, clients: { gmail: { clientId: 'own-test-client', clientSecret: 'test-secret', redirectUri: 'https://mail.example.test/callback' } }, fetcher: async () => { started.resolve(); await finish.promise; return new Response(JSON.stringify({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 })); } });
    let work;
    if (mode === 'complete') {
      const response = await request(`/v1/accounts/${a.id}/oauth/start`); const start = await response.json(); const state = new URL(start.authorizationUrl).searchParams.get('state');
      work = request('/v1/oauth/complete', 'POST', { state, code: 'test-code' });
    } else {
      store.credentials.set(owner, a.id, 'oauth', JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 }));
      work = app.services.oauth.auth(owner, a.id).catch(error => error.code);
    }
    await started.promise; let paused = false;
    const pause = request(`/v1/accounts/${a.id}/pause`).then(r => { paused = true; return r; });
    while (store.accounts.get(owner, a.id).status !== 'paused') await turn();
    const blocked = await request(`/v1/accounts/${a.id}/credentials`, 'PUT', { authType: 'oauth' });
    const blockedStart = await request(`/v1/accounts/${a.id}/oauth/start`);
    assert.equal(blocked.status, 503); assert.equal(blockedStart.status, 503); assert.equal(paused, false);
    finish.resolve(); const result = await work; await pause;
    assert.equal(mode === 'complete' ? result.status : result, mode === 'complete' ? 503 : 'BUSY');
    assert.equal(store.accounts.get(owner, a.id).status, 'paused');
    if (mode === 'complete') assert.throws(() => store.credentials.get(owner, a.id, 'oauth'), { code: 'NOT_FOUND' });
    else assert.equal(JSON.parse(store.credentials.get(owner, a.id, 'oauth')).accessToken, 'old-access');
  });
});
test('credential replacement closes admission during drain and only the new generation writes', async t => {
  const started = deferred(); const finish = deferred(); let sends = 0;
  const registry = { async invalidate() { started.resolve(); await finish.promise; }, async open() { sends++; return { send: async () => ({ accepted: true }), close: async () => {} }; } };
  const { a, store, request } = await setup(t, registry);
  const replacing = request(`/v1/accounts/${a.id}/credentials`, 'PUT', { password: 'new-secret', config: { imap: { host: 'mail.example.test', port: 993, secure: true }, smtp: { host: 'mail.example.test', port: 465, secure: true } } }); await started.promise;
  const late = await request('/v1/send', 'POST', { accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'late' } });
  finish.resolve(); assert.equal((await replacing).status, 200); assert.equal(late.status, 503); assert.equal(sends, 0);
  assert.equal(JSON.parse(store.credentials.get(owner, a.id, 'protocol')).password, 'new-secret');
});
test('download is bounded/backpressured, rejects a third active transfer, and cancel releases capacity', async t => {
  const { a, store, request } = await setup(t, { async invalidate() {} }); ingest(store);
  const ref = store.messages.list(owner).items[0].ref; const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const attachment = await store.attachments.put(owner, ref, { filename: 'file.bin', contentType: 'application/octet-stream', chunks: [bytes] });
  store.attachments.read = async () => { throw Error('whole-file read forbidden'); };
  let yielded = 0; let closed = 0; const original = store.attachments.stream;
  store.attachments.stream = (...args) => Readable.from((async function* () { try { for await (const chunk of original(...args)) { yielded++; yield chunk; } } finally { closed++; } })());
  const path = `/v1/messages/${ref}/attachments/${attachment.id}`;
  const first = await request(path, 'GET'); assert.equal(first.status, 200, 'download must use a stream');
  await turn(); assert.ok(yielded <= 3, 'unread response must not consume the whole attachment');
  const second = await request(path, 'GET'); const third = await request(path, 'GET'); assert.equal(third.status, 503);
  await first.body.cancel(); await second.body.cancel(); await turn(); assert.equal(closed, 2);
  const after = await request(path, 'GET'); const reader = after.body.getReader(); const chunks = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; assert.ok(value.byteLength <= 65536); chunks.push(value); }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const abort = new AbortController(); const disconnected = await request(path, 'GET', undefined, abort.signal); abort.abort(); await turn();
  await disconnected.body.cancel().catch(() => {}); const final = await request(path, 'GET'); assert.equal(final.status, 200); await final.body.cancel();
});
