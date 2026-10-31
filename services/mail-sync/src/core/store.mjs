import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { decodeCursor, decodeSourceRef, encodeCursor, encodeSourceRef, fail, identifier } from '../../../../shared/unified-mail/index.mjs';
import { createVault } from './crypto.mjs';
import { schema } from './schema.mjs';
import { choice, errorCode, integer, text } from './validation.mjs';
import { createAttachments } from './attachments.mjs';
import { createReconciliation } from './reconciliation.mjs';

const accountDto = r => ({ id: r.id, provider: r.provider, address: r.address, status: r.status, errorCode: r.error_code, createdAt: r.created_at });
const messageDto = (r, detail = false) => ({ ref: r.ref, accountId: r.account_id, source: 'external', receivedAt: r.received_at, subject: r.subject, from: r.sender, unread: Boolean(r.unread), folder: r.folder, ...(detail ? { text: r.text_body, html: r.html_body } : {}) });
const operationDto = r => ({ id: r.id, accountId: r.account_id, ref: r.ref, kind: r.kind, state: r.state, errorCode: r.error_code, createdAt: r.created_at, updatedAt: r.updated_at });
const deviceDto = r => ({ id: r.id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, scopes: ['notifications'] });
const hash = token => createHash('sha256').update(token).digest('hex');

