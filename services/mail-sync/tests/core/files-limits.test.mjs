import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, account, ingest, owner, foundation } from './helpers.mjs';

test('attachment bytes roundtrip only through the owning message and generated path', async t => {
  const { store } = await fixture(t); account(store); ingest(store);
  const ref = store.messages.list(owner).items[0].ref;
  const a = await store.attachments.put(owner, ref, { filename: '../../invoice.txt', contentType: 'text/plain', chunks: [Buffer.from('invoice')] });
  assert.equal((await store.attachments.read(owner, ref, a.id)).toString(), 'invoice');
  assert.equal(a.size, 7); assert.equal(a.sha256, '52d6e3de4fa0dcc29946695f93940c3e7f26f30e1e39f4b1a49ad98839112786');
  assert.throws(() => store.attachments.list('user-b', ref), { code: 'NOT_FOUND' });
  await assert.rejects(store.attachments.read('user-b', ref, a.id), { code: 'NOT_FOUND' });
  await assert.rejects(store.attachments.read(owner, ref, '../secret'), { code: 'INVALID_INPUT' });
});
test('attachment directory symlinks are refused even if they point inside dataDir', async t => {
  const { store, options } = await fixture(t); account(store); ingest(store);
  const target = join(options.dataDir, 'somewhere'); mkdirSync(target);
  symlinkSync(target, join(options.dataDir, owner), process.platform === 'win32' ? 'junction' : 'dir');
  const ref = store.messages.list(owner).items[0].ref;
  await assert.rejects(store.attachments.put(owner, ref, { filename: 'test', contentType: 'text/plain', chunks: ['private'] }), { code: 'UNSAFE_PATH' });
});
test('oversized attachment streams leave no downloadable partial data', async t => {
  const { store, options } = await fixture(t); account(store); ingest(store);
  const ref = store.messages.list(owner).items[0].ref;
  async function* chunks() { for (let i = 0; i < 26; i++) yield Buffer.alloc(1024 * 1024); }
  await assert.rejects(store.attachments.put(owner, ref, { filename: 'large', contentType: 'application/octet-stream', chunks: chunks() }), { code: 'PAYLOAD_TOO_LARGE' });
  assert.deepEqual(store.attachments.list(owner, ref), []);
  assert.deepEqual(readdirSync(join(options.dataDir, owner, 'acc-1')), []);
});
test('attachment path directory junction substitution is rejected', async t => {
  const { store, options } = await fixture(t); account(store); ingest(store);
  const ref = store.messages.list(owner).items[0].ref;
  const a = await store.attachments.put(owner, ref, { filename: 'a', contentType: 'text/plain', chunks: ['invoice'] });
  const path = join(options.dataDir, owner, 'acc-1', a.id); const target = join(options.dataDir, 'other-file');
  unlinkSync(path); mkdirSync(target);
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.attachments.read(owner, ref, a.id), { code: 'UNSAFE_PATH' });
});
test('attachment final-file symlink substitution cannot read another file', async t => {
  const { store, options } = await fixture(t); account(store); ingest(store);
  const ref = store.messages.list(owner).items[0].ref;
  const a = await store.attachments.put(owner, ref, { filename: 'a', contentType: 'text/plain', chunks: ['invoice'] });
  const path = join(options.dataDir, owner, 'acc-1', a.id); const target = join(options.dataDir, 'other-file');
  writeFileSync(target, 'private'); unlinkSync(path);
  try { symlinkSync(target, path, 'file'); }
  catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') { t.skip('Windows token lacks file-symlink privilege; run this case on Linux CI'); return; }
    throw e;
  }
  await assert.rejects(store.attachments.read(owner, ref, a.id), { code: 'UNSAFE_PATH' });
});
test('bounded parser queue runs one task at a time and rejects excess queued work', async () => {
  const { createWorkLimits } = await foundation('core/limits');
  assert.equal(typeof createWorkLimits, 'function', 'bounded work queues must exist');
  const limits = createWorkLimits({ maxQueued: 1 });
  let release; const gate = new Promise(resolve => release = resolve); let active = 0; let peak = 0;
  const task = async () => { active++; peak = Math.max(active, peak); await gate; active--; return 'parsed'; };
  const first = limits.parse(task); const second = limits.parse(task);
  await assert.rejects(limits.parse(task), { code: 'BUSY' });
  release(); assert.deepEqual(await Promise.all([first, second]), ['parsed', 'parsed']); assert.equal(peak, 1);
});
test('connection recovery runs at most two concurrent tasks', async () => {
  const { createWorkLimits } = await foundation('core/limits');
  assert.equal(typeof createWorkLimits, 'function', 'bounded reconnect queue must exist');
  const limits = createWorkLimits(); let release; const gate = new Promise(resolve => release = resolve); let count = 0;
  const jobs = [1, 2, 3].map(() => limits.reconnect(async () => { count++; await gate; return count; }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 2); release(); await Promise.all(jobs); assert.equal(count, 3);
});
