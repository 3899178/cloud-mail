import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { openStore } from './core/store.mjs';
import { createSyncApp } from './app.mjs';

// Only this entry point reads private deployment configuration. Never log its values.
function key(name) {
  const value = process.env[name];
  if (!value || !/^[\da-fA-F]{64}$/.test(value)) throw new Error(`Missing or invalid ${name}`);
  return new Uint8Array(Buffer.from(value, 'hex'));
}
const masterKey = key('MAIL_SYNC_MASTER_KEY'); const gatewayKey = key('MAIL_SYNC_GATEWAY_KEY');
const dataDir = resolve(process.env.MAIL_SYNC_DATA_DIR || '.data');
const port = Number(process.env.PORT || 3211);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const store = openStore({ dbPath: resolve(dataDir, 'mail.sqlite'), dataDir: resolve(dataDir, 'attachments'), masterKey });
masterKey.fill(0);
const app = createSyncApp({ store, gatewayKey }); gatewayKey.fill(0);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => { store.close(); process.exit(0); }); });
