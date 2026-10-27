import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from '../../src/core/crypto.mjs';

test('credential decryption rejects truncated GCM tags with CREDENTIAL_UNAVAILABLE', () => {
  const vault = createVault(new Uint8Array(32).fill(7));
  try {
    const envelope = vault.seal('user-a', 'acc-1', 'imap-password', 'private');
    const altered = JSON.parse(envelope);
    altered.tag = Buffer.from(altered.tag, 'base64url').subarray(0, 4).toString('base64url');
    assert.throws(() => vault.open('user-a', 'acc-1', 'imap-password', JSON.stringify(altered)), { code: 'CREDENTIAL_UNAVAILABLE' });
    assert.equal(vault.open('user-a', 'acc-1', 'imap-password', envelope), 'private');
  } finally { vault.close(); }
});
