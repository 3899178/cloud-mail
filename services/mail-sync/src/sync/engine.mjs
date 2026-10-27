import { createHash } from 'node:crypto';
import { encodeSourceRef, fail } from '../../../../shared/unified-mail/index.mjs';
import { createWorkLimits } from '../core/limits.mjs';
import { providerCode } from '../providers/errors.mjs';
import { parseMime } from './mime.mjs';

const normal = new Set(['normal', 'inbox', 'archive', 'rule']);
const location = c => JSON.stringify([c.folder, c.uidValidity, c.remoteId]);
const digest = value => createHash('sha256').update(value).digest('hex');
export function createSyncEngine({ store, registry, limits = createWorkLimits() }) {
  const running = new Map(); const controllers = new Map();
  async function synchronize({ ownerId, accountId, signal }) {
    const account = store.accounts.get(ownerId, accountId);
    if (account.status === 'paused') return account;
    store.accounts.setStatus(ownerId, accountId, 'connecting');
    let session;
    try {
      signal?.throwIfAborted();
      session = await registry.open({ ownerId, account, signal });
      store.attachments.cleanupStages(ownerId, accountId);
      const folders = (await session.folders()).filter(f => normal.has(f.kind));
      if (folders.length > 200) fail('CAPACITY_EXCEEDED');
      if (!folders.length || new Set(folders.map(f => f.id)).size !== folders.length) fail('SYNC_FAILED');
      const snapshots = []; const current = []; let metadataBytes = 0;
      for (const folder of folders) {
        signal?.throwIfAborted();
        const snapshot = await session.snapshot(folder.id, { checkpoint: store.checkpoints.get(ownerId, accountId, folder.id), baselineAt: account.createdAt, signal });
        if (!Array.isArray(snapshot.messages)) fail('SYNC_FAILED');
        if (snapshot.messages.length + current.length > 20000) fail('CAPACITY_EXCEEDED');
        snapshots.push({ folder, snapshot });
        for (const m of snapshot.messages) current.push({ folder: folder.id, uidValidity: String(snapshot.uidValidity), remoteId: String(m.id), fingerprint: m.fingerprint ?? `${m.key || ''}:${m.receivedAt}`, stableId: m.stableId, messageId: m.messageId, receivedAt: m.receivedAt, unread: m.unread, metadata: m });
        metadataBytes += Buffer.byteLength(JSON.stringify(snapshot.messages));
        if (metadataBytes > 8 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
      }
      if (new Set(current.map(location)).size !== current.length) fail('SYNC_FAILED');
      const previous = store.sources.catalog(ownerId, accountId);
      const currentLocations = new Set(current.map(location));
      const previousLocations = new Map(previous.map(c => [location(c), c]));
      const vanished = previous.filter(c => !currentLocations.has(location(c))); const used = new Set();
      const stable = new Map(previous.filter(c => c.stableId).map(c => [c.stableId, c]));
      const fingerprintGroups = new Map();
      for (const c of vanished) { const group = fingerprintGroups.get(c.fingerprint) || []; group.push(c); fingerprintGroups.set(c.fingerprint, group); }
      const completedIds = new Set(previous.filter(c => c.admitted).map(c => c.sourceId));
      const checkpoints = new Map(folders.map(f => [f.id, store.checkpoints.get(ownerId, accountId, f.id)]));
      const hasBaseline = Boolean(store.sources.baseline(ownerId, accountId));
      for (const c of current) {
        let match = previousLocations.get(location(c));
        if (!match && c.stableId) match = stable.get(c.stableId);
        if (!match && c.fingerprint) {
          const group = fingerprintGroups.get(c.fingerprint) || [];
          const candidates = group.filter(p => !used.has(location(p)));
          if (candidates.some(p => p.admitted) && candidates.some(p => !p.admitted)) fail('RESYNC_REQUIRED');
          match = candidates[0];
        }
        if (match) { used.add(location(match)); c.sourceId = match.sourceId; c.admitted = match.admitted; c.receivedAt = match.receivedAt; }
        else {
          const checkpoint = checkpoints.get(c.folder);
          const reset = checkpoint && checkpoint.uidValidity !== c.uidValidity;
          if ((reset || (!checkpoint && hasBaseline)) && c.receivedAt < account.createdAt) fail('RESYNC_REQUIRED');
          c.admitted = checkpoint ? true : c.receivedAt >= account.createdAt;
          c.sourceId = c.stableId ? `s_${digest(c.stableId)}` : `i_${digest(location(c))}`;
        }
      }
      if (Buffer.byteLength(JSON.stringify(current.map(({ metadata, ...c }) => c))) > 8 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
      const hydrated = new Set();
      for (const c of current.filter(c => c.admitted)) {
        signal?.throwIfAborted();
        const ref = encodeSourceRef({ source: 'external', accountId, id: c.sourceId });
        let ready = false;
        try { ready = completedIds.has(c.sourceId) && store.sources.ready(ownerId, ref); } catch (e) { if (e.code !== 'NOT_FOUND') throw e; }
        if (ready || hydrated.has(ref)) continue;
        await limits.parse(async () => {
          const parsed = await parseMime(await session.fetch(c.folder, { ...c.metadata, uidValidity: c.uidValidity }), { signal, stage: chunks => store.attachments.stage(ownerId, accountId, chunks) });
          try {
            // Retain the previous durable checkpoint until ALL messages/attachments/folders finish.
            const checkpoint = store.checkpoints.get(ownerId, accountId, c.folder) || { cursor: '' };
            store.messages.ingest(ownerId, accountId, { folder: c.folder, folderKind: folders.find(f => f.id === c.folder).kind, checkpoint, advanceCheckpoint: false, messages: [{ ...parsed, sourceId: c.sourceId, receivedAt: c.receivedAt, unread: c.unread }] });
            store.sources.clearContent(ownerId, ref);
            for (const a of parsed.attachments) await store.attachments.put(ownerId, ref, { filename: a.filename, contentType: a.contentType, chunks: a.staged.chunks() });
            store.sources.complete(ownerId, ref);
            hydrated.add(ref);
          } finally { await parsed.cleanup(); }
        });
      }
      // Real adapters revalidate inventories to refuse deletion after a mid-sweep folder change.
      for (const { folder, snapshot } of snapshots) if (session.validateSnapshot && !await session.validateSnapshot(folder.id, snapshot)) fail('SYNC_FAILED');
      const finalFolders = (await session.folders()).filter(f => normal.has(f.kind)).map(f => f.id).sort();
      if (JSON.stringify(finalFolders) !== JSON.stringify(folders.map(f => f.id).sort())) fail('SYNC_FAILED');
      store.sources.commit(ownerId, accountId, { catalog: current, expectedFolders: folders.map(f => f.id), checkpoints: snapshots.map(({ folder, snapshot }) => ({ folder: folder.id, cursor: String(snapshot.cursor), uidValidity: String(snapshot.uidValidity), baselineAt: account.createdAt })) });
      for (const pending of store.sources.pendingSweeps(ownerId, accountId)) store.sources.prune(ownerId, accountId, pending);
      if (store.accounts.get(ownerId, accountId).status === 'paused') return store.accounts.get(ownerId, accountId);
      return store.accounts.setStatus(ownerId, accountId, 'active');
    } catch (error) {
      const code = providerCode(error);
      const latest = store.accounts.get(ownerId, accountId); if (latest.status === 'paused') return latest;
      return store.accounts.setStatus(ownerId, accountId, code === 'AUTH_REQUIRED' ? 'needs-auth' : ['STORAGE_FULL', 'RESYNC_REQUIRED', 'CAPACITY_EXCEEDED'].includes(code) ? 'paused' : 'error', code);
    } finally { await session?.close().catch(() => {}); }
  }
  return {
    syncAccount(options) {
      const key = JSON.stringify([options.ownerId, options.accountId]);
      if (running.has(key)) return running.get(key);
      const controller = new AbortController(); controllers.set(key, controller);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const promise = limits.reconnect(() => synchronize({ ...options, signal })).finally(() => { running.delete(key); controllers.delete(key); });
      running.set(key, promise); return promise;
    },
    async stopAccount(ownerId, accountId) { const key = JSON.stringify([ownerId, accountId]); controllers.get(key)?.abort(); await running.get(key); },
  };
}
