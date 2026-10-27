import { request } from 'node:http';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { fail } from '../../../../shared/unified-mail/index.mjs';
import { text } from '../core/validation.mjs';

const safe = new Set(['AUTH_REQUIRED', 'UNAUTHORIZED', 'INVALID_INPUT', 'CAPACITY_EXCEEDED', 'RESYNC_REQUIRED', 'PROVIDER_UNAVAILABLE', 'SYNC_FAILED', 'BUSY']);
async function json(response) {
  let length = 0; const chunks = [];
  for await (const chunk of response) { length += chunk.length; if (length > 8 * 1024 * 1024) { response.destroy(); fail('CAPACITY_EXCEEDED'); } chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('SYNC_FAILED'); }
  if (value.error) fail(safe.has(value.error) ? value.error : 'SYNC_FAILED');
  return value;
}

// No TCP fallback: deployment supplies a socket under a private, same-user directory.
export function createProtonTransport({ socketPath }) {
  async function call(body, { signal, upload, stream = false } = {}) {
    if (process.platform === 'win32' || !isAbsolute(socketPath || '')) fail('PROVIDER_UNAVAILABLE');
    const [directory, socket] = await Promise.all([lstat(dirname(socketPath)), lstat(socketPath)]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || !socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o077) || directory.uid !== process.getuid() || socket.uid !== process.getuid()) fail('PROVIDER_UNAVAILABLE');
    const header = Buffer.from(JSON.stringify(body) + '\n'); if (header.length > 65536) fail('CAPACITY_EXCEEDED');
    const timeout = AbortSignal.timeout(120000); const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, method: 'POST', path: upload ? '/send' : stream ? '/fetch' : '/rpc', signal: activeSignal, agent: false, headers: { 'Content-Type': 'application/octet-stream' } }, res => {
        if (stream && res.statusCode === 200) resolve(res);
        else json(res).then(resolve, reject);
      });
      req.once('error', () => reject(Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: activeSignal.aborted ? 'BUSY' : 'PROVIDER_UNAVAILABLE' })));
      const source = Readable.from((async function* () {
        yield header; let size = 0;
        if (upload) for await (const chunk of upload) { size += chunk.length; if (size > 36 * 1024 * 1024) fail('CAPACITY_EXCEEDED'); for (let i = 0; i < chunk.length; i += 65536) yield chunk.subarray(i, i + 65536); }
      })());
      source.once('error', error => req.destroy(error)); req.once('close', () => source.destroy()); source.pipe(req);
    });
  }
  return { rpc: call, fetch: (body, options) => call(body, { ...options, stream: true }), send: (body, upload, options) => call(body, { ...options, upload }) };
}

