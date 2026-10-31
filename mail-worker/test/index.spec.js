import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import app from '../src/hono/webs';
import jwt from '../src/utils/jwt-utils';
import Kv from '../src/const/kv-const';
const origin = 'https://mail.example.test';
async function auth(userId=1) {
 const token = `uuid-${userId}`;
 await env.kv.put(Kv.AUTH_INFO + userId, JSON.stringify({tokens:[token],user:{userId,email:`u${userId}@example.test`},refreshTime:new Date().toISOString()}));
 return jwt.generateToken({env},{userId,token});
}
const req = (path, init={}) => app.request(origin + path, init, env);
describe('browser session security', () => {
 it('exchanges raw legacy JWT into secure cookie and accepts Bearer', async () => {
  const token = await auth();
  const r = await req('/session/exchange',{method:'POST',headers:{Authorization:token,Origin:origin}});
  expect(r.status).toBe(200); expect((await r.json()).data.csrfToken).toBeTruthy();
  const cookie = r.headers.get('set-cookie');
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax');
  expect((await req('/session',{headers:{Authorization:`Bearer ${token}`}})).status).toBe(200);
 });
 it('requires CSRF for cookie mutations, invalid explicit authorization cannot fall back',async()=>{
  const token=await auth(); const r=await req('/session/exchange',{method:'POST',headers:{Authorization:token,Origin:origin}});
  const cookie=r.headers.get('set-cookie')?.split(';')[0]; const data=await r.json();
  expect(cookie).toBeTruthy();
  expect((await (await req('/logout',{method:'DELETE',headers:{Cookie:cookie,Origin:origin}})).json()).code).toBe(403);
  expect((await req('/session',{headers:{Cookie:cookie,Authorization:'bad'}})).status).toBe(401);
  expect((await req('/logout',{method:'DELETE',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':data.data.csrfToken}})).status).toBe(200);
  expect((await req('/session',{headers:{Cookie:cookie}})).status).toBe(401);
 });
 it('rejects cross-origin exchange and safely handles malformed input without secret logs',async()=>{
  const token=await auth();
  expect((await req('/session/exchange',{method:'POST',headers:{Authorization:token,Origin:'https://evil.test'}})).status).toBe(403);
  const log=vi.spyOn(console,'error'); const log2=vi.spyOn(console,'log');
  const r=await req('/external/accounts',{method:'POST',headers:{Authorization:token},body:'secret-marker-malformed'});
  expect(await r.text()).not.toContain('secret-marker'); expect(JSON.stringify([log.mock.calls,log2.mock.calls])).not.toContain('secret-marker');
  log.mockRestore(); log2.mockRestore();
 });
});
