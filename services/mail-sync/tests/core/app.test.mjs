import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, ingest, owner, foundation } from './helpers.mjs';
const key = new Uint8Array(32).fill(19);
import * as contracts from '../../../../shared/unified-mail/index.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function appFixture(t) {
  const f = await fixture(t); account(f.store); account(f.store, 'user-b'); ingest(f.store);
  const { createSyncApp } = await foundation('app');
  assert.equal(typeof createSyncApp, 'function', 'authenticated Hono composition must exist');
  const app = createSyncApp({ store: f.store, gatewayKey: key, clock: f.options.clock });
  const sign = async (path = '/v1/accounts', overrides = {}) => contracts.signGatewayAssertion({ key, ownerId: owner, method: 'GET', path, now: f.options.clock(), ...overrides });
  return { ...f, app, sign };
}

test('invalid gateway headers with an open body cannot block an authenticated request', async t => {
  const { app, sign } = await appFixture(t);
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode('{}')); } });
  const invalid = app.request(new Request('http://localhost/v1/accounts', { method: 'POST', body: stream, duplex: 'half', headers: { 'x-gateway-assertion': 'garbage' } }));
  const valid = app.request('/v1/accounts', { headers: { 'x-gateway-assertion': await sign() } });
  t.after(async () => { try { controller.close(); } catch {} await Promise.all([invalid, valid]); });
  const response = await Promise.race([valid, delay(500).then(() => null)]);
  assert.ok(response, 'valid request must finish while the invalid request body remains open');
  assert.equal(response.status, 200);
  assert.equal((await invalid).status, 401);
});

test('aborting an authenticated network body releases its admission', async t => {
  const { app, sign } = await appFixture(t);
  const abort = new AbortController(); let controller;
  const stream = new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode('{}')); } });
  const pending = app.request(new Request('http://localhost/v1/accounts', { method: 'POST', body: stream, duplex: 'half', signal: abort.signal, headers: { 'x-gateway-assertion': await sign('/v1/accounts', { method: 'POST', body: '{}' }) } }));
  t.after(async () => { try { controller.close(); } catch {} await pending; });
  await delay(10); abort.abort();
  const response = await Promise.race([pending, delay(500).then(() => null)]);
  assert.ok(response, 'aborted authenticated network body must stop waiting');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'BUSY' } });
});

test('an authenticated body has a fifteen-second total read deadline', async t => {
  const { app, sign } = await appFixture(t);
  const token = await sign('/v1/accounts', { method: 'POST', body: '{}' });
  let controller, started;
  const reading = new Promise(resolve => { started = resolve; });
  const stream = new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode('{}')); }, pull() { started(); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = app.request(new Request('http://localhost/v1/accounts', { method: 'POST', body: stream, duplex: 'half', headers: { 'x-gateway-assertion': token } }));
  t.after(async () => { try { controller.close(); } catch {} await pending; });
  await reading; t.mock.timers.tick(15000);
  const response = await Promise.race([pending, new Promise(resolve => setImmediate(() => resolve(null)))]);
  assert.ok(response, 'the body reader must stop at its fixed deadline');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'BUSY' } });
});

