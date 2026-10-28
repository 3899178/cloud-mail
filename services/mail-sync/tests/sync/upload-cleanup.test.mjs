import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fixture, account, owner } from '../core/helpers.mjs';
import { createSyncApp } from '../../src/app.mjs';
import { signGatewayAssertion } from '../../../../shared/unified-mail/index.mjs';

const key = new Uint8Array(32).fill(8);
const sha256 = createHash('sha256').update('x').digest('hex');
const metadata = size => ({ accountId: 'acc-1', filename: 'a', size, sha256 });
const stages = dataDir => readdirSync(dataDir, { recursive: true }).filter(name => name.includes('.compose-'));
function injectCleanup(store, failure) {
  const stage = store.attachments.stage.bind(store.attachments);
  let index = 0;
  store.attachments.stage = async (...args) => {
    const saved = await stage(...args), id = index++;
    return { ...saved, async cleanup() {
      if (failure(id)) throw Object.assign(new Error('isolated unlink fault'), { code: 'EIO' });
      await saved.cleanup();
    } };
  };
}
async function ready(app, uploads) {
  const upload = await uploads.create(owner, metadata(1));
  await uploads.receive(owner, upload.id, upload.capability, new Request('https://test/upload', { method: 'PUT', body: 'x' }));
  return upload;
}

test('failed stage deletion keeps nonconsumable handle and reserved quota until a real retry deletes the file', async t => {
  const { store, options } = await fixture(t); account(store);
  let fail = true; injectCleanup(store, () => fail);
  const app = createSyncApp({ store, gatewayKey: key }), uploads = app.services.uploads;
  t.after(async () => { fail = false; await app.services.close(); });
  const upload = await ready(app, uploads);
  for (const size of [25 * 1024 ** 2, 25 * 1024 ** 2, 25 * 1024 ** 2, 25 * 1024 ** 2 - 1]) await uploads.create(owner, metadata(size));
  await assert.rejects(uploads.cancel(owner, upload.id), error => error.code === 'EIO');
  assert.equal(stages(options.dataDir).length, 1);
  await assert.rejects(uploads.create(owner, metadata(1)), error => error.code === 'STORAGE_FULL');
  await assert.rejects(uploads.take(owner, 'acc-1', [upload.id], {}), error => error.code === 'INVALID_TRANSITION');
  fail = false;
  await uploads.cancel(owner, upload.id);
  assert.equal(stages(options.dataDir).length, 0);
  assert.ok((await uploads.create(owner, metadata(1))).id);
});

test('close attempts every stage even if one unlink fails and a later close retries the retained file', async t => {
  const { store, options } = await fixture(t); account(store);
  let firstFailure = true;
  injectCleanup(store, id => id === 0 && firstFailure);
  const app = createSyncApp({ store, gatewayKey: key });
  t.after(async () => { firstFailure = false; await app.services.close(); });
  await ready(app, app.services.uploads); await ready(app, app.services.uploads);
  await app.services.uploads.close();
  assert.equal(stages(options.dataDir).length, 1);
  firstFailure = false;
  await app.services.uploads.close();
  assert.equal(stages(options.dataDir).length, 0);
});

test('a failed transfer retains its early stage handle if cleanup also fails', async t => {
  const { store, options } = await fixture(t); account(store);
  const stage = store.attachments.stage.bind(store.attachments);
  let fail = true;
  store.attachments.stage = async (who, id, chunks, options) => {
    const saved = await stage(who, id, chunks, { compose: true });
    options.onStage({ async cleanup() {
      if (fail) throw Object.assign(new Error('isolated unlink fault'), { code: 'EIO' });
      await saved.cleanup();
    } });
    throw new Error('isolated transfer failure');
  };
  const app = createSyncApp({ store, gatewayKey: key });
  t.after(async () => { fail = false; await app.services.close(); });
  const upload = await app.services.uploads.create(owner, metadata(1));
  await assert.rejects(app.services.uploads.receive(owner, upload.id, upload.capability,
    new Request('https://test/upload', { method: 'PUT', body: 'x' })));
  assert.equal(stages(options.dataDir).length, 1);
  fail = false; await app.services.uploads.cancel(owner, upload.id);
  assert.equal(stages(options.dataDir).length, 0);
});

test('cleanup EIO cannot override definite or uncertain durable send result and cannot skip provider close', async t => {
  for (const uncertain of [false, true]) {
    await t.test(uncertain ? 'uncertain' : 'definite', async t => {
      const { store, options } = await fixture(t); account(store);
      let fail = true, closes = 0;
      injectCleanup(store, () => fail);
      const registry = { async open() { return {
        async send(message) {
          for await (const _chunk of message.attachments[0].content) { /* consume original bytes */ }
          if (uncertain) throw new Error('transport lost after submission');
        }, async close() { closes++; }
      }; }, async close() {} };
      const app = createSyncApp({ store, gatewayKey: key, registry });
      t.after(async () => { fail = false; await app.services.close(); });
      const upload = await ready(app, app.services.uploads);
      const path = '/v1/send';
      const body = JSON.stringify({ accountId: 'acc-1', kind: 'send', message: { to: ['to@example.test'], uploadIds: [upload.id] } });
      const response = await app.request('https://test' + path, { method: 'POST', body,
        headers: { 'x-gateway-assertion': await signGatewayAssertion({ key, ownerId: owner, method: 'POST', path, body }) } });
      assert.equal(closes, 1);
      assert.equal(response.status, 200);
      const { operation } = await response.json();
      assert.equal(operation.state, uncertain ? 'uncertain' : 'succeeded');
      assert.equal(store.operations.get(owner, operation.id).state, operation.state);
      assert.equal(stages(options.dataDir).length, 1);
      fail = false; await app.services.uploads.cancel(owner, upload.id);
      assert.equal(stages(options.dataDir).length, 0);
    });
  }
});
