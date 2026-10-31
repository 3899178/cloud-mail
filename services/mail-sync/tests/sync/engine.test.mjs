import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, owner } from '../core/helpers.mjs';
import { Readable } from 'node:stream';

async function engine(options) {
  const module = await import('../../src/sync/engine.mjs').catch(() => ({}));
  assert.equal(typeof module.createSyncEngine, 'function', 'durable sync engine exists');
  return module.createSyncEngine(options);
}
const mime = (id, attachment = false) => Buffer.from(`Message-ID: <${id}@example.test>\r\nFrom: sender@example.test\r\nSubject: ${id}\r\nMIME-Version: 1.0\r\n${attachment ? 'Content-Type: multipart/mixed; boundary=abc\r\n\r\n--abc\r\nContent-Type: text/plain\r\n\r\nhello\r\n--abc\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="original.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC/w==\r\n--abc--\r\n' : 'Content-Type: text/plain\r\n\r\nhello'}`);
export function providerFixture() {
  const state = { validity: '1', folders: [{ id: 'INBOX', kind: 'inbox' }, { id: 'Archive', kind: 'archive' }, { id: 'Rules', kind: 'rule' }, { id: 'Spam', kind: 'spam' }], data: new Map(), failure: null };
  const open = async () => {
    if (state.failure) throw state.failure;
    return { folders: async () => state.folders, snapshot: async folder => ({ uidValidity: state.validity, cursor: 'end', messages: state.data.get(folder) || [] }), fetch: async (folder, m) => Readable.from([mime(m.key, m.attachment)]), close: async () => {} };
  };
  return { state, registry: { open } };
}
test('baseline covers archive/rule, reconnect dedupes, UID reset keeps new mail, moves/deletions reconcile', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture();
  p.state.data.set('Archive', [{ id: '1', key: 'old', receivedAt: a.createdAt - 1, unread: true }, { id: '2', key: 'new', receivedAt: a.createdAt + 1, unread: true, attachment: true }]);
  p.state.data.set('Rules', [{ id: '7', key: 'rule', receivedAt: a.createdAt + 2, unread: false }]);
  const sync = await engine({ store, registry: p.registry });
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.accounts.get(owner, a.id).status, 'active');
  assert.equal(store.messages.list(owner).items.length, 2);
  const saved = store.messages.list(owner).items.find(m => m.subject === 'new');
  const attachment = store.messages.get(owner, saved.ref).attachments[0];
  assert.deepEqual(await store.attachments.read(owner, saved.ref, attachment.id), Buffer.from([0, 1, 2, 255]));
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.messages.get(owner, saved.ref).attachments.length, 1);
  p.state.validity = 'reset';
  p.state.data.set('Archive', [{ id: '100', key: 'old', receivedAt: a.createdAt - 1, unread: true }]);
  p.state.data.set('INBOX', [{ id: '99', key: 'new', receivedAt: a.createdAt + 1, unread: false, attachment: true }, { id: '101', key: 'offline', receivedAt: a.createdAt + 9, unread: true }]);
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.messages.get(owner, saved.ref).folder, 'INBOX');
  assert.equal(store.messages.get(owner, saved.ref).unread, false);
  assert.equal(store.messages.list(owner).items.length, 3);
  p.state.data.set('INBOX', []);
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.messages.list(owner).items.length, 1);
  await assert.rejects(store.attachments.read(owner, saved.ref, attachment.id), { code: 'NOT_FOUND' });
});
test('distinct identical deliveries survive copies and one-to-one reset reconciliation', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture(); const receivedAt = a.createdAt + 1;
  p.state.data.set('INBOX', [{ id: '1', key: 'identical', receivedAt, unread: true }, { id: '2', key: 'identical', receivedAt, unread: true }]);
  const sync = await engine({ store, registry: p.registry });
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.messages.list(owner).items.length, 2);
  const refs = store.messages.list(owner).items.map(m => m.ref).sort();
  p.state.validity = '2';
  p.state.data.set('INBOX', [{ id: '10', key: 'identical', receivedAt, unread: true }]);
  p.state.data.set('Archive', [{ id: '11', key: 'identical', receivedAt, unread: true }]);
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.deepEqual(store.messages.list(owner).items.map(m => m.ref).sort(), refs);
  p.state.data.set('Rules', [{ id: '12', key: 'identical', receivedAt, unread: true }]);
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.messages.list(owner).items.length, 3);
});
test('post-baseline APPEND preserves old date and incomplete sweeps cannot authorize cleanup', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture(); const sync = await engine({ store, registry: p.registry });
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  p.state.data.set('INBOX', [{ id: '1', key: 'imported-now', receivedAt: a.createdAt - 1000, unread: true }]);
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  const ref = store.messages.list(owner).items[0].ref;
  p.state.data.set('INBOX', []); p.state.data.set('Archive', [{ id: '2', key: 'imported-now', receivedAt: a.createdAt - 1000, unread: true }]);
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.messages.list(owner).items[0].ref, ref);
  assert.throws(() => store.sources.prune(owner, a.id, 'missing'), { code: 'INCOMPLETE_SWEEP' });
  assert.throws(() => store.sources.commit(owner, a.id, { catalog: [], expectedFolders: ['INBOX', 'Archive'], checkpoints: [{ folder: 'INBOX' }] }), { code: 'INCOMPLETE_SWEEP' });
  assert.equal(store.messages.get(owner, ref).ref, ref);
});
test('partial MIME failure does not establish binding baseline and retry does not import history', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture();
  p.state.data.set('INBOX', [{ id: '1', key: 'new', receivedAt: a.createdAt + 1, unread: true }]);
  p.state.data.set('Archive', [{ id: '2', key: 'broken', receivedAt: a.createdAt + 2, unread: true }]);
  const open = p.registry.open; let broken = true;
  p.registry.open = async () => { const session = await open(); const fetch = session.fetch; session.fetch = async (folder, m) => { if (m.key === 'broken' && broken) throw Error('network'); return fetch(folder, m); }; return session; };
  const sync = await engine({ store, registry: p.registry });
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.checkpoints.get(owner, a.id, 'INBOX'), null);
  p.state.data.set('INBOX', [...p.state.data.get('INBOX'), { id: '3', key: 'history', receivedAt: a.createdAt - 1, unread: true }]); broken = false;
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.deepEqual(store.messages.list(owner).items.map(m => m.subject).sort(), ['broken', 'new']);
});
test('authentication failure never marks active or exposes raw error', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture();
  p.state.failure = Object.assign(new Error('secret-password'), { authenticationFailed: true });
  const sync = await engine({ store, registry: p.registry });
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(store.accounts.get(owner, a.id).status, 'needs-auth');
  assert.equal(store.accounts.get(owner, a.id).errorCode, 'AUTH_REQUIRED');
});
test('pause cancels an in-flight account and remains paused after provider abort', async t => {
  const { store } = await fixture(t); const a = account(store); let started;
  const began = new Promise(resolve => { started = resolve; });
  const registry = { async open({ signal }) { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } };
  const sync = await engine({ store, registry });
  const task = sync.syncAccount({ ownerId: owner, accountId: a.id }); await began;
  store.accounts.setStatus(owner, a.id, 'paused');
  assert.equal(typeof sync.stopAccount, 'function', 'account cancellation exists');
  await sync.stopAccount(owner, a.id); await task;
  assert.equal(store.accounts.get(owner, a.id).status, 'paused');
});
test('metadata-destroying old-date UID reset surfaces resync needed without importing history', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture();
  p.state.data.set('INBOX', [{ id: '1', key: 'historical', receivedAt: a.createdAt - 1, unread: true }]);
  const sync = await engine({ store, registry: p.registry }); await sync.syncAccount({ ownerId: owner, accountId: a.id });
  p.state.validity = '2'; p.state.data.set('INBOX', [{ id: '9', key: 'identifiers-destroyed', receivedAt: a.createdAt - 1, unread: true }]);
  const status = await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(status.errorCode, 'RESYNC_REQUIRED'); assert.equal(status.status, 'paused');
  assert.equal(store.messages.list(owner).items.length, 0);
});
test('new folder with ambiguous old-date messages pauses instead of silently discarding a post-bind import', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture(); const sync = await engine({ store, registry: p.registry });
  await sync.syncAccount({ ownerId: owner, accountId: a.id });
  p.state.folders.push({ id: 'NewRule', kind: 'normal' });
  p.state.data.set('NewRule', [{ id: '9', key: 'old-date-new', receivedAt: a.createdAt - 1, unread: true }]);
  const status = await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(status.errorCode, 'RESYNC_REQUIRED'); assert.equal(status.status, 'paused');
  assert.equal(store.checkpoints.get(owner, a.id, 'NewRule'), null);
});
test('catalog capacity is explicit and cannot truncate a sweep or erase its existing mail', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture(); const sync = await engine({ store, registry: p.registry });
  p.state.data.set('INBOX', [{ id: '1', key: 'keep', receivedAt: a.createdAt + 1, unread: true }]); await sync.syncAccount({ ownerId: owner, accountId: a.id });
  const ref = store.messages.list(owner).items[0].ref;
  p.state.data.set('Archive', Array.from({ length: 20001 }, (_, i) => ({ id: String(i), key: 'history', receivedAt: 0, unread: true })));
  const status = await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(status.status, 'paused'); assert.equal(status.errorCode, 'CAPACITY_EXCEEDED'); assert.equal(store.messages.get(owner, ref).ref, ref);
});
test('storage exhaustion pauses ingestion and preserves already retained mail', async t => {
  const { store } = await fixture(t); const a = account(store); const p = providerFixture(); const sync = await engine({ store, registry: p.registry });
  p.state.data.set('INBOX', [{ id: '1', key: 'retained', receivedAt: a.createdAt + 1, unread: true }]); await sync.syncAccount({ ownerId: owner, accountId: a.id });
  const before = store.messages.list(owner).items[0]; const checkpoint = store.checkpoints.get(owner, a.id, 'INBOX');
  p.state.data.get('INBOX').push({ id: '2', key: 'no-space', receivedAt: a.createdAt + 2, unread: true, attachment: true });
  const stage = store.attachments.stage; store.attachments.stage = async () => { throw Object.assign(Error('no space'), { code: 'ENOSPC' }); }; t.after(() => { store.attachments.stage = stage; });
  const result = await sync.syncAccount({ ownerId: owner, accountId: a.id });
  assert.equal(result.status, 'paused'); assert.equal(result.errorCode, 'STORAGE_FULL');
  assert.equal(store.messages.get(owner, before.ref).subject, 'retained'); assert.deepEqual(store.checkpoints.get(owner, a.id, 'INBOX'), checkpoint);
});
