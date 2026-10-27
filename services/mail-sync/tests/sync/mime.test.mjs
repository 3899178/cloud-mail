import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fixture, account, owner } from '../core/helpers.mjs';
import { parseMime } from '../../src/sync/mime.mjs';
test('staging errors clean bounded original bytes; restart removes only generated stage files', async t => {
  const { store, options } = await fixture(t); const a = account(store);
  async function* broken() { yield Buffer.from('bytes'); throw Error('fixture interruption'); }
  await assert.rejects(store.attachments.stage(owner, a.id, broken()), /fixture interruption/);
  const dir = join(options.dataDir, owner, a.id); assert.deepEqual(readdirSync(dir), []);
  const staged = await store.attachments.stage(owner, a.id, [Buffer.from([0, 1, 255])]);
  const chunks = []; for await (const chunk of staged.chunks()) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 1, 255]));
  store.attachments.cleanupStages(owner, a.id); assert.deepEqual(readdirSync(dir), []);
  await staged.cleanup();
});
test('MIME raw-size limit stops parsing before any checkpoint or unbounded body is retained', async t => {
  const { store } = await fixture(t); const a = account(store);
  async function* raw() { yield Buffer.from('Content-Type: text/plain\r\n\r\n'); for (let i = 0; i < 37; i++) yield Buffer.alloc(1024 * 1024, 65); }
  await assert.rejects(parseMime(Readable.from(raw()), { stage: chunks => store.attachments.stage(owner, a.id, chunks) }), { code: 'PAYLOAD_TOO_LARGE' });
  assert.equal(store.checkpoints.get(owner, a.id, 'INBOX'), null); assert.equal(store.messages.list(owner).items.length, 0);
});
