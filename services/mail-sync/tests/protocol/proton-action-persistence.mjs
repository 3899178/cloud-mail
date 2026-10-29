// Invoked by the Go actual-HTTP JSON regression with production helper response
// envelopes. This fixture transport is not the deployment Unix socket runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fixture, owner } from '../core/helpers.mjs';
import { wireMime } from './fixtures.mjs';
import { createProton } from '../../src/providers/proton.mjs';
import { createAccountLifecycle } from '../../src/core/lifecycle.mjs';
import { createSyncEngine } from '../../src/sync/engine.mjs';

const responses = JSON.parse(process.env.CLOUD_MAIL_ACTION_FIXTURE);
for (const malformed of ['missing', 'null', 'negative', 'unknown', 'string', 'fraction']) {
  test(`actual helper ${malformed} Action refuses deletion and preserves admitted MIME`, async t => {
    const { store, options } = await fixture(t);
    const account = store.accounts.create(owner, { id: 'proton-action', provider: 'proton', address: 'user@proton.me' });
    store.credentials.set(owner, account.id, 'proton', JSON.stringify({ auth: { RefreshToken: 'fixture' } }));
    let phase = 'baseline'; let bodyReads = 0;
    const transport = {
      async rpc(request) {
        if (request.op === 'open') return { material: request.material, session: 'fixture-session', expiresAt: options.clock() + 600000 };
        if (request.op === 'folders') return { folders: [{ id: '0', kind: 'inbox' }] };
        if (request.op === 'validate') return { valid: true };
        if (request.op === 'snapshot') {
          const result = responses[phase];
          if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
          return result;
        }
        return { ok: true };
      },
      async fetch() { bodyReads++; return Readable.from([wireMime('admitted', 'preserved original body')]); },
    };
    const lifecycle = createAccountLifecycle({ store });
    const proton = createProton({ store, lifecycle, transport, clock: options.clock });
    const engine = createSyncEngine({ store, lifecycle, registry: { open: request => proton.adapter(request) } });
    const sync = () => engine.syncAccount({ ownerId: owner, accountId: account.id });
    assert.equal((await sync()).status, 'active');
    const ref = store.messages.list(owner).items[0].ref;
    const checkpoint = store.checkpoints.get(owner, account.id, '0');
    const catalog = store.sources.catalog(owner, account.id);
    const message = store.messages.get(owner, ref);
    assert.match(message.text, /preserved original body/);
    const attachments = store.attachments.list(owner, ref);
    assert.equal(attachments.length, 1);
    const bytes = await store.attachments.read(owner, ref, attachments[0].id);
    assert.deepEqual(bytes, Buffer.from([0, 1, 2, 255]));
    phase = malformed;
    assert.equal((await sync()).errorCode, 'SYNC_FAILED');
    assert.deepEqual(store.checkpoints.get(owner, account.id, '0'), checkpoint);
    assert.deepEqual(store.sources.catalog(owner, account.id), catalog);
    assert.deepEqual(store.messages.get(owner, ref), message);
    assert.deepEqual(store.attachments.list(owner, ref), attachments);
    assert.deepEqual(await store.attachments.read(owner, ref, attachments[0].id), bytes);
    assert.equal(bodyReads, 1);
    phase = 'retry';
    assert.equal((await sync()).status, 'active');
    assert.equal(store.checkpoints.get(owner, account.id, '0').cursor, 'next');
    assert.equal(store.messages.get(owner, ref).unread, false);
    assert.equal(store.messages.get(owner, ref).text, message.text);
    assert.deepEqual(await store.attachments.read(owner, ref, attachments[0].id), bytes);
    assert.equal(bodyReads, 1);
    phase = 'delete';
    assert.equal((await sync()).status, 'active');
    assert.equal(store.sources.catalog(owner, account.id).length, 0);
    assert.equal(store.messages.list(owner).items.length, 0, 'explicit Action:0 retains deletion authority');
  });
}
