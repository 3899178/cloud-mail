import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, account, ingest, mail, owner } from './helpers.mjs';

test('account reads and mutations cannot address another owner', async t => {
  const { store } = await fixture(t); account(store);
  assert.deepEqual(store.accounts.list('user-b'), []);
  assert.throws(() => store.accounts.get('user-b', 'acc-1'), { code: 'NOT_FOUND' });
  assert.throws(() => store.accounts.setStatus('user-b', 'acc-1', 'paused'), { code: 'NOT_FOUND' });
  assert.throws(() => store.accounts.remove('user-b', 'acc-1'), { code: 'NOT_FOUND' });
  assert.equal(store.accounts.get(owner, 'acc-1').status, 'pending');
});
test('credentials are encrypted at rest and absent from every account DTO', async t => {
  const { store, options } = await fixture(t); account(store);
  store.credentials.set(owner, 'acc-1', 'imap-password', 'do-not-leak-fixture');
  assert.equal(store.credentials.get(owner, 'acc-1', 'imap-password'), 'do-not-leak-fixture');
  assert.throws(() => store.credentials.get('user-b', 'acc-1', 'imap-password'), { code: 'NOT_FOUND' });
  const dto = JSON.stringify([store.accounts.get(owner, 'acc-1'), store.accounts.list(owner)]);
  assert.doesNotMatch(dto, /password|cipher|nonce|secret|do-not-leak/);
  assert.equal(readFileSync(options.dbPath).includes(Buffer.from('do-not-leak-fixture')), false);
  assert.equal(readFileSync(`${options.dbPath}-wal`).includes(Buffer.from('do-not-leak-fixture')), false);
});
test('SQLite commits survive reopening with WAL enabled', async t => {
  const { store, options } = await fixture(t); account(store); ingest(store);
  const db = new DatabaseSync(options.dbPath);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); db.close();
  const { openStore } = await import('../../src/core/store.mjs');
  const other = openStore(options);
  try {
    assert.equal(other.messages.list(owner).items.length, 1);
    assert.deepEqual(other.checkpoints.get(owner, 'acc-1', 'Archive'), { cursor: 'event-1' });
  } finally { other.close(); }
});
test('duplicate source messages deduplicate per account while stable pagination retains ties', async t => {
  const { store } = await fixture(t); account(store); account(store, owner, 'acc-2');
  ingest(store, owner, 'acc-1', [mail('m-1'), mail('m-2')]);
  ingest(store, owner, 'acc-1', [mail('m-1')]); ingest(store, owner, 'acc-2');
  const first = store.messages.list(owner, { limit: 2 });
  const second = store.messages.list(owner, { limit: 2, cursor: first.nextCursor });
  assert.equal(first.items.length, 2); assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map(m => m.ref)).size, 3);
  assert.deepEqual(store.messages.list('user-b').items, []);
  assert.throws(() => store.messages.get('user-b', first.items[0].ref), { code: 'NOT_FOUND' });
});
test('failed ingestion rolls back messages and checkpoint together', async t => {
  const { store } = await fixture(t); account(store); ingest(store);
  assert.throws(() => ingest(store, owner, 'acc-1', [mail('m-2'), mail('', 2)], 'event-2'), { code: 'INVALID_INPUT' });
  assert.equal(store.messages.list(owner).items.length, 1);
  assert.deepEqual(store.checkpoints.get(owner, 'acc-1', 'Archive'), { cursor: 'event-1' });
  assert.throws(() => ingest(store, 'user-b'), { code: 'NOT_FOUND' });
  assert.throws(() => store.checkpoints.get('user-b', 'acc-1', 'Archive'), { code: 'NOT_FOUND' });
});
test('credentials cannot be rebound to another account owner or secret kind', async t => {
  const { store, options } = await fixture(t); account(store); account(store, owner, 'acc-2'); account(store, 'user-b', 'acc-1');
  store.credentials.set(owner, 'acc-1', 'imap-password', 'fixture-private');
  const db = new DatabaseSync(options.dbPath);
  const encrypted = db.prepare('SELECT envelope FROM credentials WHERE owner_id=? AND account_id=?').get(owner, 'acc-1').envelope;
  const insert = db.prepare('INSERT INTO credentials(owner_id,account_id,kind,envelope) VALUES(?,?,?,?)');
  insert.run(owner, 'acc-2', 'imap-password', encrypted);
  insert.run('user-b', 'acc-1', 'imap-password', encrypted);
  insert.run(owner, 'acc-1', 'smtp-password', encrypted); db.close();
  for (const [who, id, kind] of [[owner, 'acc-2', 'imap-password'], ['user-b', 'acc-1', 'imap-password'], [owner, 'acc-1', 'smtp-password']]) {
    assert.throws(() => store.credentials.get(who, id, kind), { code: 'CREDENTIAL_UNAVAILABLE' });
  }
});
test('operation results persist safe states and reject cross-owner transitions', async t => {
  const { store } = await fixture(t); account(store); ingest(store);
  const ref = store.messages.list(owner).items[0].ref;
  const op = store.operations.create(owner, { accountId: 'acc-1', ref, kind: 'mark-read' });
  assert.equal(op.state, 'queued');
  assert.throws(() => store.operations.update('user-b', op.id, { state: 'succeeded' }), { code: 'NOT_FOUND' });
  store.operations.update(owner, op.id, { state: 'uncertain', errorCode: 'PROVIDER_TIMEOUT' });
  assert.equal(store.operations.get(owner, op.id).state, 'uncertain');
  assert.throws(() => store.operations.update(owner, op.id, { state: 'queued' }), { code: 'INVALID_TRANSITION' });
  assert.throws(() => store.operations.update(owner, op.id, { state: 'failed', errorCode: 'password=private' }), { code: 'INVALID_INPUT' });
});
test('devices hold hashed notification-only tokens with expiry and revocation', async t => {
  const { store, tick, options } = await fixture(t);
  const device = store.devices.issue(owner, { label: 'My phone', ttlMs: 60000 });
  assert.equal(store.devices.authenticate(device.token).ownerId, owner);
  assert.deepEqual(store.devices.authenticate(device.token).scopes, ['notifications']);
  assert.doesNotMatch(JSON.stringify(store.devices.list(owner)), new RegExp(device.token));
  assert.equal(readFileSync(`${options.dbPath}-wal`).includes(Buffer.from(device.token)), false);
  assert.throws(() => store.devices.revoke('user-b', device.id), { code: 'NOT_FOUND' });
  store.devices.revoke(owner, device.id);
  assert.throws(() => store.devices.authenticate(device.token), { code: 'UNAUTHORIZED' });
  const next = store.devices.issue(owner, { label: 'Second', ttlMs: 1000 }); tick(1001);
  assert.throws(() => store.devices.authenticate(next.token), { code: 'UNAUTHORIZED' });
});
test('removing an account cascades only its own data', async t => {
  const { store } = await fixture(t); account(store); account(store, 'user-b'); ingest(store); ingest(store, 'user-b');
  store.credentials.set(owner, 'acc-1', 'imap-password', 'fixture');
  store.accounts.remove(owner, 'acc-1');
  assert.deepEqual(store.messages.list(owner).items, []);
  assert.equal(store.messages.list('user-b').items.length, 1);
});
test('normal archive and rule mail are admitted while excluded source folders cannot advance checkpoints', async t => {
  const { store } = await fixture(t); account(store);
  store.messages.ingest(owner, 'acc-1', { folder: 'Rules/Receipts', folderKind: 'rule', checkpoint: { cursor: 'rule-1' }, messages: [mail()] });
  assert.equal(store.messages.list(owner).items[0].folder, 'Rules/Receipts');
  for (const folderKind of ['spam', 'trash', 'drafts', 'sent']) {
    assert.throws(() => store.messages.ingest(owner, 'acc-1', { folder: folderKind, folderKind, checkpoint: { cursor: 'no' }, messages: [mail(folderKind)] }), { code: 'INVALID_INPUT' });
    assert.equal(store.checkpoints.get(owner, 'acc-1', folderKind), null);
  }
});
test('message and checkpoint limits reject oversized input without advancing persisted state', async t => {
  const { store } = await fixture(t); account(store); ingest(store);
  assert.throws(() => ingest(store, owner, 'acc-1', [{ ...mail('large'), text: 'x'.repeat(2 * 1024 * 1024 + 1) }], 'too-far'), { code: 'INVALID_INPUT' });
  assert.deepEqual(store.checkpoints.get(owner, 'acc-1', 'Archive'), { cursor: 'event-1' });
  assert.throws(() => store.messages.list(owner, { limit: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.messages.list(owner, { accountId: '../other' }), { code: 'INVALID_INPUT' });
});
test('rejected unsafe attachment-root configuration does not leave a database handle open', async t => {
  const { dir, options } = await fixture(t);
  const target = join(dir, 'target'); const linked = join(dir, 'linked'); mkdirSync(target);
  symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const { openStore } = await import('../../src/core/store.mjs'); const path = join(dir, 'rejected.sqlite');
  assert.throws(() => openStore({ ...options, dbPath: path, dataDir: linked }), { code: 'UNSAFE_PATH' });
  for (const name of readdirSync(dir).filter(name => name.startsWith('rejected.sqlite'))) rmSync(join(dir, name));
});
