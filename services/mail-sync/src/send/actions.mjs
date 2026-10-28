import { decodeSourceRef, fail } from '../../../../shared/unified-mail/index.mjs';
import { providerCode } from '../providers/errors.mjs';
import { text } from '../core/validation.mjs';
import { createAccountLifecycle } from '../core/lifecycle.mjs';

const sends = new Set(['send', 'reply', 'forward']);
const address = value => { text(value, 320); if (!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+$/.test(value)) fail('INVALID_INPUT'); return value; };
export function createActions({ store, registry, limits, uploads, lifecycle = createAccountLifecycle({ store }) }) {
  const pending = new Map();
  async function execute({ ownerId, accountId, ref = null, kind, message = {}, signal, lease }) {
    const account = store.accounts.get(ownerId, accountId);
    let source;
    if (ref) { source = store.messages.get(ownerId, ref); if (source.accountId !== accountId) fail('NOT_FOUND'); }
    let outgoing;
    if (sends.has(kind)) {
      if (kind !== 'send' && !source) fail('INVALID_INPUT');
      const recipients = value => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 20) fail('INVALID_INPUT'); return value.map(address); };
      outgoing = { from: address(account.address), to: recipients(message.to), cc: recipients(message.cc), bcc: recipients(message.bcc), subject: text(message.subject ?? (source ? `${kind === 'reply' ? 'Re' : 'Fwd'}: ${source.subject}` : ''), 8192, true), text: text(message.text ?? '', 2 * 1024 * 1024, true), html: text(message.html ?? '', 2 * 1024 * 1024, true), attachments: [] };
      if (kind === 'reply') {
        const messageId = store.sources.catalog(ownerId, accountId).find(c => c.sourceId === decodeSourceRef(ref).id)?.messageId;
        if (typeof messageId === 'string' && /^<[^\s<>\r\n]+>$/.test(messageId)) { outgoing.inReplyTo = messageId; outgoing.references = [messageId]; }
      }
      if (!outgoing.to.length && !outgoing.cc.length && !outgoing.bcc.length) fail('INVALID_INPUT');
      if (message.attachmentIds !== undefined && (!Array.isArray(message.attachmentIds) || message.attachmentIds.length > 20 || !source)) fail('INVALID_INPUT');
      for (const id of message.attachmentIds || []) {
        const a = source.attachments.find(a => a.id === id); if (!a) fail('NOT_FOUND');
        outgoing.attachments.push({ filename: a.filename, contentType: a.contentType, content: store.attachments.stream(ownerId, ref, a.id) });
      }
    }
    const operation = store.operations.create(ownerId, { accountId, ref, kind });
    store.operations.update(ownerId, operation.id, { state: 'running' });
    let session; let submitting = false;
    try {
      signal?.throwIfAborted();
      if (sends.has(kind) && message.uploadIds !== undefined) {
        if (!uploads) fail('INVALID_INPUT');
        outgoing.attachments.push(...await uploads.take(ownerId, accountId, message.uploadIds, lease));
        lease.check();
      }
      session = await registry.open({ ownerId, account, signal });
      lease.check();
      if (sends.has(kind)) { submitting = true; await session.send(outgoing, { signal }); }
      else {
        if (!source) fail('INVALID_INPUT');
        const sourceId = decodeSourceRef(ref).id;
        const locations = store.sources.catalog(ownerId, accountId).filter(c => c.sourceId === sourceId && c.admitted);
        if (!locations.length) fail('NOT_FOUND');
        if (kind === 'delete') { lease.check(); await session.trash(locations[0]); }
        else for (const location of locations) { lease.check(); await session.flags(location, kind === 'mark-unread'); }
        if (kind !== 'delete') store.sources.update(ownerId, ref, { unread: kind === 'mark-unread' });
      }
      return store.operations.update(ownerId, operation.id, { state: 'succeeded' });
    } catch (error) {
      const uncertain = submitting && !error?.definitive && !(error?.responseCode >= 400) && !['EAUTH', 'EENVELOPE', 'EMESSAGE', 'AUTH_REQUIRED'].includes(error?.code);
      const code = providerCode(error);
      if (code === 'AUTH_REQUIRED' && lease.current()) store.accounts.setStatus(ownerId, accountId, 'needs-auth', code);
      return store.operations.update(ownerId, operation.id, { state: uncertain ? 'uncertain' : 'failed', errorCode: uncertain ? 'SEND_UNCERTAIN' : code });
    } finally {
      for (const attachment of outgoing?.attachments || []) {
        attachment.content.destroy?.();
        await attachment.cleanup?.();
      }
      await session?.close().catch(() => {});
    }
  }
  return {
    execute(options) {
      const key = JSON.stringify([options.ownerId, options.accountId]); const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const group = pending.get(key) || new Set(); pending.set(key, group);
      const entry = { controller }; group.add(entry);
      let work;
      try { work = lifecycle.run(options.ownerId, options.accountId, lease => limits ? limits.reconnect(() => execute({ ...options, signal: lease.signal, lease })) : execute({ ...options, signal: lease.signal, lease }), { signal }); }
      catch (error) { group.delete(entry); if (!group.size) pending.delete(key); return Promise.reject(error); }
      entry.promise = work.finally(() => { group.delete(entry); if (!group.size) pending.delete(key); });
      return entry.promise;
    },
    async stopAccount(ownerId, accountId) { const group = [...(pending.get(JSON.stringify([ownerId, accountId])) || [])]; for (const entry of group) entry.controller.abort(); await Promise.allSettled(group.map(entry => entry.promise)); },
    async close() { for (const group of pending.values()) for (const entry of group) entry.controller.abort(); await Promise.allSettled([...pending.values()].flatMap(group => [...group].map(entry => entry.promise))); },
    async resume({ ownerId, operationId }) { store.operations.get(ownerId, operationId); fail('INVALID_TRANSITION'); },
  };
}
