import test from 'node:test';
import assert from 'node:assert/strict';
import { imapFixture, wireMime } from './fixtures.mjs';
import { fixture, owner } from '../core/helpers.mjs';
import { openStore } from '../../src/core/store.mjs';
import { createImapSession } from '../../src/providers/imap.mjs';
import { createSyncEngine } from '../../src/sync/engine.mjs';

for (const condstore of [true, false]) test(`Gmail received self-send survives archive/restart while sent-only and trash stay excluded (CONDSTORE=${condstore})`, async t => {
 const imap = await imapFixture(t); imap.state.gmail = true; imap.state.condstore = condstore;
 imap.state.folders.set('AllMail', []);
 const f = await fixture(t); let store = f.store; let now = Date.now();
 const account = store.accounts.create(owner, { id: 'gmail-received', provider: 'gmail', address: 'fixture@example.test' });
 const options = { account, clock: () => now, config: { imap: { host: 'fixture.test', port: imap.port, secure: true } }, auth: async () => ({ user: account.address, pass: 'fixture-only' }), tlsOptions: { ca: imap.ca }, endpointResolver: async () => ({ host: '127.0.0.1', port: imap.port, servername: 'fixture.test' }) };
 const registry = { open: () => createImapSession(options) };
 let engine = createSyncEngine({ store, registry });
 const sync = () => engine.syncAccount({ ownerId: owner, accountId: account.id });
 assert.equal((await sync()).status, 'active');

 const self = { uid: 1, emailId: '101', key: 'received-self', subject: 'received-self', unread: true, labels: ['\\Inbox', '\\Sent'], raw: wireMime('received-self'), modseq: 2 };
 const sentOnly = { ...self, uid: 2, emailId: '202', key: 'sent-only', subject: 'sent-only', labels: ['\\Sent'], raw: wireMime('sent-only') };
 imap.state.folders.get('INBOX').push(self);
 imap.state.folders.get('AllMail').push({ ...self, uid: 3 }, sentOnly);
 imap.state.modseq = 2;
 assert.equal((await sync()).status, 'active');
 const items = store.messages.list(owner).items;
 assert.deepEqual(items.map(row => row.subject), ['received-self'], 'an actual Inbox delivery with Sent label is received exactly once');
 const ref = items[0].ref, attachment = store.messages.get(owner, ref).attachments[0];
 assert.deepEqual(await store.attachments.read(owner, ref, attachment.id), Buffer.from([0, 1, 2, 255]));

 imap.state.folders.get('INBOX').length = 0;
 const archived = imap.state.folders.get('AllMail')[0]; archived.labels = ['\\Sent']; archived.modseq = 3; imap.state.modseq = 3;
 assert.equal((await sync()).status, 'active');
 assert.equal(store.messages.list(owner).items.length, 1, 'archive retains previously received identity without admitting a sent-only message');
 assert.equal(store.messages.get(owner, ref).folder, 'AllMail');
 assert.equal(store.messages.get(owner, ref).attachments[0].id, attachment.id);

 store.close(); store = openStore(f.options);
 try {
  engine = createSyncEngine({ store, registry }); now += 300001;
  assert.equal((await sync()).status, 'active', 'full inventory audit after restart retains the received identity');
  assert.equal(store.messages.list(owner).items[0].ref, ref);
  assert.equal(store.messages.list(owner).items.length, 1);
  assert.deepEqual(await store.attachments.read(owner, ref, attachment.id), Buffer.from([0, 1, 2, 255]));

  archived.labels = ['\\Sent', '\\Trash']; archived.modseq = 4; imap.state.modseq = 4;
  assert.equal((await sync()).status, 'active');
  assert.equal(store.messages.list(owner).items.length, 0, 'prior receipt never overrides Trash exclusion');
  await assert.rejects(store.attachments.read(owner, ref, attachment.id), { code: 'NOT_FOUND' });
 } finally { store.close(); }
});

