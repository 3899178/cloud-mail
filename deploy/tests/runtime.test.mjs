import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
test('private container listener is explicit opt-in while assertions remain required', async () => {
  const path = resolve('services/mail-sync/src/listener.mjs'); assert(existsSync(path), 'listener policy required');
  const { listenHost } = await import(pathToFileURL(path));
  assert.equal(listenHost({}), '127.0.0.1');
  assert.equal(listenHost({ MAIL_SYNC_PRIVATE_CONTAINER: '1' }), '0.0.0.0');
  assert.throws(() => listenHost({ MAIL_SYNC_PRIVATE_CONTAINER: 'yes' }));
  assert.match(readFileSync('services/mail-sync/src/app.mjs','utf8'), /verifyGatewayAssertion/);
});
test('one combined cgroup and no unrestricted host publish', () => {
  assert(existsSync('deploy/compose.yaml'), 'bounded compose required');
  const value = readFileSync('deploy/compose.yaml','utf8');
  assert.match(value, /mem_limit: 335544320/); assert.match(value, /mem_reservation: 268435456/);
  assert.match(value, /memswap_limit: 335544320/); assert.doesNotMatch(value, /ports:|privileged: true|docker.sock/);
  assert.match(value, /cliproxy_proxy/); assert.match(value, /read_only: true/);
});
