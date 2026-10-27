import { constants, lstatSync, mkdirSync, realpathSync, rmSync, readdirSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, identifier } from '../../../../shared/unified-mail/index.mjs';
import { text } from './validation.mjs';

const MAX_ATTACHMENT = 25 * 1024 * 1024;
const dto = r => ({ id: r.id, filename: r.filename, contentType: r.content_type, size: r.size, sha256: r.sha256 });

export function createAttachments({ dataDir, run, all, get, messageRow }) {
  const configured = resolve(dataDir);
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  if (lstatSync(configured).isSymbolicLink()) fail('UNSAFE_PATH');
  const root = realpathSync(configured);
  function directory(who, accountId, create = false) {
    identifier(who); identifier(accountId);
    let current = root;
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) fail('UNSAFE_PATH');
    for (const part of [who, accountId]) {
      current = join(current, part);
      if (!current.startsWith(root + sep)) fail('UNSAFE_PATH');
      let stat;
      try { stat = lstatSync(current); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!create) return null;
        mkdirSync(current, { mode: 0o700 }); stat = lstatSync(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) fail('UNSAFE_PATH');
    }
    return current;
  }
  return {
    cleanupStages(who, accountId) {
      const dir = directory(who, accountId); if (!dir) return;
      for (const name of readdirSync(dir)) if (/^\.stage-[a-f0-9-]{36}$/.test(name)) {
        const path = join(dir, name); const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('UNSAFE_PATH');
        rmSync(path);
      }
    },
    async stage(who, accountId, chunks) {
      const dir = directory(who, accountId, true); const path = join(dir, `.stage-${randomUUID()}`);
      let handle; let size = 0;
      try {
        handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        for await (const chunk of chunks) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > 262144) fail('INVALID_INPUT');
          size += chunk.byteLength; if (size > MAX_ATTACHMENT) fail('PAYLOAD_TOO_LARGE');
          await handle.writeFile(chunk);
        }
        await handle.close(); handle = null;
        return { chunks() { directory(who, accountId); return createReadStream(path, { highWaterMark: 65536, flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) }); }, async cleanup() { directory(who, accountId); await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); } };
      } catch (e) { if (handle) await handle.close(); await unlink(path).catch(() => {}); throw e; }
    },
    list(who, ref) {
      messageRow(who, ref);
      return all('SELECT * FROM attachments WHERE owner_id=? AND ref=? ORDER BY id', who, ref).map(dto);
    },
    stream(who, ref, id) {
      const message = messageRow(who, ref); identifier(id);
      const row = get('SELECT * FROM attachments WHERE owner_id=? AND ref=? AND id=?', who, ref, id); if (!row) fail('NOT_FOUND');
      return Readable.from((async function* () {
        const dir = directory(who, message.account_id); if (!dir) fail('NOT_FOUND');
        const path = join(dir, id); let handle;
        try {
          if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_PATH');
          handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.size || stat.size > MAX_ATTACHMENT) fail('UNSAFE_PATH');
          const digest = createHash('sha256');
          for (let offset = 0; offset < row.size;) { const chunk = Buffer.alloc(Math.min(65536, row.size - offset)); const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset); if (!bytesRead) fail('ATTACHMENT_CORRUPT'); digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead; }
          if (digest.digest('hex') !== row.sha256) fail('ATTACHMENT_CORRUPT');
          for (let offset = 0; offset < row.size;) { const chunk = Buffer.alloc(Math.min(65536, row.size - offset)); const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset); if (!bytesRead) fail('ATTACHMENT_CORRUPT'); offset += bytesRead; yield chunk.subarray(0, bytesRead); }
        } finally { await handle?.close(); }
      })());
    },
    async put(who, ref, { filename, contentType, chunks }) {
      const message = messageRow(who, ref); text(filename, 1024); text(contentType, 128);
      if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(contentType) || !chunks || (!chunks[Symbol.iterator] && !chunks[Symbol.asyncIterator])) fail('INVALID_INPUT');
      const dir = directory(who, message.account_id, true);
      const id = randomUUID(); const path = join(dir, id); let handle; let created = false;
      try {
        handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); created = true;
        const digest = createHash('sha256'); let size = 0;
        for await (const chunk of chunks) {
          if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) fail('INVALID_INPUT');
          size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
          if (size > MAX_ATTACHMENT) fail('PAYLOAD_TOO_LARGE');
          const bytes = Buffer.from(chunk);
          digest.update(bytes); await handle.writeFile(bytes);
        }
        await handle.sync(); await handle.close(); handle = null;
        directory(who, message.account_id);
        const sha256 = digest.digest('hex');
        run('INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)', who, message.account_id, ref, id, filename, contentType, size, sha256);
        return { id, filename, contentType, size, sha256 };
      } catch (e) {
        if (handle) await handle.close();
        if (created) await unlink(path).catch(() => {});
        throw e;
      }
    },
    async read(who, ref, id) {
      const message = messageRow(who, ref); identifier(id);
      const row = get('SELECT * FROM attachments WHERE owner_id=? AND ref=? AND id=?', who, ref, id);
      if (!row) fail('NOT_FOUND');
      const dir = directory(who, message.account_id); if (!dir) fail('NOT_FOUND');
      const path = join(dir, id); let handle;
      try {
        if (lstatSync(path).isSymbolicLink()) fail('UNSAFE_PATH');
        handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.size || stat.size > MAX_ATTACHMENT) fail('UNSAFE_PATH');
        const bytes = await handle.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) fail('ATTACHMENT_CORRUPT');
        return bytes;
      } catch (e) {
        if (e.code === 'ENOENT') fail('NOT_FOUND'); if (e.code === 'ELOOP') fail('UNSAFE_PATH'); throw e;
      } finally { if (handle) await handle.close(); }
    },
    removeMessageFiles(who, ref) {
      const message = messageRow(who, ref); const dir = directory(who, message.account_id);
      for (const row of all('SELECT id FROM attachments WHERE owner_id=? AND ref=?', who, ref)) {
        identifier(row.id);
        if (dir) rmSync(join(dir, row.id), { force: true });
      }
      run('DELETE FROM attachments WHERE owner_id=? AND ref=?', who, ref);
    },
    removeAccountFiles(who, accountId) {
      const path = directory(who, accountId);
      if (path && path.startsWith(root + sep)) rmSync(path, { recursive: true, force: true });
    },
  };
}