for (const condstore of [true, false]) for (const historical of [true, false]) test(`Gmail stable receipt moves without AllMail (CONDSTORE=${condstore}, historical=${historical})`, async t => {
 const imap = await imapFixture(t); imap.state.gmail = true; imap.state.condstore = condstore;
 const { store } = await fixture(t);
 const account = store.accounts.create(owner, { id: 'gmail-move', provider: 'gmail', address: 'fixture@example.test' });
 const message = { uid: 1, emailId: '505', key: 'move-self', subject: 'move-self', labels: ['\\Inbox', '\\Sent'], unread: true, raw: wireMime('move-self'), modseq: 1, ...(historical ? { internalDate: '01-Jan-2020 12:00:00 +0000' } : {}) };
 imap.state.folders.get('INBOX').push(message);
 const registry = { open: () => createImapSession({ account, config: { imap: { host: 'fixture.test', port: imap.port, secure: true } }, auth: async () => ({ user: account.address, pass: 'fixture-only' }), tlsOptions: { ca: imap.ca }, endpointResolver: async () => ({ host: '127.0.0.1', port: imap.port, servername: 'fixture.test' }) }) };
 const engine = createSyncEngine({ store, registry }); const sync = () => engine.syncAccount({ ownerId: owner, accountId: account.id });
 assert.equal((await sync()).status, 'active');
 const before = store.messages.list(owner).items;
 assert.equal(before.length, historical ? 0 : 1);
 imap.state.folders.get('INBOX').length = 0;
 imap.state.folders.get('Rules').push({ ...message, uid: 7, labels: ['\\Sent'], modseq: 2 }); imap.state.modseq = 2;
 assert.equal((await sync()).status, 'active');
 const catalog = store.sources.catalog(owner, account.id);
 assert.equal(catalog.length, 1, 'stable receipt evidence survives a new-folder UID without an AllMail copy');
 assert.equal(catalog[0].admitted, !historical);
 assert.equal(catalog[0].folder, 'Rules');
 if (historical) assert.equal(store.messages.list(owner).items.length, 0);
 else assert.equal(store.messages.list(owner).items[0].ref, before[0].ref);
});

for (const condstore of [true, false]) test(`Gmail upgrade shares historical evidence across same-sweep folder UIDs (CONDSTORE=${condstore})`, async t => {
 const imap = await imapFixture(t); imap.state.gmail = true; imap.state.condstore = condstore; imap.state.folders.set('AllMail', []);
 const { store } = await fixture(t); let legacy = true; let now = Date.now();
 const account = store.accounts.create(owner, { id: 'gmail-same-sweep', provider: 'gmail', address: 'fixture@example.test' });
 const old = { uid: 1, emailId: '606', key: 'historical-shared', subject: 'historical-shared', labels: ['\\Inbox', '\\Sent'], unread: true, raw: wireMime('historical-shared'), internalDate: '01-Jan-2020 12:00:00 +0000' };
 imap.state.folders.get('INBOX').push(old); imap.state.folders.get('AllMail').push({ ...old });
 const registry = { async open() {
  const session = await createImapSession({ account, clock: () => now, config: { imap: { host: 'fixture.test', port: imap.port, secure: true } }, auth: async () => ({ user: account.address, pass: 'fixture-only' }), tlsOptions: { ca: imap.ca }, endpointResolver: async () => ({ host: '127.0.0.1', port: imap.port, servername: 'fixture.test' }) });
  const snapshot = session.snapshot;
  return { ...session, async snapshot(...args) { const result = await snapshot(...args); return legacy ? { ...result, messages: [] } : result; } };
 } };
 const engine = createSyncEngine({ store, registry }); const sync = () => engine.syncAccount({ ownerId: owner, accountId: account.id });
 assert.equal((await sync()).status, 'active'); legacy = false; now += 300001;
 imap.state.folders.get('INBOX')[0] = { ...old, uid: 2 }; imap.state.modseq = 2;
 assert.equal((await sync()).status, 'active');
 assert.equal(store.messages.list(owner).items.length, 0, 'old AllMail UID evidence prevents the same historical identity entering through a new Inbox UID');
 assert.ok(store.sources.catalog(owner, account.id).every(row => row.admitted === false));
});