export function openStore({ dbPath, dataDir, masterKey, clock = Date.now }) {
  if (typeof dbPath !== 'string' || typeof dataDir !== 'string' || typeof clock !== 'function') fail('INVALID_INPUT');
  const vault = createVault(masterKey);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-8192;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) fail('UNSUPPORTED_SCHEMA');
    db.exec(schema);
    if (process.platform !== 'win32') chmodSync(dbPath, 0o600);
  } catch (e) { db.close(); vault.close(); throw e; }
  // Store-owned, bounded SQL-only LRU. No iterator escapes: run/get/all reset the
  // native statement before reuse, including failures; bindings are supplied anew.
  const statements = new Map();
  function prepared(sql) {
    let statement = statements.get(sql);
    if (statement) statements.delete(sql);
    else statement = db.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > 128) statements.delete(statements.keys().next().value);
    return statement;
  }
  const run = (sql, ...args) => prepared(sql).run(...args);
  const get = (sql, ...args) => prepared(sql).get(...args);
  const all = (sql, ...args) => prepared(sql).all(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const owner = who => identifier(who);
  function accountRow(who, id) {
    owner(who); identifier(id);
    const row = get('SELECT * FROM accounts WHERE owner_id=? AND id=?', who, id);
    if (!row) fail('NOT_FOUND'); return row;
  }
  function messageRow(who, ref) {
    owner(who); const parsed = decodeSourceRef(ref);
    if (parsed.source !== 'external') fail('NOT_FOUND');
    const row = get('SELECT * FROM messages WHERE owner_id=? AND ref=?', who, ref);
    if (!row) fail('NOT_FOUND'); return row;
  }
  const accounts = {
    create(who, { id = randomUUID(), provider, address }) {
      owner(who); identifier(id); choice(provider, ['imap', 'gmail', 'outlook', 'proton', 'qq', 'icloud', '163', '126', 'yeah', 'school']); text(address, 320);
      if (get('SELECT 1 FROM accounts WHERE owner_id=? AND id=?', who, id)) fail('CONFLICT');
      run('INSERT INTO accounts(owner_id,id,provider,address,created_at) VALUES(?,?,?,?,?)', who, id, provider, address, clock());
      return accountDto(accountRow(who, id));
    },
    get(who, id) { return accountDto(accountRow(who, id)); },
    list(who) { owner(who); return all('SELECT * FROM accounts WHERE owner_id=? ORDER BY created_at,id', who).map(accountDto); },
    scheduled() { return all("SELECT owner_id,id,status FROM accounts WHERE status IN ('active','connecting','error') ORDER BY owner_id,id").map(r => ({ ownerId: r.owner_id, accountId: r.id, status: r.status })); },
    setStatus(who, id, status, code = null) {
      accountRow(who, id); choice(status, ['pending', 'connecting', 'active', 'paused', 'needs-auth', 'error']);
      run('UPDATE accounts SET status=?,error_code=? WHERE owner_id=? AND id=?', status, errorCode(code), who, id);
      return accountDto(accountRow(who, id));
    },
    remove(who, id) {
      accountRow(who, id); attachments.removeAccountFiles(who, id);
      run('DELETE FROM accounts WHERE owner_id=? AND id=?', who, id);
    },
  };
  const credentials = {
    set(who, id, kind, value) {
      accountRow(who, id); identifier(kind);
      const envelope = vault.seal(who, id, kind, value);
      run('INSERT INTO credentials VALUES(?,?,?,?) ON CONFLICT(owner_id,account_id,kind) DO UPDATE SET envelope=excluded.envelope', who, id, kind, envelope);
    },
    get(who, id, kind) {
      accountRow(who, id); identifier(kind);
      const r = get('SELECT envelope FROM credentials WHERE owner_id=? AND account_id=? AND kind=?', who, id, kind);
      if (!r) fail('NOT_FOUND'); return vault.open(who, id, kind, r.envelope);
    },
  };
  const checkpoints = {
    get(who, id, folder) {
      accountRow(who, id); text(folder, 1024);
      const r = get('SELECT value FROM checkpoints WHERE owner_id=? AND account_id=? AND folder=?', who, id, folder);
      return r ? JSON.parse(r.value) : null;
    },
  };
  const messages = {
    ingest(who, id, { folder, folderKind = 'normal', checkpoint, messages: incoming, advanceCheckpoint = true }) {
      accountRow(who, id); text(folder, 1024); choice(folderKind, ['normal', 'inbox', 'archive', 'rule']);
      if (!Array.isArray(incoming) || incoming.length > 100 || !checkpoint || typeof checkpoint !== 'object') fail('INVALID_INPUT');
      const clean = { cursor: text(checkpoint.cursor, 8192, true) };
      if (checkpoint.uidValidity !== undefined) clean.uidValidity = text(checkpoint.uidValidity, 128);
      if (checkpoint.baselineAt !== undefined) clean.baselineAt = integer(checkpoint.baselineAt);
      return transaction(() => {
        let inserted = 0; let batchBytes = 0;
        for (const m of incoming) {
          const sourceId = text(m.sourceId, 512); const ref = encodeSourceRef({ source: 'external', accountId: id, id: sourceId });
          integer(m.receivedAt); text(m.subject ?? '', 8192, true); text(m.from ?? '', 8192, true);
          const body = text(m.text ?? '', 2 * 1024 * 1024, true); const html = text(m.html ?? '', 2 * 1024 * 1024, true);
          batchBytes += Buffer.byteLength(body) + Buffer.byteLength(html); if (batchBytes > 8 * 1024 * 1024) fail('PAYLOAD_TOO_LARGE');
          if (typeof m.unread !== 'boolean') fail('INVALID_INPUT');
          inserted += Number(run('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,account_id,source_id) DO NOTHING', who, id, ref, sourceId, m.receivedAt, m.subject ?? '', m.from ?? '', body, html, Number(m.unread), folder).changes);
        }
        if (advanceCheckpoint) run('INSERT INTO checkpoints VALUES(?,?,?,?) ON CONFLICT(owner_id,account_id,folder) DO UPDATE SET value=excluded.value', who, id, folder, JSON.stringify(clean));
        return { inserted, checkpoint: clean };
      });
    },
    list(who, { limit = 50, cursor, accountId } = {}) {
      owner(who); integer(limit, 1, 100);
      const after = cursor == null ? null : decodeCursor(cursor);
      const args = [who]; let where = 'owner_id=?';
      if (accountId !== undefined) { accountRow(who, accountId); where += ' AND account_id=?'; args.push(accountId); }
      if (after) { where += ' AND (received_at<? OR (received_at=? AND ref<?))'; args.push(after.receivedAt, after.receivedAt, after.ref); }
      const rows = all(`SELECT ref,account_id,received_at,subject,sender,unread,folder FROM messages WHERE ${where} ORDER BY received_at DESC,ref DESC LIMIT ?`, ...args, limit + 1);
      const more = rows.length > limit; const items = rows.slice(0, limit).map(r => messageDto(r));
      return { items, nextCursor: more ? encodeCursor(items.at(-1)) : null };
    },
    get(who, ref) { return { ...messageDto(messageRow(who, ref), true), attachments: attachments.list(who, ref) }; },
  };
  const operationRow = (who, id) => {
    owner(who); identifier(id); const r = get('SELECT * FROM operations WHERE owner_id=? AND id=?', who, id);
    if (!r) fail('NOT_FOUND'); return r;
  };
  const operations = {
    recover() {
      run("UPDATE operations SET state=CASE WHEN kind IN ('send','reply','forward') THEN 'uncertain' ELSE 'failed' END,error_code=CASE WHEN kind IN ('send','reply','forward') THEN 'SEND_UNCERTAIN' ELSE 'SYNC_FAILED' END,updated_at=? WHERE state IN ('queued','running')", clock());
    },
    create(who, { accountId, ref = null, kind }) {
      accountRow(who, accountId); choice(kind, ['mark-read', 'mark-unread', 'delete', 'send', 'reply', 'forward']);
      if (ref !== null && messageRow(who, ref).account_id !== accountId) fail('NOT_FOUND');
      const id = randomUUID(); const now = clock();
      run('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)', who, id, accountId, ref, kind, 'queued', null, now, now);
      return operationDto(operationRow(who, id));
    },
    get(who, id) { return operationDto(operationRow(who, id)); },
    list(who) { owner(who); return all('SELECT * FROM operations WHERE owner_id=? ORDER BY created_at DESC,id LIMIT 100', who).map(operationDto); },
    update(who, id, { state, errorCode: code = null }) {
      const previous = operationRow(who, id); errorCode(code);
      choice(state, ['queued', 'running', 'succeeded', 'failed', 'uncertain']);
      if (state === 'queued' || !['queued', 'running'].includes(previous.state)) fail('INVALID_TRANSITION');
      run('UPDATE operations SET state=?,error_code=?,updated_at=? WHERE owner_id=? AND id=?', state, code, clock(), who, id);
      return operationDto(operationRow(who, id));
    },
  };
  const devices = {
    issue(who, { label, ttlMs = 30 * 86400000 }) {
      owner(who); text(label, 128); integer(ttlMs, 1000, 90 * 86400000);
      const id = randomUUID(); const token = randomBytes(32).toString('base64url'); const now = clock();
      run('INSERT INTO devices VALUES(?,?,?,?,?,?,?)', who, id, label, hash(token), now, now + ttlMs, null);
      return { ...deviceDto(get('SELECT * FROM devices WHERE owner_id=? AND id=?', who, id)), token };
    },
    list(who) { owner(who); return all('SELECT * FROM devices WHERE owner_id=? ORDER BY created_at,id', who).map(deviceDto); },
    revoke(who, id) {
      owner(who); identifier(id);
      if (!get('SELECT 1 FROM devices WHERE owner_id=? AND id=?', who, id)) fail('NOT_FOUND');
      run('UPDATE devices SET revoked_at=? WHERE owner_id=? AND id=?', clock(), who, id);
    },
    authenticate(token) {
      if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) fail('UNAUTHORIZED');
      const r = get('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?', hash(token), clock());
      if (!r) fail('UNAUTHORIZED'); return { ownerId: r.owner_id, ...deviceDto(r) };
    },
  };
  const assertions = {
    consume(who, nonce, expiresAt) {
      owner(who); identifier(nonce); integer(expiresAt);
      return transaction(() => {
        run('DELETE FROM assertion_nonces WHERE expires_at<=?', clock());
        return Boolean(run('INSERT INTO assertion_nonces VALUES(?,?,?) ON CONFLICT(owner_id,nonce) DO NOTHING', who, nonce, expiresAt).changes);
      });
    },
  };
  let attachments;
  try { attachments = createAttachments({ dataDir, run, all, get, messageRow }); }
  catch (e) { statements.clear(); db.close(); vault.close(); throw e; }
  let closed = false;
  const sources = createReconciliation({ run, all, get, transaction, accountRow, messageRow, attachments });
  const oauthStates = {
    create(who, accountId, value, ttlMs = 600000) {
      accountRow(who, accountId); integer(ttlMs, 1000, 600000);
      const state = randomBytes(32).toString('base64url'); const expiresAt = clock() + ttlMs;
      transaction(() => {
        run('DELETE FROM oauth_states WHERE expires_at<=? OR (owner_id=? AND account_id=?)', clock(), who, accountId);
        run('INSERT INTO oauth_states VALUES(?,?,?,?,?)', hash(state), who, accountId, expiresAt, vault.seal(who, accountId, 'oauth-state', JSON.stringify(value)));
      });
      return state;
    },
    resolve(state) {
      if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state)) fail('UNAUTHORIZED');
      const row = get('SELECT owner_id,account_id FROM oauth_states WHERE state_hash=? AND expires_at>?', hash(state), clock());
      if (!row) fail('UNAUTHORIZED');
      return { ownerId: row.owner_id, accountId: row.account_id };
    },
    consume(who, state) {
      const identity = this.resolve(state); if (identity.ownerId !== who) fail('UNAUTHORIZED');
      return transaction(() => {
        const row = get('SELECT envelope FROM oauth_states WHERE state_hash=? AND owner_id=? AND expires_at>?', hash(state), who, clock());
        if (!row) fail('UNAUTHORIZED');
        run('DELETE FROM oauth_states WHERE state_hash=? AND owner_id=?', hash(state), who);
        return { ...identity, value: JSON.parse(vault.open(who, identity.accountId, 'oauth-state', row.envelope)) };
      });
    },
  };
  return { accounts, credentials, messages, checkpoints, operations, devices, assertions, attachments, sources, oauthStates, close() { if (!closed) { statements.clear(); db.close(); vault.close(); closed = true; } } };
}