test('a body completing after assertion expiry cannot use the earlier header authentication', async t => {
  const { app, sign, tick } = await appFixture(t);
  let controller, started;
  const reading = new Promise(resolve => { started = resolve; });
  const stream = new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode('{}')); }, pull() { started(); } });
  const pending = app.request(new Request('http://localhost/v1/accounts', { method: 'POST', body: stream, duplex: 'half', headers: { 'x-gateway-assertion': await sign('/v1/accounts', { method: 'POST', body: '{}' }) } }));
  t.after(async () => { try { controller.close(); } catch {} await pending; });
  await reading; tick(60001); controller.close();
  assert.equal((await pending).status, 401);
});
test('only valid gateway assertions reach tenant-scoped account and message DTOs', async t => {
  const { app, sign } = await appFixture(t);
  assert.equal((await app.request('/v1/accounts')).status, 401);
  const response = await app.request('/v1/accounts?ownerId=user-b', { headers: { 'x-gateway-assertion': await sign('/v1/accounts?ownerId=user-b') } });
  assert.equal(response.status, 200);
  const dto = await response.json(); assert.equal(dto.accounts[0].address, 'user-a@example.test');
  assert.doesNotMatch(JSON.stringify(dto), /secret|cipher|password/);
});
test('assertions reject expiry, future timestamps, wrong keys and request scope changes', async t => {
  const { app, sign, options } = await appFixture(t);
  for (const token of [await sign('/v1/accounts', { now: options.clock() - 61000 }), await sign('/v1/accounts', { now: options.clock() + 6000 }), await sign('/v1/accounts', { key: new Uint8Array(32).fill(1) }), await sign('/v1/messages')]) {
    const response = await app.request('/v1/accounts', { headers: { 'x-gateway-assertion': token } });
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED' } });
  }
  const token = await sign('/v1/accounts', { method: 'POST', body: '{"a":1}' });
  assert.equal((await app.request('/v1/accounts', { method: 'POST', body: '{"a":2}', headers: { 'x-gateway-assertion': token } })).status, 401);
});
test('assertion replay is rejected across app instances sharing SQLite', async t => {
  const { app, sign, store, options } = await appFixture(t);
  const token = await sign();
  assert.equal((await app.request('/v1/accounts', { headers: { 'x-gateway-assertion': token } })).status, 200);
  const { createSyncApp } = await foundation('app');
  const other = createSyncApp({ store, gatewayKey: key, clock: options.clock });
  assert.equal((await other.request('/v1/accounts', { headers: { 'x-gateway-assertion': token } })).status, 401);
});
test('message detail, missing resources and invalid cursor return safe HTTP errors', async t => {
  const { app, sign, store } = await appFixture(t);
  const ref = store.messages.list(owner).items[0].ref;
  const path = `/v1/messages/${ref}`;
  const response = await app.request(path, { headers: { 'x-gateway-assertion': await sign(path) } });
  assert.equal(response.status, 200); assert.equal((await response.json()).message.text, 'A body');
  for (const [url, code, status] of [['/v1/accounts/missing', 'NOT_FOUND', 404], ['/v1/messages?cursor=bad', 'INVALID_CURSOR', 400]]) {
    const r = await app.request(url, { headers: { 'x-gateway-assertion': await sign(url) } });
    assert.equal(r.status, status); assert.deepEqual(await r.json(), { error: { code } });
  }
});
test('oversized bodies and public provider connection attempts never claim success', async t => {
  const { app, sign } = await appFixture(t);
  const path = '/v1/accounts'; const body = 'x'.repeat(65537);
  const r = await app.request(path, { method: 'POST', body, headers: { 'x-gateway-assertion': await sign(path, { method: 'POST', body }) } });
  assert.equal(r.status, 413); assert.deepEqual(await r.json(), { error: { code: 'PAYLOAD_TOO_LARGE' } });
  const absent = await app.request('/v1/accounts/connect', { method: 'POST', headers: { 'x-gateway-assertion': await sign('/v1/accounts/connect', { method: 'POST' }) } });
  assert.equal(absent.status, 404);
});
test('notification device tokens cannot authenticate gateway mail routes', async t => {
  const { app, store } = await appFixture(t);
  const device = store.devices.issue(owner, { label: 'Phone' });
  const response = await app.request('/v1/messages', { headers: { 'x-gateway-assertion': device.token } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED' } });
});
test('signed owner cannot be replaced by a browser body or a modified assertion payload', async t => {
  const { app, sign } = await appFixture(t);
  const token = await sign(); const [payload, mac] = token.split('.');
  const altered = JSON.parse(Buffer.from(payload, 'base64url')); altered.ownerId = 'user-b';
  const response = await app.request('/v1/accounts', { headers: { 'x-gateway-assertion': `${Buffer.from(JSON.stringify(altered)).toString('base64url')}.${mac}` } });
  assert.equal(response.status, 401);
  const wrongMethod = await app.request('/v1/accounts', { method: 'POST', headers: { 'x-gateway-assertion': await sign() } });
  assert.equal(wrongMethod.status, 401);
});
test('replay protection survives reopening the SQLite database', async t => {
  const { app, sign, options } = await appFixture(t); const token = await sign();
  assert.equal((await app.request('/v1/accounts', { headers: { 'x-gateway-assertion': token } })).status, 200);
  const { openStore } = await foundation('core/store'); const otherStore = openStore(options);
  try {
    const { createSyncApp } = await foundation('app'); const other = createSyncApp({ store: otherStore, gatewayKey: key, clock: options.clock });
    assert.equal((await other.request('/v1/accounts', { headers: { 'x-gateway-assertion': token } })).status, 401);
  } finally { otherStore.close(); }
});
