export const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL, address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', error_code TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,id)
) STRICT;
CREATE TABLE IF NOT EXISTS credentials (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, kind TEXT NOT NULL, envelope TEXT NOT NULL,
  PRIMARY KEY(owner_id,account_id,kind),
  FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, ref TEXT NOT NULL, source_id TEXT NOT NULL,
  received_at INTEGER NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL, text_body TEXT NOT NULL,
  html_body TEXT NOT NULL, unread INTEGER NOT NULL, folder TEXT NOT NULL,
  PRIMARY KEY(owner_id,ref), UNIQUE(owner_id,account_id,source_id),
  FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS message_page ON messages(owner_id,received_at DESC,ref DESC);
CREATE TABLE IF NOT EXISTS checkpoints (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, folder TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(owner_id,account_id,folder),
  FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS operations (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, account_id TEXT NOT NULL, ref TEXT,
  kind TEXT NOT NULL, state TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS devices (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY(owner_id,id)
) STRICT;
CREATE TABLE IF NOT EXISTS assertion_nonces (
  owner_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(owner_id,nonce)
) STRICT;
CREATE INDEX IF NOT EXISTS assertion_expiry ON assertion_nonces(expires_at);
CREATE TABLE IF NOT EXISTS attachments (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, ref TEXT NOT NULL, id TEXT NOT NULL,
  filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  PRIMARY KEY(owner_id,ref,id),
  FOREIGN KEY(owner_id,ref) REFERENCES messages(owner_id,ref) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS source_catalog (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, location TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(owner_id,account_id,location), FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS message_ready (
  owner_id TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(owner_id,ref), FOREIGN KEY(owner_id,ref) REFERENCES messages(owner_id,ref) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS completed_sweeps (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, id TEXT NOT NULL, targets TEXT NOT NULL,
  PRIMARY KEY(owner_id,account_id,id), FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL, envelope TEXT NOT NULL,
  FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS sync_baselines (
  owner_id TEXT NOT NULL, account_id TEXT NOT NULL, baseline_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,account_id), FOREIGN KEY(owner_id,account_id) REFERENCES accounts(owner_id,id) ON DELETE CASCADE
) STRICT;
PRAGMA user_version=1;
`;