export function createProton({ store, lifecycle, transport, clock = Date.now }) {
  function account(who, id) { const value = store.accounts.get(who, id); if (value.provider !== 'proton') fail('INVALID_INPUT'); return value; }
  function save(who, id, material, lease) { lease.check(); const value = JSON.stringify(material); if (!material?.auth || Buffer.byteLength(value) > 16384) fail('AUTH_REQUIRED'); store.credentials.set(who, id, 'proton', value); }
  function dto(who, id, result, lease) {
    lease.check();
    if (result.material) { save(who, id, result.material, lease); store.accounts.setStatus(who, id, 'pending'); return { step: 'ready' }; }
    if (['manual-verification', 'unsupported-challenge'].includes(result.step)) return { step: result.step };
    if (!['totp', 'mailbox-password'].includes(result.step) || typeof result.challenge !== 'string') fail('AUTH_REQUIRED');
    const state = store.oauthStates.create(who, id, { provider: 'proton', challenge: result.challenge, step: result.step, expiresAt: clock() + 300000 }, 300000);
    return { step: result.step, state, expiresIn: 300 };
  }
  const api = {
    start(who, id, input) {
      return lifecycle.run(who, id, async lease => {
        const a = account(who, id); text(input.password, 8192); if (input.mailboxPassword !== undefined) text(input.mailboxPassword, 8192);
        // Invalidate old account interactions before network work, including failed restarts.
        store.oauthStates.create(who, id, { provider: 'proton', cancelled: true }, 300000);
        const result = await transport.rpc({ op: 'auth.start', owner: who, account: id, username: a.address, password: input.password, mailboxPassword: input.mailboxPassword }, { signal: lease.signal });
        return dto(who, id, result, lease);
      });
    },
    async complete(who, id, input) {
      const identity = store.oauthStates.resolve(input.state); if (identity.ownerId !== who || identity.accountId !== id) fail('UNAUTHORIZED');
      return lifecycle.run(who, id, async lease => {
        account(who, id); const { value } = store.oauthStates.consume(who, input.state);
        if (value.provider !== 'proton' || value.expiresAt <= clock()) fail('UNAUTHORIZED');
        if (value.step === 'totp' && !/^\d{6,8}$/.test(input.code || '')) fail('INVALID_INPUT');
        if (value.step === 'mailbox-password') text(input.mailboxPassword, 8192);
        const result = await transport.rpc({ op: 'auth.complete', owner: who, account: id, challenge: value.challenge, code: input.code, mailboxPassword: input.mailboxPassword }, { signal: lease.signal });
        return dto(who, id, result, lease);
      });
    },
    adapter({ ownerId, account: a, signal }) {
      return lifecycle.run(ownerId, a.id, async lease => {
        account(ownerId, a.id); let material;
        try { material = JSON.parse(store.credentials.get(ownerId, a.id, 'proton')); } catch { fail('AUTH_REQUIRED'); }
        const opened = await transport.rpc({ op: 'open', owner: ownerId, account: a.id, material }, { signal: lease.signal });
        save(ownerId, a.id, opened.material, lease); text(opened.session, 128);
        let closed = false;
        const request = (op, data = {}) => lifecycle.run(ownerId, a.id, async active => {
          active.check(); const result = await transport.rpc({ op, owner: ownerId, account: a.id, session: opened.session, ...data }, { signal: active.signal }); active.check(); return result;
        }, { signal });
        const scope = { owner: ownerId, account: a.id, session: opened.session };
        return {
          usable: () => !closed && Number.isSafeInteger(opened.expiresAt) && clock() < opened.expiresAt,
          folders: async () => (await request('folders')).folders,
          snapshot: (folder, { checkpoint, baselineAt }) => request('snapshot', { folder, cursor: checkpoint?.cursor || '', baselineAt }),
          validateSnapshot: async (folder, previous) => (await request('validate', { folder, cursor: previous.cursor })).valid === true,
          fetch(folder, message) {
            return new Promise((resolve, reject) => {
              const work = lifecycle.run(ownerId, a.id, async active => {
                let source;
                try {
                  source = await transport.fetch({ ...scope, op: 'fetch', folder, id: message.id }, { signal: active.signal });
                  active.check();
                  const abort = () => source.destroy(active.signal.reason);
                  const completion = finished(source, { cleanup: true });
                  active.signal.addEventListener('abort', abort, { once: true });
                  resolve(source);
                  try { await completion; }
                  finally { active.signal.removeEventListener('abort', abort); }
                } catch (error) { source?.destroy(); reject(error); throw error; }
              });
              // A standalone call holds admission through stream completion; engine calls
              // inherit its current lease. Failures after headers surface on the stream.
              work.catch(reject);
            });
          },
          flags: (location, unread) => request('flags', { id: location.remoteId, unread }),
          trash: location => request('trash', { id: location.remoteId }),
          async send(message, { signal: sendSignal } = {}) {
            const mime = new MailComposer({ ...message, disableFileAccess: true, disableUrlAccess: true }).compile().createReadStream();
            try { return await transport.send({ ...scope, op: 'send', recipients: [...message.to, ...message.cc, ...message.bcc] }, mime, { signal: sendSignal || signal }); } finally { mime.destroy(); }
          },
          async close() { if (closed) return; closed = true; await transport.rpc({ ...scope, op: 'close' }).catch(() => {}); },
        };
      }, { signal });
    },
  };
  return { ...api, async cancel(who, id) { await transport.rpc({ op: 'cancel', owner: who, account: id }).catch(() => {}); } };
}
