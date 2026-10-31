import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/hono/webs';
import { env, fixture } from './fixture';

const origin = 'https://mail.example.test';
const webhook = body => app.request(origin + '/webhooks', {
 method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}, env);
const rows = () => env.db.prepare('SELECT email_id,user_id,account_id,status,message,subject,text,unread FROM email ORDER BY email_id').all().then(result => result.results);

describe('retained delivery-status webhook behavior', () => {
 beforeEach(async () => {
  await fixture();
  await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,status,message,subject,text,unread,resend_email_id) VALUES(10,1,1,8,'previous status','target','keep body',1,'synthetic-provider-a'),(11,2,2,1,'other status','other tenant','keep other body',0,'synthetic-provider-b'),(12,1,1,1,'local status','local channel','keep local body',0,NULL)").run();
 });

 const events = [
  { type: 'email.sent', status: 1, message: 'previous status' },
  { type: 'email.delivered', status: 2, message: null },
  { type: 'email.complained', status: 4, message: null },
  { type: 'email.delivery_delayed', status: 5, message: null },
  { type: 'email.failed', status: 8, failed: { reason: 'synthetic delivery failure' }, message: 'synthetic delivery failure' },
  { type: 'email.bounced', status: 3, bounce: { type: 'Permanent', subType: 'General', message: 'synthetic bounce' } },
 ];
 for (const event of events) it(`${event.type} updates only its provider message and preserves mail content`, async () => {
  const before = await rows();
  const response = await webhook({ type: event.type, data: { email_id: 'synthetic-provider-a', ...(event.failed && { failed: event.failed }), ...(event.bounce && { bounce: event.bounce }) } });
  expect(response.status).toBe(200); expect(await response.text()).toBe('success');
  const after = await rows();
  expect(after).toHaveLength(3);
  expect(after[0]).toMatchObject({ email_id: 10, user_id: 1, account_id: 1, status: event.status, subject: 'target', text: 'keep body', unread: 1 });
  if (event.bounce) expect(JSON.parse(after[0].message)).toEqual({ type: 'Permanent', subType: 'General', message: 'synthetic bounce' });
  else expect(after[0].message).toBe(event.message);
  expect(after.slice(1)).toEqual(before.slice(1));
 });

 it('repeated delivered notifications keep the same rows and clear an earlier failure reason', async () => {
  for (let attempt = 0; attempt < 2; attempt++) expect((await webhook({ type: 'email.delivered', data: { email_id: 'synthetic-provider-a' } })).status).toBe(200);
  expect(await rows()).toHaveLength(3);
  expect((await rows())[0]).toMatchObject({ status: 2, message: null, text: 'keep body' });
 });

 it('an unknown provider ID acknowledges without inserting mail or updating another message', async () => {
  const before = await rows();
  const response = await webhook({ type: 'email.delivered', data: { email_id: 'synthetic-missing-id' } });
  expect(response.status).toBe(200);
  expect(await rows()).toEqual(before);
 });

 it('an incomplete event fails without changing retained mail', async () => {
  const before = await rows();
  const response = await webhook({ type: 'email.delivered' });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await rows()).toEqual(before);
 });
});
