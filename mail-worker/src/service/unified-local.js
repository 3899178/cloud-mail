import { decodeSourceRef, encodeSourceRef, fail } from '../../../shared/unified-mail/index.mjs';
import r2Service from './r2-service';
import emailService from './email-service';
import permService from './perm-service';
export const localDto = r => ({
  ref: encodeSourceRef({
    source: 'cloud-mail',
    accountId: String(r.account_id),
    id: String(r.email_id)
  }),
  source: 'cloud-mail',
  accountId: String(r.account_id),
  receivedAt: Date.parse(r.create_time.replace(' ', 'T') + 'Z'),
  subject: r.subject || '',
  from: r.send_email || '',
  unread: r.unread === 0,
  folder: r.type === 1 ? 'Sent' : 'Inbox'
});
export async function ownedLocal(c, ref) {
  const parsed = decodeSourceRef(ref);
  if (parsed.source !== 'cloud-mail' || !/^\d+$/.test(parsed.id) || !/^\d+$/.test(parsed.accountId)) fail('NOT_FOUND');
  const row = await c.env.db.prepare('SELECT e.* FROM email e JOIN account a ON a.account_id=e.account_id WHERE e.email_id=? AND e.account_id=? AND e.user_id=? AND a.user_id=? AND e.is_del=0 AND a.is_del=0').bind(parsed.id, parsed.accountId, c.get('user').userId, c.get('user').userId).first();
  if (!row) fail('NOT_FOUND');
  return row;
}
export async function requireLocalPerm(c, key) {
  if (c.get('user').email !== c.env.admin && !(await permService.userPermKeys(c, c.get('user').userId)).includes(key)) fail('FORBIDDEN');
}
export async function localDetail(c, ref) {
  const row = await ownedLocal(c, ref);
  const {
    results
  } = await c.env.db.prepare('SELECT att_id,filename,mime_type,size FROM attachments WHERE email_id=? AND account_id=? AND user_id=?').bind(row.email_id, row.account_id, c.get('user').userId).all();
  return {
    ...localDto(row),
    text: row.text || '',
    html: row.content || '',
    attachments: results.map(a => ({
      id: String(a.att_id),
      filename: a.filename,
      contentType: a.mime_type,
      size: a.size
    }))
  };
}
export async function localAttachment(c, ref, id) {
  const row = await ownedLocal(c, ref);
  const att = await c.env.db.prepare('SELECT * FROM attachments WHERE att_id=? AND email_id=? AND account_id=? AND user_id=?').bind(id, row.email_id, row.account_id, c.get('user').userId).first();
  if (!att) fail('NOT_FOUND');
  const response = await r2Service.toObjResp(c, att.key);
  if (!response) fail('NOT_FOUND');
  return new Response(response.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(att.filename || 'attachment').replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16))}`
    }
  });
}
export async function localRead(c, ref, unread) {
  const row = await ownedLocal(c, ref);
  if (typeof unread !== 'boolean') fail('INVALID_INPUT');
  await c.env.db.prepare('UPDATE email SET unread=? WHERE email_id=? AND user_id=?').bind(unread ? 0 : 1, row.email_id, c.get('user').userId).run();
  return {
    state: 'succeeded',
    kind: unread ? 'mark-unread' : 'mark-read',
    ref
  };
}
export async function localTrash(c, ref) {
  const row = await ownedLocal(c, ref);
  await requireLocalPerm(c, 'email:delete');
  await emailService.delete(c, {
    emailIds: String(row.email_id)
  }, c.get('user').userId);
  return {
    state: 'succeeded',
    kind: 'delete',
    ref
  };
}
export async function localSend(c, body) {
  await requireLocalPerm(c, 'email:send');
  if (!['send', 'reply', 'forward'].includes(body.kind)) fail('INVALID_INPUT');
  const a = await c.env.db.prepare('SELECT account_id FROM account WHERE account_id=? AND user_id=? AND is_del=0').bind(body.accountId, c.get('user').userId).first();
  if (!a) fail('NOT_FOUND');
  const source = body.ref ? await ownedLocal(c, body.ref) : null;
  if (body.kind !== 'send' && !source) fail('INVALID_INPUT');
  const m = body.message || {};
  if (!Array.isArray(m.to) || m.cc?.length || m.bcc?.length || m.uploadIds?.length || m.attachmentIds?.length) fail('INVALID_INPUT');
  const emails = await emailService.send(c, {
    accountId: a.account_id,
    sendType: body.kind === 'reply' ? 'reply' : 'send',
    emailId: source?.email_id,
    receiveEmail: m.to,
    text: m.text || '',
    content: m.html || '',
    subject: m.subject || '',
    attachments: []
  }, c.get('user').userId);
  return {
    state: 'succeeded',
    kind: body.kind,
    emails
  };
}
