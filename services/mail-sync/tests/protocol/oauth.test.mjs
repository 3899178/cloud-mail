import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fixture, owner } from '../core/helpers.mjs';

test('PKCE is encrypted server-side, state is tenant-bound/expiring/one-time, refresh rotates safely', async t => {
  const { store, options, tick } = await fixture(t);
  store.accounts.create(owner, { id: 'google', provider: 'gmail', address: 'user@example.test' });
  const module = await import('../../src/providers/oauth.mjs').catch(() => ({}));
  assert.equal(typeof module.createOAuth, 'function', 'OAuth coordinator exists');
  const requests = []; let challenge;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = new URLSearchParams(body); requests.push(data);
    if (data.get('grant_type') === 'authorization_code') assert.equal(createHash('sha256').update(data.get('code_verifier')).digest('base64url'), challenge);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ access_token: requests.length === 1 ? 'access-one' : 'access-two', refresh_token: requests.length === 1 ? 'refresh-one' : 'refresh-two', expires_in: 3600 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  // Only dependency-injected transport redirects fixture traffic; production URLs remain fixed.
  const oauth = module.createOAuth({ store, clock: options.clock, clients: { gmail: { clientId: 'own-client', clientSecret: 'private-client-secret', redirectUri: 'https://mail.example.test/oauth/gmail' } }, fetcher: (url, init) => fetch(`http://127.0.0.1:${server.address().port}/token`, init) });
  const start = await oauth.start(owner, 'google'); const url = new URL(start.authorizationUrl); const state = url.searchParams.get('state'); challenge = url.searchParams.get('code_challenge');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(start.codeVerifier, undefined);
  assert.deepEqual(oauth.resolve(state), { ownerId: owner, accountId: 'google', provider: 'gmail' });
  await assert.rejects(oauth.complete('other', { state, code: 'code' }), { code: 'UNAUTHORIZED' });
  await oauth.complete(owner, { state, code: 'code' });
  assert.equal(store.accounts.get(owner, 'google').status, 'pending');
  await assert.rejects(oauth.complete(owner, { state, code: 'code' }), { code: 'UNAUTHORIZED' });
  assert.equal((await oauth.auth(owner, 'google')).accessToken, 'access-one');
  tick(3600000);
  const [a, b] = await Promise.all([oauth.auth(owner, 'google'), oauth.auth(owner, 'google')]);
  assert.equal(a.accessToken, 'access-two'); assert.equal(b.accessToken, 'access-two'); assert.equal(requests.length, 2);
  assert.equal(requests[1].get('refresh_token'), 'refresh-one');
  const expired = new URL((await oauth.start(owner, 'google')).authorizationUrl).searchParams.get('state');
  tick(600000);
  assert.throws(() => oauth.resolve(expired), { code: 'UNAUTHORIZED' });
});
