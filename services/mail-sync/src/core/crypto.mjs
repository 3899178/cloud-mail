import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail } from '../../../../shared/unified-mail/index.mjs';

export function createVault(masterKey) {
  if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) fail('INVALID_KEY');
  const key = Buffer.from(masterKey);
  const aad = (ownerId, accountId, kind) => Buffer.from(JSON.stringify(['mail-sync-v1', ownerId, accountId, kind]));
  return {
    seal(ownerId, accountId, kind, plaintext) {
      if (typeof plaintext !== 'string' || !plaintext.length || Buffer.byteLength(plaintext) > 16384) fail('INVALID_INPUT');
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(ownerId, accountId, kind));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url') });
    },
    open(ownerId, accountId, kind, envelope) {
      try {
        const e = JSON.parse(envelope); if (e.v !== 1) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64url'), { authTagLength: 16 });
        decipher.setAAD(aad(ownerId, accountId, kind)); decipher.setAuthTag(Buffer.from(e.tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(e.data, 'base64url')), decipher.final()]).toString('utf8');
      } catch { fail('CREDENTIAL_UNAVAILABLE'); }
    },
    close() { key.fill(0); },
  };
}
