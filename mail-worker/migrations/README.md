# Unified feed index (Task 4, operator applied)

`0001_unified_feed.sql` is additive and idempotent on the existing initialized D1 schema. It does not replace a database, alter original tables, renumber IDs, contain credentials, or run automatically in Worker startup/requests. Back up the existing database before the later Task 7 rollout. Apply this exact SQL using the operator's authenticated D1 migration procedure to the intended database only. Local tests apply it solely to an isolated Miniflare database.

The three auxiliary tables contain a backfill watermark/readiness flag, dirty email IDs with random generation stamps, and email ID/source ref/UTC milliseconds. No body, attachment, password or token is copied. Insert/update/delete triggers cover every SQL writer, including existing ingest, deletion, restoration and account moves. Feed reads still join authoritative email and account ownership, soft deletion and message type; the index cannot grant tenant access.

After applying SQL, authenticated `GET /api/unified/messages?source=cloud-mail&limit=1` advances at most 200 original IDs and processes at most 200 dirty IDs per call. Repeat bounded calls until HTTP 200. During backfill or concurrent pending changes, HTTP 503 contains `error.code=LOCAL_INDEX_NOT_READY`, without a completed cursor. Calls are resumable and idempotent; random generation stamps prevent a stale concurrent backfill worker from deleting a newly queued change. Never treat a 503 as an empty mailbox. The original `/api/email/*` and other local routes continue working without this index or the sync service. Large historical initialization and D1 production limits must be measured before rollout.

For status, inspect `SELECT * FROM unified_feed_state` and `SELECT COUNT(*) FROM unified_feed_queue` through operator tooling. Do not manually mark the index ready or discard pending IDs to force a green status. Invalid legacy timestamp data must be repaired under a separate reviewed data procedure; it is not silently omitted.

Rollback first switches the UI/Worker to the original local feed. Then execute only:

```sql
DROP TRIGGER IF EXISTS unified_feed_insert;
DROP TRIGGER IF EXISTS unified_feed_update;
DROP TRIGGER IF EXISTS unified_feed_delete;
DROP TABLE IF EXISTS unified_feed_index;
DROP TABLE IF EXISTS unified_feed_queue;
DROP TABLE IF EXISTS unified_feed_state;
```

Dropping the auxiliary index table also drops its ordering index. Original messages/accounts/users and all legacy schema remain intact. A later reapplication starts a fresh bounded backfill. This procedure has not been run against production.
