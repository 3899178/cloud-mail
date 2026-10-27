import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, owner, ingest } from '../core/helpers.mjs';

test('SMTP ambiguity persists uncertain and never retries; identity comes from owned account', async t => {
  const { store } = await fixture(t); const a = account(store); ingest(store); const ref = store.messages.list(owner).items[0].ref;
  const module = await import('../../src/send/actions.mjs').catch(() => ({}));
  assert.equal(typeof module.createActions, 'function', 'source actions exist');
  let sent = 0; let observed;
  const registry = { async open() { return { async send(message) { sent++; observed = message; throw Object.assign(new Error('password in provider error'), { code: 'ECONNECTION', command: 'DATA' }); }, close: async () => {} }; } };
  const actions = module.createActions({ store, registry });
  const result = await actions.execute({ ownerId: owner, accountId: a.id, ref, kind: 'reply', message: { from: 'attacker@example.test', to: ['target@example.test'], text: 'hello' } });
  assert.equal(result.state, 'uncertain'); assert.equal(result.errorCode, 'SEND_UNCERTAIN');
  assert.equal(observed.from, a.address); assert.equal(sent, 1);
  await assert.rejects(actions.resume({ ownerId: owner, operationId: result.id }), { code: 'INVALID_TRANSITION' });
  assert.equal(sent, 1);
  await assert.rejects(actions.execute({ ownerId: 'other', accountId: a.id, ref, kind: 'delete' }), { code: 'NOT_FOUND' });
});
test('attachment forwarding uses bounded original-byte streams and original Message-ID for reply', async t => {
  const { store } = await fixture(t); const a = account(store); ingest(store); const ref = store.messages.list(owner).items[0].ref;
  const attachment = await store.attachments.put(owner, ref, { filename: 'original.bin', contentType: 'application/octet-stream', chunks: [Buffer.alloc(200000, 7)] });
  const sourceId = (await import('../../../../shared/unified-mail/index.mjs')).decodeSourceRef(ref).id;
  store.sources.commit(owner, a.id, { expectedFolders: ['Archive'], checkpoints: [{ folder: 'Archive', cursor: '1', uidValidity: '1', baselineAt: a.createdAt }], catalog: [{ folder: 'Archive', uidValidity: '1', remoteId: '1', sourceId, fingerprint: 'a', receivedAt: a.createdAt, unread: true, admitted: true, messageId: '<original@example.test>' }] });
  const { createActions } = await import('../../src/send/actions.mjs'); let received;
  const registry = { async open() { return { async send(message) { received = message; const chunks = []; for await (const chunk of message.attachments[0].content) { assert.ok(chunk.length <= 65536); chunks.push(chunk); } assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(200000, 7)); }, close: async () => {} }; } };
  const actions = createActions({ store, registry });
  const result = await actions.execute({ ownerId: owner, accountId: a.id, ref, kind: 'reply', message: { to: ['reply@example.test'], text: 'reply', attachmentIds: [attachment.id] } });
  assert.equal(result.state, 'succeeded'); assert.equal(received.inReplyTo, '<original@example.test>');
});
test('process restart recovers interrupted sends as uncertain and mutations as failed', async t => {
  const { store } = await fixture(t); const a = account(store);
  const send = store.operations.create(owner, { accountId: a.id, kind: 'send' }); store.operations.update(owner, send.id, { state: 'running' });
  const read = store.operations.create(owner, { accountId: a.id, kind: 'mark-read' });
  assert.equal(typeof store.operations.recover, 'function', 'restart recovery exists');
  store.operations.recover();
  assert.equal(store.operations.get(owner, send.id).state, 'uncertain'); assert.equal(store.operations.get(owner, send.id).errorCode, 'SEND_UNCERTAIN');
  assert.equal(store.operations.get(owner, read.id).state, 'failed');
});
test('account stop waits for an interrupted send outcome and preserves uncertain ledger', async t => {
  const { store } = await fixture(t); const a = account(store); let started; const began = new Promise(resolve => { started = resolve; });
  const { createActions } = await import('../../src/send/actions.mjs');
  const registry = { async open() { return { async send(message, { signal }) { started(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }, close: async () => {} }; } };
  const actions = createActions({ store, registry });
  const pending = actions.execute({ ownerId: owner, accountId: a.id, kind: 'send', message: { to: ['target@example.test'], text: 'cancel' } }); await began;
  assert.equal(typeof actions.stopAccount, 'function', 'send cancellation exists');
  await actions.stopAccount(owner, a.id); assert.equal((await pending).state, 'uncertain');
});
