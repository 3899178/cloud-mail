import test from 'node:test';
import assert from 'node:assert/strict';
test('manual servers reject private and mixed DNS and pin a public address', async () => {
  const m = await import('../../src/providers/network.mjs').catch(() => ({}));
  assert.equal(typeof m.resolvePublicEndpoint, 'function', 'SSRF guard exists');
  for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '192.0.0.1']) {
    await assert.rejects(m.resolvePublicEndpoint({ host: address, port: 993 }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(m.resolvePublicEndpoint({ host: 'mail.test', port: 993 }, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'INVALID_INPUT' });
  const endpoint = await m.resolvePublicEndpoint({ host: 'mail.test', port: 993 }, async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(endpoint.host, '8.8.8.8'); assert.equal(endpoint.servername, 'mail.test');
});
