import { randomUUID } from 'node:crypto';
import { fail, encodeSourceRef, identifier } from '../../../../shared/unified-mail/index.mjs';
import { text, integer } from './validation.mjs';

export function createReconciliation({ run, all, get, transaction, accountRow, messageRow, attachments }) {
  const refFor = (accountId, sourceId) => encodeSourceRef({ source: 'external', accountId, id: sourceId });
  return {
    baseline(who, accountId) { accountRow(who, accountId); return get('SELECT baseline_at AS baselineAt FROM sync_baselines WHERE owner_id=? AND account_id=?', who, accountId) || null; },
    catalog(who, accountId) {
      accountRow(who, accountId);
      return all('SELECT value FROM source_catalog WHERE owner_id=? AND account_id=? ORDER BY location', who, accountId).map(r => JSON.parse(r.value));
    },
    ready(who, ref) {
      messageRow(who, ref);
      return Boolean(get('SELECT 1 FROM message_ready WHERE owner_id=? AND ref=?', who, ref));
    },
    complete(who, ref) { messageRow(who, ref); run('INSERT INTO message_ready VALUES(?,?) ON CONFLICT DO NOTHING', who, ref); },
    clearContent(who, ref) { messageRow(who, ref); attachments.removeMessageFiles(who, ref); run('DELETE FROM message_ready WHERE owner_id=? AND ref=?', who, ref); },
    commit(who, accountId, { catalog, checkpoints, expectedFolders }) {
      accountRow(who, accountId);
      if (!Array.isArray(catalog) || catalog.length > 20000 || !Array.isArray(checkpoints) || checkpoints.length > 200 || !Array.isArray(expectedFolders) || !expectedFolders.length) fail('INVALID_INPUT');
      const expected = new Set(expectedFolders.map(f => text(f, 1024)));
      if (expected.size !== expectedFolders.length || checkpoints.length !== expected.size || new Set(checkpoints.map(c => c.folder)).size !== expected.size || checkpoints.some(c => !expected.has(c.folder))) fail('INCOMPLETE_SWEEP');
      const clean = catalog.map(c => {
        text(c.folder, 1024); text(c.uidValidity, 128); text(c.remoteId, 512); text(c.sourceId, 512); text(c.fingerprint, 2048, true);
        if (!expected.has(c.folder)) fail('INCOMPLETE_SWEEP');
        if (c.stableId !== undefined) text(c.stableId, 512);
        if (typeof c.admitted !== 'boolean' || typeof c.unread !== 'boolean') fail('INVALID_INPUT');
        integer(c.receivedAt);
        if (c.messageId !== undefined) text(c.messageId, 8192, true);
        return { folder: c.folder, uidValidity: c.uidValidity, remoteId: c.remoteId, sourceId: c.sourceId, fingerprint: c.fingerprint, stableId: c.stableId, messageId: c.messageId, admitted: c.admitted, unread: c.unread, receivedAt: c.receivedAt };
      });
      if (Buffer.byteLength(JSON.stringify(clean)) > 8 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
      const present = new Set(clean.filter(c => c.admitted).map(c => c.sourceId));
      // Only previously cataloged messages are candidates, never a blanket account query.
      const deleted = [...new Set(this.catalog(who, accountId).filter(c => c.admitted && !present.has(c.sourceId)).map(c => refFor(accountId, c.sourceId)))];
      const sweepId = randomUUID();
      transaction(() => {
        run('DELETE FROM source_catalog WHERE owner_id=? AND account_id=?', who, accountId);
        for (const c of clean) {
          run('INSERT INTO source_catalog VALUES(?,?,?,?)', who, accountId, JSON.stringify([c.folder, c.uidValidity, c.remoteId]), JSON.stringify(c));
          if (c.admitted) run('UPDATE messages SET unread=?,folder=? WHERE owner_id=? AND ref=?', Number(c.unread), c.folder, who, refFor(accountId, c.sourceId));
        }
        for (const c of checkpoints) {
          text(c.folder, 1024); text(c.cursor, 8192, true); text(c.uidValidity, 128); integer(c.baselineAt);
          run('INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(owner_id,account_id,folder) DO UPDATE SET value=excluded.value', who, accountId, c.folder, JSON.stringify({ cursor: c.cursor, uidValidity: c.uidValidity, baselineAt: c.baselineAt }));
        }
        run('INSERT INTO completed_sweeps VALUES(?,?,?,?)', who, accountId, sweepId, JSON.stringify(deleted));
        run('INSERT INTO sync_baselines VALUES(?,?,?) ON CONFLICT DO NOTHING', who, accountId, accountRow(who, accountId).created_at);
      });
      return sweepId;
    },
    // Exact completed-sweep capability gates explicitly captured tenant-owned deletion targets.
    prune(who, accountId, sweepId) {
      accountRow(who, accountId); identifier(sweepId);
      const sweep = get('SELECT targets FROM completed_sweeps WHERE owner_id=? AND account_id=? AND id=?', who, accountId, sweepId);
      if (!sweep) fail('INCOMPLETE_SWEEP');
      const present = new Set(this.catalog(who, accountId).filter(c => c.admitted).map(c => refFor(accountId, c.sourceId)));
      for (const ref of JSON.parse(sweep.targets)) {
        if (present.has(ref)) continue;
        const row = get('SELECT account_id FROM messages WHERE owner_id=? AND ref=?', who, ref);
        if (!row) continue;
        if (row.account_id !== accountId) fail('NOT_FOUND');
        attachments.removeMessageFiles(who, ref);
        run('DELETE FROM messages WHERE owner_id=? AND account_id=? AND ref=?', who, accountId, ref);
      }
      run('DELETE FROM completed_sweeps WHERE owner_id=? AND account_id=? AND id=?', who, accountId, sweepId);
    },
    pendingSweeps(who, accountId) { accountRow(who, accountId); return all('SELECT id FROM completed_sweeps WHERE owner_id=? AND account_id=?', who, accountId).map(r => r.id); },
    update(who, ref, { unread }) { messageRow(who, ref); if (typeof unread !== 'boolean') fail('INVALID_INPUT'); run('UPDATE messages SET unread=? WHERE owner_id=? AND ref=?', Number(unread), who, ref); },
  };
}
