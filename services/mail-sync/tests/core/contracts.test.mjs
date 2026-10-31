import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contracts from '../../../../shared/unified-mail/index.mjs';

test('source refs distinguish providers and reject malformed or excessive identifiers', () => {
  assert.equal(typeof contracts.encodeSourceRef, 'function', 'pure shared source-ref contract must exist');
  const external = contracts.encodeSourceRef({ source: 'external', accountId: 'a', id: '42' });
  const original = contracts.encodeSourceRef({ source: 'cloud-mail', accountId: 'a', id: '42' });
  assert.notEqual(external, original);
  assert.deepEqual(contracts.decodeSourceRef(external), { source: 'external', accountId: 'a', id: '42' });
  for (const ref of ['42', external + '!', 'x'.repeat(4097)]) assert.throws(() => contracts.decodeSourceRef(ref), { code: 'INVALID_REF' });
  assert.throws(() => contracts.encodeSourceRef({ source: 'external', accountId: '../a', id: '1' }), { code: 'INVALID_REF' });
});
test('cursor preserves hand checked timestamp and stable ref ordering and rejects corruption', () => {
  assert.equal(typeof contracts.encodeCursor, 'function', 'pure shared cursor contract must exist');
  const cursor = contracts.encodeCursor({ receivedAt: 1700000000000, ref: contracts.encodeSourceRef({ source: 'external', accountId: 'a', id: '1' }) });
  assert.equal(contracts.decodeCursor(cursor).receivedAt, 1700000000000);
  assert.throws(() => contracts.decodeCursor(cursor + '!'), { code: 'INVALID_CURSOR' });
  assert.throws(() => contracts.encodeCursor({ receivedAt: -1, ref: 'bad' }), { code: 'INVALID_CURSOR' });
});
test('assertion verification requires nonce persistence to explicitly succeed, including async stores', async () => {
  const key = new Uint8Array(32).fill(3); const now = 1700000000000;
  const token = await contracts.signGatewayAssertion({ key, ownerId: 'user-a', method: 'GET', path: '/v1/accounts', now });
  await assert.rejects(contracts.verifyGatewayAssertion({ key, token, method: 'GET', path: '/v1/accounts', now, consumeNonce: async () => false }), { code: 'UNAUTHORIZED' });
});
