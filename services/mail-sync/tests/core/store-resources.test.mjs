import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, account, ingest, mail } from './helpers.mjs';

test('owned prepared statements bound native compilations across interleaved tenants, rollback and reopen', async t => {
  const original = DatabaseSync.prototype.prepare; let compilations = 0;
  DatabaseSync.prototype.prepare = function(sql) { compilations++; return original.call(this, sql); };
  t.after(() => { DatabaseSync.prototype.prepare = original; });
  const { store, options } = await fixture(t);
  for (const who of ['alpha', 'beta']) account(store, who, 'shared');
  for (let n = 0; n < 2000; n++) {
    const who = n % 2 ? 'alpha' : 'beta';
    ingest(store, who, 'shared', [mail(`m-${n}`, n)], `cursor-${n}`);
    store.credentials.set(who, 'shared', 'password', who);
    assert.equal(store.credentials.get(who, 'shared', 'password'), who);
  }
  assert.throws(() => ingest(store, 'alpha', 'shared', [mail('rolled-back'), { ...mail('bad'), unread: 'bad' }], 'bad'));
  assert.equal(store.checkpoints.get('alpha', 'shared', 'Archive').cursor, 'cursor-1999');
  assert.equal(store.messages.list('alpha').items.length, 50);
  assert.ok(store.messages.list('beta').items.every(m => m.receivedAt % 2 === 0));
  assert.equal(store.assertions.consume('alpha', 'nonce', options.clock() + 10000), true);
  assert.equal(store.assertions.consume('alpha', 'nonce', options.clock() + 10000), false);
  assert.equal(store.assertions.consume('beta', 'nonce', options.clock() + 10000), true);
  const db = new DatabaseSync(options.dbPath);
  db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON messages WHEN NEW.source_id='native-error' BEGIN SELECT RAISE(ABORT,'fixture native error'); END;");
  assert.throws(() => ingest(store, 'alpha', 'shared', [mail('native-prefix'), mail('native-error')], 'native-error'), /fixture native error/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE source_id IN ('rolled-back','native-prefix')").get().n, 0);
  ingest(store, 'beta', 'shared', [mail('after-native-error', 2002)], 'native-recovered');
  assert.equal(store.checkpoints.get('alpha', 'shared', 'Archive').cursor, 'cursor-1999');
  assert.equal(store.checkpoints.get('beta', 'shared', 'Archive').cursor, 'native-recovered');
  db.close();
  t.diagnostic(`native compilations=${compilations} across 2000 interleaved writes plus native error/rollback/reuse`);
  assert.ok(compilations < 64, `native prepare count ${compilations} must stay bounded`);
  store.close(); assert.throws(() => store.accounts.list('alpha')); store.close();
  const { openStore } = await import('../../src/core/store.mjs'); const reopened = openStore(options);
  try { assert.equal(reopened.credentials.get('beta', 'shared', 'password'), 'beta'); assert.equal(reopened.checkpoints.get('alpha', 'shared', 'Archive').cursor, 'cursor-1999'); } finally { reopened.close(); }
});

test('unchanged complete catalog sweep performs no source_catalog writes and changed sweep deletes exact locations', async t => {
  const { store, options } = await fixture(t); account(store, 'alpha', 'shared');
  const db = new DatabaseSync(options.dbPath);
  db.exec(`CREATE TABLE audit(op TEXT); CREATE TRIGGER catalog_insert AFTER INSERT ON source_catalog BEGIN INSERT INTO audit VALUES('insert'); END; CREATE TRIGGER catalog_delete AFTER DELETE ON source_catalog BEGIN INSERT INTO audit VALUES('delete'); END; CREATE TRIGGER catalog_update AFTER UPDATE ON source_catalog BEGIN INSERT INTO audit VALUES('update'); END;`);
  const c = n => ({ folder: 'Archive', uidValidity: '1', remoteId: String(n), sourceId: `s-${n}`, fingerprint: `f-${n}`, receivedAt: n, unread: true, admitted: false });
  const commit = catalog => store.sources.commit('alpha', 'shared', { catalog, expectedFolders: ['Archive'], checkpoints: [{ folder: 'Archive', uidValidity: '1', cursor: 'cursor', baselineAt: 1 }] });
  commit([c(1), c(2)]); db.exec('DELETE FROM audit');
  commit([c(1), c(2)]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n, 0);
  commit([{ ...c(2), unread: false }, c(3)]);
  assert.deepEqual(db.prepare('SELECT op FROM audit ORDER BY op').all().map(r => r.op), ['delete', 'insert', 'update']);
  assert.deepEqual(store.sources.catalog('alpha', 'shared').map(c => [c.remoteId, c.unread]), [['2', false], ['3', true]]);
  db.close();
});
