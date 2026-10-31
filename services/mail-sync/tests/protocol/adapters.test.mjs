import test from 'node:test';
import assert from 'node:assert/strict';
import { imapFixture, smtpFixture, wireMime } from './fixtures.mjs';
import { fixture, owner } from '../core/helpers.mjs';
import { createHash } from 'node:crypto';
test('presets retain TLS and school/manual require explicit hosts; adapter factory exists', async () => {
  const m = await import('../../src/providers/imap.mjs').catch(() => ({}));
  assert.equal(typeof m.createImapSession, 'function', 'IMAP/SMTP protocol session exists');
  for (const name of ['gmail', 'outlook', 'qq', 'icloud', '163', '126', 'yeah']) {
    const c = m.mailConfig(name);
    assert.equal(c.imap.secure, true); assert.ok(c.smtp.secure || c.smtp.requireTLS);
  }
  assert.throws(() => m.mailConfig('school'), { code: 'INVALID_INPUT' });
  assert.throws(() => m.mailConfig('imap', { imap: { host: 'mail.test', port: 143, secure: false }, smtp: { host: 'mail.test', port: 25, secure: false } }), { code: 'INVALID_INPUT' });
});
test('real TLS IMAP/SMTP: auth, folder inventory, MIME bytes, source flags/trash, reconnect, acceptance uncertainty', async t => {
  const imap = await imapFixture(t); const smtp = await smtpFixture(t);
  const { createImapSession } = await import('../../src/providers/imap.mjs');
  const { store } = await fixture(t);
  const a = store.accounts.create(owner, { id: 'wire', provider: 'imap', address: 'user@example.test' });
  imap.state.folders.get('Archive').push({ uid: 3, key: 'wire-new', subject: 'wire-new', unread: true, raw: wireMime('wire-new') });
  const options = { account: a, config: { imap: { host: 'imap.fixture.test', port: imap.port, secure: true }, smtp: { host: 'smtp.fixture.test', port: smtp.port, secure: true } }, auth: async () => ({ user: a.address, pass: 'fixture-only-password' }), tlsOptions: { ca: imap.ca }, endpointResolver: async endpoint => ({ host: '127.0.0.1', port: endpoint.port, servername: 'fixture.test' }) };
  let session = await createImapSession(options); t.after(() => session.close());
  const folders = await session.folders(); assert.equal(folders.find(f => f.id === 'Junk').kind, 'spam'); assert.equal(folders.find(f => f.id === 'Archive').kind, 'archive');
  const snapshot = await session.snapshot('Archive'); assert.equal(snapshot.messages.length, 1);
  const stream = await session.fetch('Archive', snapshot.messages[0]); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), createHash('sha256').update(wireMime('wire-new')).digest('hex'));
  assert.equal(await session.validateSnapshot('Archive', snapshot), true);
  await session.flags({ folder: 'Archive', uidValidity: '100', remoteId: '3' }, false); assert.equal(imap.state.folders.get('Archive')[0].unread, false);
  await session.trash({ folder: 'Archive', uidValidity: '100', remoteId: '3' }); assert.equal(imap.state.folders.get('Archive').length, 0); assert.equal(imap.state.folders.get('Trash').length, 1);
  await session.send({ from: a.address, to: ['target@example.test'], text: 'wire send', subject: 'wire' }); assert.equal(smtp.state.received.length, 1);
  smtp.state.uncertain = true;
  await assert.rejects(session.send({ from: a.address, to: ['target@example.test'], text: 'uncertain' })); assert.equal(smtp.state.received.length, 2);
  await session.close(); session = await createImapSession(options); assert.equal(imap.state.connections, 2);
  await session.close(); imap.state.authFailure = true;
  await assert.rejects(createImapSession(options), error => error.authenticationFailed === true);
});
test('wire adapters feed durable synchronization and uncertain-send ledger end to end', async t => {
  const imap = await imapFixture(t); const smtp = await smtpFixture(t); const { store } = await fixture(t);
  const account = store.accounts.create(owner, { id: 'durable-wire', provider: 'imap', address: 'user@example.test' });
  store.credentials.set(owner, account.id, 'protocol', JSON.stringify({ password: 'fixture-only', config: { imap: { host: 'imap.fixture.test', port: imap.port, secure: true }, smtp: { host: 'smtp.fixture.test', port: smtp.port, secure: true } } }));
  imap.state.folders.get('Archive').push({ uid: 3, key: 'wire-archive', subject: 'wire-archive', unread: true, raw: wireMime('wire-archive') });
  imap.state.folders.get('Rules').push({ uid: 4, key: 'wire-rules', subject: 'wire-rules', unread: true, raw: wireMime('wire-rules') });
  const { createProviderRegistry } = await import('../../src/providers/registry.mjs'); const { createImapSession } = await import('../../src/providers/imap.mjs');
  const { createSyncEngine } = await import('../../src/sync/engine.mjs'); const { createActions } = await import('../../src/send/actions.mjs');
  const registry = createProviderRegistry({ store, sessionFactory: options => createImapSession({ ...options, tlsOptions: { ca: imap.ca }, endpointResolver: async endpoint => ({ host: '127.0.0.1', port: endpoint.port, servername: 'fixture.test' }) }) }); t.after(() => registry.close());
  const engine = createSyncEngine({ store, registry }); const actions = createActions({ store, registry });
  assert.equal((await engine.syncAccount({ ownerId: owner, accountId: account.id })).status, 'active');
  assert.equal(store.messages.list(owner).items.length, 2);
  const saved = store.messages.list(owner).items[0]; const attachment = store.messages.get(owner, saved.ref).attachments[0];
  assert.deepEqual(await store.attachments.read(owner, saved.ref, attachment.id), Buffer.from([0, 1, 2, 255]));
  assert.equal((await actions.execute({ ownerId: owner, accountId: account.id, ref: saved.ref, kind: 'mark-read' })).state, 'succeeded');
  smtp.state.uncertain = true;
  const operation = await actions.execute({ ownerId: owner, accountId: account.id, kind: 'send', message: { to: ['target@example.test'], text: 'uncertain wire' } });
  assert.equal(operation.state, 'uncertain'); assert.equal(operation.errorCode, 'SEND_UNCERTAIN'); assert.equal(smtp.state.received.length, 1);
  await engine.syncAccount({ ownerId: owner, accountId: account.id }); assert.equal(smtp.state.received.length, 1);
});
test('STARTTLS upgrades before AUTH, verifies original hostname and refuses missing/refused TLS', async t => {
  const module = await import('./fixtures.mjs'); assert.equal(typeof module.starttlsFixture, 'function', 'real STARTTLS fixture exists');
  const imap = await imapFixture(t); const { createImapSession } = await import('../../src/providers/imap.mjs');
  for (const mode of ['upgrade', 'hostname-mismatch', 'withheld', 'refused']) await t.test(mode, async t => {
    const smtp = await module.starttlsFixture(t, { advertise: mode !== 'withheld', refuse: mode === 'refused' || mode === 'withheld' });
    const session = await createImapSession({ account: {}, config: { imap: { host: 'imap.fixture.test', port: imap.port, secure: true }, smtp: { host: 'smtp.fixture.test', port: smtp.port, secure: false, requireTLS: true } }, auth: async () => ({ user: 'fixture@example.test', pass: 'fixture-only' }), tlsOptions: { ca: imap.ca }, endpointResolver: async endpoint => ({ host: '127.0.0.1', port: endpoint.port, servername: endpoint.port === smtp.port && mode === 'hostname-mismatch' ? 'wrong-original-host.test' : 'fixture.test' }) }); t.after(() => session.close());
    const send = session.send({ from: 'fixture@example.test', to: ['target@example.test'], text: 'TLS required' });
    if (mode === 'upgrade') { await send; assert.equal(smtp.state.received.length, 1); assert.equal(smtp.state.tlsAuth, 1); }
    else { await assert.rejects(send, mode === 'hostname-mismatch' ? /hostname|Host|altnames|certificate/i : undefined); assert.equal(smtp.state.received.length, 0); assert.equal(smtp.state.tlsAuth, 0); }
    assert.equal(smtp.state.plaintextAuth, 0); assert.equal(smtp.state.starttls, 1);
  });
});
