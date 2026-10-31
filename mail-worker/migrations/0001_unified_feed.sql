-- Additive, operator-applied migration. Never run implicitly on a request.
CREATE TABLE IF NOT EXISTS unified_feed_state(id INTEGER PRIMARY KEY CHECK(id=1), watermark INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO unified_feed_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS unified_feed_queue(email_id INTEGER PRIMARY KEY, revision TEXT NOT NULL DEFAULT (hex(randomblob(16))));
CREATE TABLE IF NOT EXISTS unified_feed_index(email_id INTEGER PRIMARY KEY, ref TEXT COLLATE BINARY NOT NULL, received_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS unified_feed_order ON unified_feed_index(received_at DESC,ref COLLATE BINARY DESC);
CREATE TRIGGER IF NOT EXISTS unified_feed_insert AFTER INSERT ON email BEGIN INSERT INTO unified_feed_queue(email_id) VALUES(NEW.email_id) ON CONFLICT(email_id) DO UPDATE SET revision=hex(randomblob(16)); END;
CREATE TRIGGER IF NOT EXISTS unified_feed_update AFTER UPDATE ON email BEGIN INSERT INTO unified_feed_queue(email_id) VALUES(NEW.email_id) ON CONFLICT(email_id) DO UPDATE SET revision=hex(randomblob(16)); END;
CREATE TRIGGER IF NOT EXISTS unified_feed_delete AFTER DELETE ON email BEGIN DELETE FROM unified_feed_index WHERE email_id=OLD.email_id; DELETE FROM unified_feed_queue WHERE email_id=OLD.email_id; END;
