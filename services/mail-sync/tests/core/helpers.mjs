import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export const owner = 'user-a';
export const masterKey = new Uint8Array(32).fill(7);
export const tempBase = fileURLToPath(new URL('../../../../.data/test-tmp/', import.meta.url));
mkdirSync(tempBase, { recursive: true });
export async function foundation(name) {
  return import(`../../src/${name}.mjs`);
}
export async function fixture(t) {
  const { openStore } = await foundation('core/store');
  assert.equal(typeof openStore, 'function', 'SQLite tenant store must exist');
  const dir = mkdtempSync(join(tempBase, 'mail-sync-'));
  let now = 1793100000000;
  const options = { dbPath: join(dir, 'mail.sqlite'), dataDir: join(dir, 'data'), masterKey, clock: () => now };
  const store = openStore(options);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, options, tick: ms => now += ms };
}
export function account(store, who = owner, id = 'acc-1') {
  return store.accounts.create(who, { id, provider: 'imap', address: `${who}@example.test` });
}
export const mail = (sourceId = 'm-1', receivedAt = 1000) => ({ sourceId, receivedAt, subject: 'Hello', from: 'sender@example.test', text: 'A body', html: '<p>A body</p>', unread: true, folder: 'Archive' });
export function ingest(store, who = owner, id = 'acc-1', messages = [mail()], cursor = 'event-1') {
  return store.messages.ingest(who, id, { folder: 'Archive', checkpoint: { cursor }, messages });
}
