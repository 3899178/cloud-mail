import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/hono/webs';
import { auth, env, fixture } from './fixture';
import jwt from '../src/utils/jwt-utils';

const origin = 'https://mail.example.test';
const request = (path, token, method = 'GET') => app.request(origin + path, {
 method, headers: { Origin: origin, ...(token && { Authorization: `Bearer ${token}` }) }
}, { ...env, admin: 'u1@example.test' });
const emailIds = async () => (await env.db.prepare('SELECT email_id FROM email ORDER BY email_id').all()).results.map(row => row.email_id);

describe('original maintenance routes', () => {
 beforeEach(fixture);

 it('expired/exhausted invitation cleanup is administrator-only and preserves usable invitations', async () => {
  for (const [id, count, expiry] of [[10, 1, '2099-01-01'], [11, 0, '2099-01-01'], [12, 1, '2020-01-01']]) {
   await env.db.prepare('INSERT INTO reg_key(rege_key_id,code,count,role_id,user_id,expire_time) VALUES(?,?,?,1,1,?)').bind(id, `maintenance-${id}`, count, expiry).run();
  }
  const member = await request('/regKey/clearNotUse', await auth(2), 'DELETE');
  expect((await member.json()).code).toBe(403);
  expect((await env.db.prepare('SELECT COUNT(*) AS n FROM reg_key').first()).n).toBe(3);
  expect((await (await request('/regKey/clearNotUse', await auth(1), 'DELETE')).json()).code).toBe(200);
  expect((await env.db.prepare('SELECT rege_key_id FROM reg_key ORDER BY rege_key_id').all()).results).toEqual([{ rege_key_id: 10 }]);
 });

 it('filtered administrator bulk deletion preserves unmatched mail and members cannot invoke it', async () => {
  for (const [id, owner, subject] of [[10, 1, 'disposable exact'], [11, 2, 'disposable exact'], [12, 1, 'disposable exact extra'], [13, 2, 'retain']]) {
   await env.db.prepare('INSERT INTO email(email_id,account_id,user_id,subject) VALUES(?,?,?,?)').bind(id, owner, owner, subject).run();
  }
  const path = '/allEmail/batchDelete?subject=disposable%20exact&type=exact';
  expect((await (await request(path, await auth(2), 'DELETE')).json()).code).toBe(403);
  expect(await emailIds()).toEqual([10, 11, 12, 13]);
  const admin = await auth(1);
  expect((await (await request('/allEmail/batchDelete', admin, 'DELETE')).json()).code).toBe(200);
  expect(await emailIds()).toEqual([10, 11, 12, 13]);
  expect((await (await request(path, admin, 'DELETE')).json()).code).toBe(200);
  expect(await emailIds()).toEqual([12, 13]);
 });

 it('a notification link renders plain text as literal text without adding active HTML', async () => {
  const text = '<script>window.mailTextExecuted=true</script><img src=x onerror="mailTextExecuted=true"> & literal';
  await env.db.prepare('INSERT INTO email(email_id,account_id,user_id,text,content) VALUES(10,1,1,?,?)').bind(text, '').run();
  const token = await jwt.generateToken({ env }, { emailId: 10 });
  const response = await request('/telegram/getEmail/' + token);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('&lt;script&gt;window.mailTextExecuted=true&lt;/script&gt;');
  expect(html).toContain('&lt;img src=x onerror=&quot;mailTextExecuted=true&quot;&gt; &amp; literal');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
 });

 it('notification links reject invalid tokens and report a missing message', async () => {
  expect(await (await request('/telegram/getEmail/not-a-token')).text()).toContain('Access denied');
  const token = await jwt.generateToken({ env }, { emailId: 999 });
  expect(await (await request('/telegram/getEmail/' + token)).text()).toContain('The email does not exist');
 });

 it('an incorrect initialization secret does not initialize or mutate a populated database', async () => {
  await env.db.prepare("INSERT INTO email(email_id,account_id,user_id,subject) VALUES(10,1,1,'keep')").run();
  const response = await request('/init/wrong-synthetic-secret');
  expect(await response.text()).toContain('JWT secret mismatch');
  expect(await emailIds()).toEqual([10]);
 });
});
