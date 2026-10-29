import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { fail } from '../../../../shared/unified-mail/index.mjs';
import { resolvePublicEndpoint } from './network.mjs';

const hosts = { gmail: ['imap.gmail.com', 'smtp.gmail.com', 465], outlook: ['outlook.office365.com', 'smtp-mail.outlook.com', 587], qq: ['imap.qq.com', 'smtp.qq.com', 465], icloud: ['imap.mail.me.com', 'smtp.mail.me.com', 587], '163': ['imap.163.com', 'smtp.163.com', 465], '126': ['imap.126.com', 'smtp.126.com', 465], yeah: ['imap.yeah.net', 'smtp.yeah.net', 465] };
export function mailConfig(provider, manual) {
  const h = hosts[provider];
  const config = manual || (h && { imap: { host: h[0], port: 993, secure: true }, smtp: { host: h[1], port: h[2], secure: h[2] === 465, requireTLS: h[2] !== 465 } });
  if (!config || config.imap?.secure !== true || !(config.smtp?.secure === true || config.smtp?.requireTLS === true)) fail('INVALID_INPUT');
  const clean = endpoint => {
    if (typeof endpoint.host !== 'string' || endpoint.host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(endpoint.host) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) fail('INVALID_INPUT');
    return { host: endpoint.host, port: endpoint.port, secure: endpoint.secure === true, requireTLS: endpoint.secure !== true };
  };
  return { imap: clean(config.imap), smtp: clean(config.smtp) };
}
function folderKind(folder) {
  const special = folder.specialUse;
  if (folder.flags.has('\\Noselect')) return 'skip';
  return ({ '\\Inbox': 'inbox', '\\All': 'archive', '\\Archive': 'archive', '\\Junk': 'spam', '\\Trash': 'trash', '\\Drafts': 'drafts', '\\Sent': 'sent' })[special] || (folder.path.toUpperCase() === 'INBOX' ? 'inbox' : 'normal');
}
export async function createImapSession({ account, config, auth, signal, endpointResolver = resolvePublicEndpoint, tlsOptions = {}, onChange = () => {}, clock = Date.now }) {
  const endpoint = await endpointResolver(config.imap);
  const credentials = await auth();
  const client = new ImapFlow({ host: endpoint.host, port: endpoint.port, servername: endpoint.servername, secure: true, tls: { ...tlsOptions, servername: endpoint.servername, minVersion: 'TLSv1.2' }, auth: credentials.accessToken ? { user: credentials.user, accessToken: credentials.accessToken } : { user: credentials.user, pass: credentials.pass }, logger: false, logRaw: false, emitLogs: false, disableCompression: true, maxIdleTime: 25000, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000, maxLineLength: 1048576, maxLiteralSize: 262144, maxResponseSize: 2097152, maxResponseTokens: 50000 });
  let watching = false;
  const changed = () => { if (watching) onChange(); };
  client.on('error', () => {}); client.on('exists', changed); client.on('flags', changed); client.on('expunge', changed);
  const abort = () => client.close(); signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  try { await client.connect(); } catch (e) { client.close(); signal?.removeEventListener('abort', abort); throw e; }
  signal?.removeEventListener('abort', abort);
  let inventory;
  async function folders() { inventory = await client.list(); if (inventory.length > 200) fail('CAPACITY_EXCEEDED'); return inventory.map(f => ({ id: f.path, kind: folderKind(f) })); }
  const normalMessage = m => !m.flags?.has('\\Draft') && ![...(m.labels || [])].some(label => ['\\Sent', '\\Trash', '\\Junk', '\\Drafts'].includes(label));
  const metadata = m => {
    if (m.record) return m.record;
    const receivedAt = new Date(m.internalDate).getTime();
    if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) fail('SYNC_FAILED');
    const messageId = m.envelope?.messageId || '';
    return { id: String(m.uid), receivedAt, unread: !m.flags?.has('\\Seen'), stableId: m.emailId, messageId, fingerprint: createHash('sha256').update(JSON.stringify([messageId, receivedAt, ...(messageId ? [] : [m.size, m.envelope?.from, m.envelope?.subject])])).digest('hex') };
  };
  const token = () => ({ v: 1, uidNext: String(client.mailbox.uidNext), exists: client.mailbox.exists, modseq: client.enabled.has('CONDSTORE') && !client.mailbox.noModseq && client.mailbox.highestModseq ? String(client.mailbox.highestModseq) : null });
  const same = (a, b) => a.uidNext === b.uidNext && a.exists === b.exists && a.modseq === b.modseq;
  const fullQuery = { uid: true, flags: true, internalDate: true, envelope: true, size: true, emailId: true, labels: true };
  async function scan(query, options = {}) {
    const rows = []; const exists = client.mailbox.exists; let bytes = 0;
    if (exists > 20000) fail('CAPACITY_EXCEEDED');
    for (let start = 1; start <= exists; start += 100) {
      for await (const m of client.fetch(`${start}:${Math.min(exists, start + 99)}`, query, options)) {
        const row = { uid: m.uid, flags: m.flags, labels: m.labels, ...(query.envelope ? { record: metadata(m) } : {}) };
        bytes += Buffer.byteLength(JSON.stringify(row));
        if (rows.length >= 20000 || bytes > 8 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
        rows.push(row);
      }
    }
    if (client.mailbox.exists !== exists || (!options.changedSince && rows.length !== exists) || new Set(rows.map(m => String(m.uid))).size !== rows.length) fail('SYNC_FAILED');
    return rows;
  }
  async function snapshot(folder, { checkpoint, catalog = [] } = {}) {
    const lock = await client.getMailboxLock(folder);
    try {
      // A cached mailbox lock does not SELECT again. Obtain a fresh server token.
      await client.mailboxOpen(folder);
      const uidValidity = String(client.mailbox.uidValidity); const before = token();
      let saved; try { saved = JSON.parse(checkpoint?.cursor || 'null'); } catch {}
      const reusable = saved?.v === 1 && checkpoint.uidValidity === uidValidity && Number.isSafeInteger(saved.auditAt) && saved.auditAt <= clock() && clock() - saved.auditAt < 300000;
      let messages; let auditAt = saved?.auditAt; let lightSignature;
      if (reusable && before.modseq && saved.modseq && same(before, saved)) {
        messages = catalog.map(c => ({ id: c.remoteId, receivedAt: c.receivedAt, unread: c.unread, stableId: c.stableId, messageId: c.messageId, fingerprint: c.fingerprint }));
      } else if (reusable) {
        const known = new Map(catalog.map(c => [c.remoteId, { id: c.remoteId, receivedAt: c.receivedAt, unread: c.unread, stableId: c.stableId, messageId: c.messageId, fingerprint: c.fingerprint }]));
        if (before.modseq && saved.modseq && BigInt(before.modseq) >= BigInt(saved.modseq)) {
          const ids = new Set((await client.search({ all: true }, { uid: true })).map(String));
          if (ids.size !== before.exists) fail('SYNC_FAILED');
          for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
          // Newly assigned UIDs must appear in CHANGEDSINCE even when their
          // flags exclude them from the normal catalog. Do not advance past a
          // partial response; older excluded UIDs need not have changed.
          const pending = new Set([...ids].filter(id => BigInt(id) >= BigInt(saved.uidNext)));
          for (const m of await scan(fullQuery, { changedSince: BigInt(saved.modseq) })) {
            pending.delete(String(m.uid));
            if (normalMessage(m)) known.set(String(m.uid), metadata(m)); else known.delete(String(m.uid));
          }
          if (pending.size) fail('SYNC_FAILED');
        } else {
          const light = await scan({ uid: true, flags: true, labels: true });
          lightSignature = lightDigest(light);
          const ids = new Set(light.filter(normalMessage).map(m => String(m.uid)));
          for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
          const added = [];
          for (const m of light.filter(normalMessage)) {
            const old = known.get(String(m.uid)); if (old) old.unread = !m.flags?.has('\\Seen'); else added.push(String(m.uid));
          }
          for (let i = 0; i < added.length; i += 100) {
            const batch = added.slice(i, i + 100); const pending = new Set(batch);
            for await (const m of client.fetch(batch.join(','), fullQuery, { uid: true })) {
              if (!pending.delete(String(m.uid))) fail('SYNC_FAILED');
              if (normalMessage(m)) known.set(String(m.uid), metadata(m));
            }
            if (pending.size) fail('SYNC_FAILED');
          }
        }
        messages = [...known.values()];
      } else {
        const rows = await scan(fullQuery); messages = rows.filter(normalMessage).map(metadata); auditAt = clock();
        if (!before.modseq) lightSignature = lightDigest(rows);
      }
      if (!same(before, token())) fail('SYNC_FAILED');
      messages.sort((a, b) => Number(a.id) - Number(b.id));
      if (messages.length > 20000 || Buffer.byteLength(JSON.stringify(messages)) > 8 * 1024 * 1024) fail('CAPACITY_EXCEEDED');
      return { uidValidity, cursor: JSON.stringify({ ...before, auditAt }), messages, lightSignature };
    } finally { lock.release(); }
  }
  function lightDigest(rows) { return createHash('sha256').update(JSON.stringify(rows.map(m => [String(m.uid), [...(m.flags || [])].sort(), [...(m.labels || [])].sort()]))).digest('hex'); }
  async function validateSnapshot(folder, previous) {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.mailboxOpen(folder);
      const saved = JSON.parse(previous.cursor);
      if (String(client.mailbox.uidValidity) !== previous.uidValidity || !same(saved, token())) return false;
      if (saved.modseq) return true;
      return previous.lightSignature === lightDigest(await scan({ uid: true, flags: true, labels: true }));
    } finally { lock.release(); }
  }

  async function locate(location, task) {
    const lock = await client.getMailboxLock(location.folder);
    try {
      if (String(client.mailbox.uidValidity) !== location.uidValidity) fail('RESYNC_REQUIRED');
      if (!await client.fetchOne(location.remoteId, { uid: true }, { uid: true })) fail('NOT_FOUND');
      return await task();
    } finally { lock.release(); }
  }
  return {
    usable: () => client.usable,
    acquire() { watching = false; },
    folders, snapshot,
    validateSnapshot,
    async fetch(folder, message) {
      const lock = await client.getMailboxLock(folder);
      try {
        if (message.uidValidity !== undefined && String(client.mailbox.uidValidity) !== message.uidValidity) fail('RESYNC_REQUIRED');
        const result = await client.download(message.id, undefined, { uid: true, chunkSize: 65536 });
        if (!result.content) fail('NOT_FOUND');
        result.content.once('end', () => lock.release()); result.content.once('close', () => lock.release()); result.content.once('error', () => lock.release());
        return result.content;
      } catch (e) { lock.release(); throw e; }
    },
    flags: (location, unread) => locate(location, async () => {
      const ok = unread ? await client.messageFlagsRemove(location.remoteId, ['\\Seen'], { uid: true }) : await client.messageFlagsAdd(location.remoteId, ['\\Seen'], { uid: true });
      if (!ok) fail('SYNC_FAILED');
    }),
    async trash(location) {
      if (!inventory) await folders();
      const trash = inventory.find(f => folderKind(f) === 'trash'); if (!trash) fail('PROVIDER_UNAVAILABLE');
      return locate(location, async () => { if (!await client.messageMove(location.remoteId, trash.path, { uid: true })) fail('SYNC_FAILED'); });
    },
    async send(message, { signal: sendSignal } = {}) {
      const smtp = await endpointResolver(config.smtp); const authValue = await auth();
      let smtpSocket;
      const abortSend = () => smtpSocket?.destroy(); sendSignal?.throwIfAborted(); sendSignal?.addEventListener('abort', abortSend, { once: true });
      const transport = createTransport({ host: smtp.host, port: smtp.port, secure: config.smtp.secure, requireTLS: config.smtp.requireTLS, tls: { ...tlsOptions, servername: smtp.servername, minVersion: 'TLSv1.2' }, auth: authValue.accessToken ? { type: 'OAuth2', user: authValue.user, accessToken: authValue.accessToken } : authValue, logger: false, debug: false, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, disableFileAccess: true, disableUrlAccess: true,
        getSocket(options, callback) {
          let handedOver = false;
          smtpSocket = connect({ host: smtp.host, port: smtp.port, signal: sendSignal });
          smtpSocket.setTimeout(15000, () => smtpSocket.destroy());
          smtpSocket.once('error', error => { if (!handedOver) { handedOver = true; callback(error); } });
          smtpSocket.once('connect', () => { if (!handedOver) { handedOver = true; callback(null, { connection: smtpSocket }); } });
        },
      });
      try {
        const result = await transport.sendMail({ ...message, disableFileAccess: true, disableUrlAccess: true });
        if (!result.accepted?.length || result.rejected?.length) fail('SEND_UNCERTAIN');
        return { accepted: true };
      } finally { sendSignal?.removeEventListener('abort', abortSend); smtpSocket?.destroy(); transport.close(); }
    },
    async idle() { if (client.usable) { await client.mailboxOpen('INBOX'); watching = true; } },
    async close() { watching = false; client.close(); },
  };
}
