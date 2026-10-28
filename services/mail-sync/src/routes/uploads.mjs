import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail, identifier } from '../../../../shared/unified-mail/index.mjs';
import { text, integer } from '../core/validation.mjs';
const MAX = 25 * 1024 * 1024,
  QUOTA = 100 * 1024 * 1024,
  RESERVE = 64 * 1024 * 1024;
export function createUploads({
  store,
  lifecycle,
  clock = Date.now
}) {
  const entries = new Map(),
    key = randomBytes(32);
  let active = 0,
    closed = false;
  store.attachments.cleanupComposeStages();
  const reserved = () => [...entries.values()].reduce((n, e) => n + e.size, 0);
  const owned = (who, id) => {
    identifier(id);
    const e = entries.get(id);
    if (!e || e.ownerId !== who) fail('NOT_FOUND');
    return e;
  };
  async function remove(e) {
    // A cleanup tombstone remains owned, quota-reserved and nonconsumable until unlink succeeds.
    e.state = 'cleanup-pending';
    if (e.cleaning) return e.cleaning;
    e.cleaning = (async () => {
      await e.stage?.cleanup();
      if (entries.get(e.id) === e) entries.delete(e.id);
    })();
    try { await e.cleaning; }
    finally { e.cleaning = null; }
  }
  async function sweep() {
    const expired = [...entries.values()].filter(e => !['uploading', 'consuming'].includes(e.state)
      && (e.state === 'cleanup-pending' || e.expiresAt <= clock() || !e.current()));
    // Failed records stay for the next timer/cancel/close. One bad file cannot block the rest.
    await Promise.allSettled(expired.map(remove));
  }
  const timer = setInterval(() => sweep().catch(() => {}), 30000);
  timer.unref();
  function capability(e) {
    const payload = Buffer.from(JSON.stringify({
      id: e.id,
      ownerId: e.ownerId,
      accountId: e.accountId,
      filename: e.filename,
      contentType: e.contentType,
      size: e.size,
      sha256: e.sha256,
      expiresAt: e.expiresAt,
      path: '/v1/uploads/' + e.id
    })).toString('base64url');
    return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
  }
  function verify(e, cap) {
    if (typeof cap !== 'string' || cap.length > 8192) fail('UNAUTHORIZED');
    const expected = Buffer.from(capability(e));
    const got = Buffer.from(cap);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) fail('UNAUTHORIZED');
  }
  return {
    async create(who, body) {
      await sweep();
      return lifecycle.run(who, body.accountId, lease => {
        if (closed || entries.size >= 16) fail('BUSY');
        text(body.filename, 1024);
        integer(body.size, 0, MAX);
        if (!/^[a-f0-9]{64}$/.test(body.sha256)) fail('INVALID_INPUT');
        const contentType = body.contentType || 'application/octet-stream';
        if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType)) fail('INVALID_INPUT');
        if (reserved() + body.size > QUOTA || store.attachments.availableBytes() < reserved() + body.size + RESERVE) fail('STORAGE_FULL');
        const e = {
          id: randomUUID(),
          ownerId: who,
          accountId: body.accountId,
          filename: body.filename,
          contentType,
          size: body.size,
          sha256: body.sha256,
          expiresAt: clock() + 600000,
          state: 'pending',
          current: lease.current
        };
        entries.set(e.id, e);
        return {
          id: e.id,
          capability: capability(e),
          expiresAt: e.expiresAt,
          size: e.size,
          sha256: e.sha256
        };
      });
    },
    async receive(who, id, cap, request) {
      const e = owned(who, id);
      verify(e, cap);
      if (e.expiresAt <= clock()) {
        await remove(e);
        fail('UPLOAD_EXPIRED');
      }
      if (e.state !== 'pending') fail('CONFLICT');
      if (!e.current()) {
        await remove(e);
        fail('INVALID_TRANSITION');
      }
      if (active >= 2) fail('BUSY');
      return lifecycle.run(who, e.accountId, async lease => {
        e.state = 'uploading';
        active++;
        let reader;
        const abort = () => {
          reader?.cancel().catch(() => {});
        };
        try {
          if (!request.body) fail('INVALID_INPUT');
          reader = request.body.getReader();
          lease.signal.addEventListener('abort', abort, {
            once: true
          });
          const hash = createHash('sha256');
          let size = 0;
          async function* chunks() {
            for (;;) {
              lease.check();
              const {
                done,
                value
              } = await reader.read();
              lease.check();
              if (done) break;
              if (value.byteLength > 262144) fail('PAYLOAD_TOO_LARGE');
              size += value.byteLength;
              if (size > e.size) fail('UPLOAD_CORRUPT');
              hash.update(value);
              for (let i = 0; i < value.length; i += 65536) yield value.subarray(i, i + 65536);
            }
            if (size !== e.size || hash.digest('hex') !== e.sha256) fail('UPLOAD_CORRUPT');
          }
          e.stage = await store.attachments.stage(who, e.accountId, chunks(), {
            compose: true,
            onStage: stage => { e.stage = stage; }
          });
          lease.check();
          e.state = 'ready';
          return {
            id: e.id,
            state: 'ready',
            filename: e.filename,
            size: e.size,
            sha256: e.sha256
          };
        } catch (error) {
          await remove(e).catch(() => {});
          if (['ENOSPC', 'EDQUOT'].includes(error.code)) fail('STORAGE_FULL');
          throw error;
        } finally {
          lease.signal.removeEventListener('abort', abort);
          await reader?.cancel().catch(() => {});
          reader?.releaseLock();
          active--;
        }
      }, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, Math.min(120000, e.expiresAt - clock())))])
      });
    },
    async take(who, accountId, ids, lease) {
      if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) fail('INVALID_INPUT');
      const selected = ids.map(id => {
        const e = owned(who, id);
        if (e.accountId !== accountId) fail('NOT_FOUND');
        if (e.state !== 'ready' || !e.current()) fail('INVALID_TRANSITION');
        if (e.expiresAt <= clock()) fail('UPLOAD_EXPIRED');
        return e;
      });
      // Reserve synchronously before awaiting integrity reads: concurrent sends cannot share handles.
      for (const e of selected) e.state = 'consuming';
      try {
        for (const e of selected) {
          const hash = createHash('sha256');
          let size = 0;
          for await (const chunk of e.stage.chunks()) {
            lease.check();
            hash.update(chunk);
            size += chunk.length;
          }
          lease.check();
          if (size !== e.size || hash.digest('hex') !== e.sha256) fail('UPLOAD_CORRUPT');
        }
        return selected.map(e => ({
          filename: e.filename,
          contentType: e.contentType,
          content: e.stage.chunks(),
          cleanup: () => remove(e)
        }));
      } catch (error) {
        await Promise.allSettled(selected.map(remove));
        throw error;
      }
    },
    async cancel(who, id) {
      const e = owned(who, id);
      if (e.state === 'uploading' || e.state === 'consuming') fail('BUSY');
      await remove(e);
    },
    async clearAccount(who, id) {
      const results = await Promise.allSettled([...entries.values()]
        .filter(e => e.ownerId === who && e.accountId === id).map(remove));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await Promise.allSettled([...entries.values()].map(remove));
      key.fill(0);
    }
  };
}
