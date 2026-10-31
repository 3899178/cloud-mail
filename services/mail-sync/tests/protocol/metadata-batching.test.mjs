import test from 'node:test';
import assert from 'node:assert/strict';
import { imapFixture, wireMime } from './fixtures.mjs';
import { createImapSession } from '../../src/providers/imap.mjs';

async function sessionFor(t, imap) {
  const session = await createImapSession({
    account: { id: 'metadata-batch', provider: 'imap', address: 'fixture@example.test' },
    config: { imap: { host: 'fixture.test', port: imap.port, secure: true } },
    auth: async () => ({ user: 'fixture@example.test', pass: 'synthetic-only' }),
    tlsOptions: { ca: imap.ca },
    endpointResolver: async () => ({ host: '127.0.0.1', port: imap.port, servername: 'fixture.test' }),
  });
  t.after(() => session.close());
  return session;
}

function append(rows, first, last, key = uid => `batch-${uid}`) {
  const raw = wireMime('metadata-only');
  for (let uid = first; uid <= last; uid++) {
    rows.push({ uid, key: key(uid), subject: 'synthetic metadata', unread: false, raw, internalDate: '01-Jan-2020 12:00:00 +0000' });
  }
}

test('10000-message IMAP inventory uses at most ten streamed FETCH round trips without losing rows', async t => {
  const imap = await imapFixture(t);
  append(imap.state.folders.get('Archive'), 1, 10000);
  const session = await sessionFor(t, imap);
  const snapshot = await session.snapshot('Archive');
  assert.deepEqual(snapshot.messages.map(m => m.id), Array.from({ length: 10000 }, (_, i) => String(i + 1)));
  assert.equal(imap.state.metadataRows, 10000, 'complete history metadata still read exactly once');
  assert(imap.state.commands.filter(command => / FETCH /.test(command)).length <= 10, 'latency must not be paid for each hundred-message page');
  assert.equal(await session.validateSnapshot('Archive', snapshot), true);
});

test('fallback inventory hydrates sparse 32-bit UIDs within server command limits', async t => {
  const imap = await imapFixture(t);
  const rows = imap.state.folders.get('Archive');
  const base = 4000000000;
  append(rows, base, base);
  const session = await sessionFor(t, imap);
  const first = await session.snapshot('Archive');
  const catalog = first.messages.map(m => ({ ...m, remoteId: m.id }));
  for (let i = 1; i <= 1500; i++) append(rows, base + i * 2, base + i * 2);
  imap.state.maxCommandBytes = 8192;
  imap.state.commands.length = 0;
  const snapshot = await session.snapshot('Archive', { checkpoint: { uidValidity: first.uidValidity, cursor: first.cursor }, catalog });
  assert.deepEqual(snapshot.messages.map(m => m.id), Array.from({ length: 1501 }, (_, i) => String(base + i * 2)));
  const full = imap.state.commands.filter(command => / FETCH /.test(command) && /ENVELOPE/.test(command));
  assert(full.length > 0);
  assert(full.every(command => Buffer.byteLength(command + '\r\n') <= 8192), 'explicit UID lists must fit the server command limit');
});

test('larger FETCH ranges keep the existing 20000-row inventory refusal', async t => {
  const imap = await imapFixture(t);
  append(imap.state.folders.get('Archive'), 1, 20001);
  const session = await sessionFor(t, imap);
  await assert.rejects(session.snapshot('Archive'), { code: 'CAPACITY_EXCEEDED' });
  assert.equal(imap.state.metadataRows, 0, 'refuse oversized inventory before requesting metadata');
});

test('streamed metadata still refuses the existing 8MiB catalog byte limit', async t => {
  const imap = await imapFixture(t);
  append(imap.state.folders.get('Archive'), 1, 1200, uid => `${'x'.repeat(8000)}-${uid}`);
  const session = await sessionFor(t, imap);
  await assert.rejects(session.snapshot('Archive'), { code: 'CAPACITY_EXCEEDED' });
});