for (const condstore of [true, false]) test(`Gmail filter update preserves historical exclusion and new UID admission (CONDSTORE=${condstore})`, async t => {
 const imap = await imapFixture(t); imap.state.gmail = true; imap.state.condstore = condstore; imap.state.folders.set('AllMail', []);
 const f = await fixture(t); const { store } = f; let now = Date.now(); let legacy = true;
 const account = store.accounts.create(owner, { id: 'gmail-update', provider: 'gmail', address: 'fixture@example.test' });
 const old = { uid: 1, emailId: '303', key: 'historical-self', subject: 'historical-self', unread: true, labels: ['\\Inbox', '\\Sent'], raw: wireMime('historical-self'), internalDate: '01-Jan-2020 12:00:00 +0000', modseq: 1 };
 imap.state.folders.get('INBOX').push(old); imap.state.folders.get('AllMail').push({ ...old });
 const registry = { async open() {
  const session = await createImapSession({ account, clock: () => now, config: { imap: { host: 'fixture.test', port: imap.port, secure: true } }, auth: async () => ({ user: account.address, pass: 'fixture-only' }), tlsOptions: { ca: imap.ca }, endpointResolver: async () => ({ host: '127.0.0.1', port: imap.port, servername: 'fixture.test' }) });
  const snapshot = session.snapshot;
  return { ...session, async snapshot(...args) {
   const result = await snapshot(...args);
   // Model the prior released filter, which omitted Sent-labelled receipts
   // but still durably advanced the real wire UIDNEXT checkpoint.
   return legacy ? { ...result, messages: result.messages.filter(m => m.stableId !== '303') } : result;
  } };
 } };
 const engine = createSyncEngine({ store, registry }); const sync = () => engine.syncAccount({ ownerId: owner, accountId: account.id });
 assert.equal((await sync()).status, 'active'); assert.equal(store.messages.list(owner).items.length, 0);
 legacy = false; now += 300001;
 assert.equal((await sync()).status, 'active');
 assert.equal(store.messages.list(owner).items.length, 0, 'changing the filter must not import an old UID omitted by the released filter');

 // Losing and later regaining Inbox assigns a new UID in Gmail. Its persisted
 // negative admission must survive via the same stable message identity.
 imap.state.folders.get('INBOX').length = 0;
 imap.state.folders.get('AllMail')[0].labels = ['\\Sent']; imap.state.folders.get('AllMail')[0].modseq = 2; imap.state.modseq = 2;
 assert.equal((await sync()).status, 'active');
 imap.state.folders.get('INBOX').push({ ...old, uid: 2, modseq: 3 });
 imap.state.folders.get('AllMail')[0].labels = ['\\Inbox', '\\Sent']; imap.state.folders.get('AllMail')[0].modseq = 3; imap.state.modseq = 3;
 assert.equal((await sync()).status, 'active');
 assert.equal(store.messages.list(owner).items.length, 0, 'an old excluded identity must not become new on folder move');

 imap.state.folders.get('INBOX').push({ ...old, uid: 3, emailId: '404', key: 'new-old-date', subject: 'new-old-date', raw: wireMime('new-old-date'), modseq: 4 });
 imap.state.folders.get('AllMail').push({ ...old, uid: 2, emailId: '404', key: 'new-old-date', subject: 'new-old-date', raw: wireMime('new-old-date'), modseq: 4 }); imap.state.modseq = 4;
 assert.equal((await sync()).status, 'active');
 assert.deepEqual(store.messages.list(owner).items.map(m => m.subject), ['new-old-date'], 'genuine post-checkpoint APPEND with an old date still counts as a new arrival');
});
