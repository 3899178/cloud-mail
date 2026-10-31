import { encodeSourceRef, decodeCursor, encodeCursor, fail } from '../../../shared/unified-mail/index.mjs';
import { localDto } from './unified-local';
import { syncRequest, boundedBody, parseJson } from './sync-gateway';
const BATCH = 200;
// Auxiliary index is operator-created. No DDL or changes to legacy mail schema here.
async function advanceIndex(db) {
  let state;
  try {
    state = await db.prepare('SELECT * FROM unified_feed_state WHERE id=1').first();
  } catch {
    fail('LOCAL_INDEX_NOT_READY');
  }
  if (!state) fail('LOCAL_INDEX_NOT_READY');
  if (!state.ready) {
    const {
      results
    } = await db.prepare('SELECT email_id FROM email WHERE email_id>? ORDER BY email_id LIMIT ?').bind(state.watermark, BATCH).all();
    if (results.length) {
      await db.batch([
        ...results.map(r => db.prepare('INSERT OR IGNORE INTO unified_feed_queue(email_id) VALUES(?)').bind(r.email_id)),
        db.prepare('UPDATE unified_feed_state SET watermark=MAX(watermark,?) WHERE id=1').bind(results.at(-1).email_id)
      ]);
    } else {
      await db.prepare('UPDATE unified_feed_state SET ready=1 WHERE id=1 AND watermark=?').bind(state.watermark).run();
    }
  }
  const {
    results
  } = await db.prepare('SELECT q.email_id,q.revision,e.account_id,e.create_time FROM unified_feed_queue q LEFT JOIN email e ON e.email_id=q.email_id ORDER BY q.email_id LIMIT ?').bind(BATCH).all();
  if (results.length) {
    const statements = [];
    for (const r of results) {
      if (r.account_id !== null) {
        const receivedAt = Date.parse(r.create_time.replace(' ', 'T') + 'Z');
        if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) fail('INVALID_INPUT');
        const ref = encodeSourceRef({
          source: 'cloud-mail',
          accountId: String(r.account_id),
          id: String(r.email_id)
        });
        // Conditional insert cannot resurrect a row deleted during an await.
        statements.push(db.prepare('INSERT INTO unified_feed_index(email_id,ref,received_at) SELECT email_id,?,? FROM email WHERE email_id=? AND account_id=? AND create_time=? ON CONFLICT(email_id) DO UPDATE SET ref=excluded.ref,received_at=excluded.received_at').bind(ref, receivedAt, r.email_id, r.account_id, r.create_time));
      } else statements.push(db.prepare('DELETE FROM unified_feed_index WHERE email_id=?').bind(r.email_id));
      statements.push(db.prepare('DELETE FROM unified_feed_queue WHERE email_id=? AND revision=?').bind(r.email_id, r.revision));
    }
    await db.batch(statements);
  }
  // A final empty backfill check avoids an unnecessary retry for small mailboxes.
  await db.prepare('UPDATE unified_feed_state SET ready=1 WHERE id=1 AND NOT EXISTS(SELECT 1 FROM email WHERE email_id>watermark)').run();
}
async function localPage(c, {
  limit,
  cursor,
  accountId
}) {
  const db = c.env.db;
  await advanceIndex(db);
  const owner = c.get('user').userId;
  const filters = ['e.user_id=?', 'a.user_id=?', 'e.is_del=0', 'a.is_del=0', 'e.type=0'];
  const args = [owner, owner];
  if (accountId) {
    filters.push('e.account_id=?');
    args.push(accountId);
  }
  if (cursor) {
    const cur = decodeCursor(cursor);
    filters.push('(i.received_at<? OR (i.received_at=? AND i.ref COLLATE BINARY<?))');
    args.push(cur.receivedAt, cur.receivedAt, cur.ref);
  }
  // Single D1 batch snapshot checks readiness and reads authoritative ownership/visibility together.
  const [status, page] = await db.batch([db.prepare('SELECT ready,EXISTS(SELECT 1 FROM unified_feed_queue) AS pending FROM unified_feed_state WHERE id=1'), db.prepare('SELECT e.email_id,e.account_id,e.create_time,e.subject,e.send_email,e.unread,e.type,i.ref,i.received_at FROM unified_feed_index i JOIN email e ON e.email_id=i.email_id JOIN account a ON a.account_id=e.account_id WHERE ' + filters.join(' AND ') + ' ORDER BY i.received_at DESC,i.ref COLLATE BINARY DESC LIMIT ?').bind(...args, limit)]);
  if (!status.results[0]?.ready || status.results[0].pending) fail('LOCAL_INDEX_NOT_READY');
  return page.results.map(localDto);
}
export async function unifiedFeed(c) {
  const q = c.req.query(),
    limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
  const source = q.source || 'all';
  if (!['all', 'cloud-mail', 'external'].includes(source)) fail('INVALID_INPUT');
  if (q.cursor) decodeCursor(q.cursor);
  if (q.accountId && source === 'all') fail('INVALID_INPUT');
  const local = source === 'external' ? [] : await localPage(c, {
    limit: limit + 1,
    cursor: q.cursor,
    accountId: q.accountId
  });
  let external = [],
    more = false,
    incomplete = false;
  if (source !== 'cloud-mail') try {
    const query = new URLSearchParams({
      limit: String(Math.min(limit + 1, 100))
    });
    if (q.cursor) query.set('cursor', q.cursor);
    if (q.accountId) query.set('accountId', q.accountId);
    const data = parseJson(await boundedBody(await syncRequest(c, {
      path: '/v1/messages?' + query.toString()
    }), 5 * 1024 * 1024));
    external = data.items;
    more = !!data.nextCursor;
  } catch (error) {
    if (source === 'external' || !['SYNC_UNAVAILABLE', 'BUSY', 'PROVIDER_UNAVAILABLE', 'SYNC_FAILED'].includes(error.code)) throw error;
    incomplete = true;
  }
  const ordered = [...local, ...external].sort((a, b) => b.receivedAt - a.receivedAt || (a.ref === b.ref ? 0 : a.ref > b.ref ? -1 : 1));
  const items = ordered.slice(0, limit);
  return {
    items,
    nextCursor: !incomplete && items.length && (ordered.length > limit || more) ? encodeCursor(items.at(-1)) : null,
    incomplete,
    resetRequired: incomplete,
    sources: {
      local: source === 'external' ? 'excluded' : 'ready',
      external: source === 'cloud-mail' ? 'excluded' : incomplete ? 'unavailable' : 'ready'
    }
  };
}
