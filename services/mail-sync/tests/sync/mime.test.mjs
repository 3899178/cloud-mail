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
test('valid MIME with coalesced decoder output reaches bounded staging with exact attachment bytes', async t => {
  const { store, options } = await fixture(t); const a = account(store);
  const original = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < original.length; i++) original[i] = i % 251;
  const encoded = original.toString('base64').match(/.{1,76}/g).join('\r\n');
  const raw = Buffer.from('Content-Type: multipart/mixed; boundary=large\r\n\r\n--large\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=coalesced.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n' + encoded + '\r\n--large--\r\n');
  const sizes = [];
  const parsed = await parseMime(Readable.from([raw]), { stage: chunks => store.attachments.stage(owner, a.id, (async function* () {
    for await (const chunk of chunks) { sizes.push(chunk.length); yield chunk; }
  })()) });
  try {
    assert.equal(parsed.attachments.length, 1);
    assert(sizes.length > 1 && sizes.every(size => size <= 65536), 'decoded chunks must be bounded independent of source framing');
    const saved = [];
    for await (const chunk of parsed.attachments[0].staged.chunks()) saved.push(chunk);
    assert.deepEqual(Buffer.concat(saved), original);
  } finally { await parsed.cleanup(); }
  assert.deepEqual(readdirSync(join(options.dataDir, owner, a.id)), []);
  const controller = new AbortController(); let stagedChunks = 0;
  await assert.rejects(parseMime(Readable.from([raw]), { signal: controller.signal, stage: chunks => store.attachments.stage(owner, a.id, (async function* () {
    for await (const chunk of chunks) { stagedChunks++; yield chunk; controller.abort(); }
  })()) }), { name: 'AbortError' });
  assert.equal(stagedChunks, 1);
  assert.deepEqual(readdirSync(join(options.dataDir, owner, a.id)), []);
});
