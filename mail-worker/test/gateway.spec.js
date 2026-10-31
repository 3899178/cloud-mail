import { beforeEach, it, expect } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import app from '../src/hono/webs';
import { fixture, auth, env } from './fixture';
import { encodeSourceRef, verifyGatewayAssertion } from '../../shared/unified-mail/index.mjs';
const origin='https://mail.example.test';
const ref=(accountId,id)=>encodeSourceRef({source:'cloud-mail',accountId:String(accountId),id:String(id)});
let token;
beforeEach(async()=>{await fixture();token=await auth();});
const req=(path,init={})=>app.request(origin+path,{...init,headers:{Authorization:token,...init.headers}},env);
it('requires invitations even when legacy setting disabled them, including OAuth bind',async()=>{
 for (const path of ['/register','/oauth/bindUser']) {
  if(path.includes('oauth')) await env.db.prepare("INSERT INTO oauth(oauth_user_id,user_id,platform) VALUES('provider-user',0,'google')").run();
  const r=await req(path,{method:path.includes('oauth')?'PUT':'POST',body:JSON.stringify({email:'new@example.test',password:'password',oauthUserId:'provider-user'})});
  expect((await r.json()).code).not.toBe(200);
  expect(await env.db.prepare("SELECT * FROM user WHERE email='new@example.test'").first()).toBeNull();
 }
});
it('forwards authenticated owner, exact query/body with fresh assertions and safe errors',async()=>{
 const key=new Uint8Array(32).fill(7); const seen=new Set();
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';
 env.MAIL_SYNC={fetch:async request=>{
  const url=new URL(request.url);const body=await request.text();
  const claims=await verifyGatewayAssertion({key,token:request.headers.get('x-gateway-assertion'),method:request.method,path:url.pathname+url.search,body,consumeNonce:(owner,nonce)=>{expect(seen.has(nonce)).toBe(false);seen.add(nonce);return true;}});
  expect(claims.ownerId).toBe('1');expect(body).toContain('"ownerId":"2"');return Response.json({account:{id:'a',status:'pending'}},{status:201});
 }};
 for(let i=0;i<2;i++) { const r=await req('/external/accounts',{method:'POST',headers:{'x-owner-id':'2'},body:JSON.stringify({ownerId:'2',provider:'imap',address:'a@test.example'})});expect(r.status).toBe(201); }
});
it('global fetch fallback preserves native receiver and signed owner scope without a binding', async () => {
 const previous = { binding: env.MAIL_SYNC, url: env.MAIL_SYNC_URL, key: env.MAIL_SYNC_GATEWAY_KEY };
 const originalFetch = globalThis.fetch;
 delete env.MAIL_SYNC;
 env.MAIL_SYNC_URL = 'https://gateway-global-fallback.example.test';
 env.MAIL_SYNC_GATEWAY_KEY = '07'.repeat(32);
 let outbound;
 try {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  // The pool wraps native fetch in an arrow function that binds globalThis,
  // masking workerd's native Illegal invocation check. Restore that check at
  // the real global fallback boundary while keeping all I/O locally mocked.
  globalThis.fetch = function (input, init) {
   if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
   return originalFetch(input, init);
  };
  fetchMock.get(env.MAIL_SYNC_URL).intercept({ method: 'GET', path: '/v1/accounts' }).reply(options => {
   outbound = options;
   return { statusCode: 200, data: JSON.stringify({ accounts: [] }), responseOptions: { headers: { 'content-type': 'application/json' } } };
  });
  expect(env.MAIL_SYNC).toBeUndefined();
  const response = await req('/external/accounts?ownerId=2', { headers: { 'x-owner-id': '2' } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 200, message: 'success', data: { accounts: [] } });
  expect(response.headers.get('cache-control')).toBe('no-store');
  fetchMock.assertNoPendingInterceptors();
  expect(outbound.method).toBe('GET');
  expect(outbound.path).toBe('/v1/accounts');
  const headers = new Headers(outbound.headers);
  expect(headers.has('authorization')).toBe(false);
  const claims = await verifyGatewayAssertion({
   key: new Uint8Array(32).fill(7), token: headers.get('x-gateway-assertion'),
   method: 'GET', path: '/v1/accounts', body: '', consumeNonce: () => true
  });
  expect(claims.ownerId).toBe('1');
 } finally {
  globalThis.fetch = originalFetch;
  fetchMock.deactivate();
  if (previous.binding === undefined) delete env.MAIL_SYNC; else env.MAIL_SYNC = previous.binding;
  if (previous.url === undefined) delete env.MAIL_SYNC_URL; else env.MAIL_SYNC_URL = previous.url;
  if (previous.key === undefined) delete env.MAIL_SYNC_GATEWAY_KEY; else env.MAIL_SYNC_GATEWAY_KEY = previous.key;
 }
});
it('rejects other tenant local detail, mutation and attachment refs without touching mail',async()=>{
 await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,subject,create_time) VALUES(1,2,2,'private','2026-01-01 00:00:00')").run();
 for(const [method,suffix,body] of [['GET','',undefined],['POST','/read','{"unread":false}'],['POST','/trash',undefined],['GET','/attachments/1',undefined]]) {
  const r=await req('/unified/messages/'+ref(2,1)+suffix,{method,body});expect(r.status).toBe(404);
 }
 expect((await env.db.prepare('SELECT is_del FROM email WHERE email_id=1').first()).is_del).toBe(0);
});
it('reads owned local content and original attachment bytes while sync unavailable',async()=>{
 await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,subject,text,create_time) VALUES(1,1,1,'owned','body','2026-01-01 00:00:00')").run();
 await env.db.prepare("INSERT INTO attachments(att_id,user_id,account_id,email_id,key,filename) VALUES(1,1,1,1,'attachments/test','f.txt')").run();
 await env.kv.put('attachments/test','original bytes');
 const detail=await req('/unified/messages/'+ref(1,1));expect(detail.status).toBe(200);expect((await detail.json()).data.message.text).toBe('body');
 const attachment=await req('/unified/messages/'+ref(1,1)+'/attachments/1');expect(await attachment.text()).toBe('original bytes');
});
it('external upload forwards a stream and cannot bypass JSON size boundary',async()=>{
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';const chunks=[];
 env.MAIL_SYNC={fetch:async request=>{expect(new URL(request.url).pathname).toBe('/v1/uploads/stage-1');expect(request.headers.get('x-upload-capability')).toBe('opaque-cap');await verifyGatewayAssertion({key:new Uint8Array(32).fill(7),token:request.headers.get('x-gateway-assertion'),ownerId:'1',method:'PUT',path:'/v1/uploads/stage-1',body:'',consumeNonce:()=>true});const reader=request.body.getReader();for(;;){const part=await reader.read();if(part.done)break;chunks.push(...part.value);}return Response.json({upload:{id:'stage-1',state:'ready'}});}};
 const response=await req('/external/uploads/stage-1',{method:'PUT',headers:{'x-upload-capability':'opaque-cap'},body:new Uint8Array(180000).fill(9)});expect(response.status).toBe(200);expect(chunks).toHaveLength(180000);
 const tooBig=await req('/external/accounts',{method:'POST',body:JSON.stringify({padding:'x'.repeat(65536)})});expect(tooBig.status).toBe(413);
});
it('one-shot upload conflicts remain explicit and are never presented as an outage',async()=>{
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';env.MAIL_SYNC={fetch:async()=>Response.json({error:{code:'CONFLICT'}},{status:409})};
 const r=await req('/external/uploads/used',{method:'PUT',headers:{'x-upload-capability':'used'},body:'x'});expect(r.status).toBe(409);expect((await r.json()).error.code).toBe('CONFLICT');
});
it('mandatory invite applies to public admin automation and permissioned creation',async()=>{
 const {default:Kv}=await import('../src/const/kv-const');await env.kv.put(Kv.PUBLIC_KEY,'automation');
 const pub=await app.request(origin+'/public/addUser',{method:'POST',headers:{Authorization:'automation'},body:JSON.stringify({list:[{email:'p@example.test',password:'password'}]})},env);
 expect((await pub.json()).code).not.toBe(200);
 // Authorization itself is separate from invitation: use actual site administrator KV identity.

 // Direct service invocation still uses real D1 and must require a code (no HTTP permission shortcut).
 const {default:userService}=await import('../src/service/user-service');
 await expect(userService.add({env,req:{header:()=>null},get:()=>null},{email:'p@example.test',password:'password',type:1})).rejects.toThrow();
 expect(await env.db.prepare("SELECT * FROM user WHERE email='p@example.test'").first()).toBeNull();
});
it('public automation and permissioned creation accept a valid invite and reject invalid/expired invites', async () => {
  const { default: Kv } = await import('../src/const/kv-const');
  await env.kv.put(Kv.PUBLIC_KEY, 'automation');
  await env.db.prepare("INSERT INTO perm(perm_id,name,perm_key,type) VALUES(1,'create user','user:add',2)").run();
  await env.db.prepare('INSERT INTO role_perm(role_id,perm_id) VALUES(1,1)').run();
  await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('privileged-valid',2,1,'2099-01-01 00:00:00'),('privileged-expired',2,1,'2000-01-01 00:00:00')").run();
  for (const kind of ['public', 'permissioned']) {
    const create = async (suffix, code) => {
      const row = { email: kind + suffix + '@example.test', password: 'password', code, type: 1 };
      return kind === 'public'
        ? app.request(origin + '/public/addUser', {
          method: 'POST', headers: { Authorization: 'automation' }, body: JSON.stringify({ list: [row] })
        }, env)
        : req('/user/add', { method: 'POST', body: JSON.stringify(row) });
    };
    for (const code of ['wrong', 'privileged-expired']) {
      expect((await (await create('denied', code)).json()).code).not.toBe(200);
    }
    expect((await (await create('valid', 'privileged-valid')).json()).code).toBe(200);
    const user = await env.db.prepare('SELECT user_id FROM user WHERE email=?').bind(kind + 'valid@example.test').first();
    const account = await env.db.prepare('SELECT user_id FROM account WHERE email=?').bind(kind + 'valid@example.test').first();
    expect(account.user_id).toBe(user.user_id);
    expect(await env.db.prepare('SELECT user_id FROM user WHERE email=?').bind(kind + 'denied@example.test').first()).toBeNull();
  }
  expect((await env.db.prepare("SELECT count FROM reg_key WHERE code='privileged-valid'").first()).count).toBe(0);
  expect((await env.db.prepare("SELECT count FROM reg_key WHERE code='privileged-expired'").first()).count).toBe(2);
});
it('valid invite is consumed once across concurrent public registrations; invalid/expired invite creates nothing',async()=>{
 await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('single',1,1,'2099-01-01 00:00:00'),('expired',1,1,'2000-01-01 00:00:00')").run();
 const attempt=(email,code)=>req('/register',{method:'POST',body:JSON.stringify({email,password:'password',code})});
 for(const code of ['wrong','expired'])expect((await (await attempt('denied@example.test',code)).json()).code).not.toBe(200);
 const results=await Promise.all([attempt('newa@example.test','single'),attempt('newb@example.test','single')]);const bodies=await Promise.all(results.map(r=>r.json()));expect(bodies.filter(b=>b.code===200)).toHaveLength(1);
 expect((await env.db.prepare("SELECT count FROM reg_key WHERE code='single'").first()).count).toBe(0);
 expect((await env.db.prepare("SELECT count(*) AS n FROM user WHERE email LIKE 'new%@example.test'").first()).n).toBe(1);
});
it('unverified OAuth binding identity cannot create a user even with a valid invite',async()=>{
 await env.db.prepare("INSERT INTO oauth(oauth_user_id,user_id,platform) VALUES('victim',0,'google')").run();await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('valid',1,1,'2099-01-01 00:00:00')").run();
 const r=await req('/oauth/bindUser',{method:'PUT',body:JSON.stringify({oauthUserId:'victim',email:'attacker@example.test',code:'valid'})});expect((await r.json()).code).not.toBe(200);expect(await env.db.prepare("SELECT user_id FROM user WHERE email='attacker@example.test'").first()).toBeNull();
});
it('registration rolls back user and invite when account insertion fails',async()=>{
 await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('rollback',1,1,'2099-01-01 00:00:00')").run();
 await env.db.exec("CREATE TRIGGER reject_test_account BEFORE INSERT ON account WHEN NEW.email='rollback@example.test' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
 const r=await req('/register',{method:'POST',body:JSON.stringify({email:'rollback@example.test',password:'password',code:'rollback'})});expect((await r.json()).code).not.toBe(200);
 expect(await env.db.prepare("SELECT * FROM user WHERE email='rollback@example.test'").first()).toBeNull();
 expect((await env.db.prepare("SELECT count FROM reg_key WHERE code='rollback'").first()).count).toBe(1);
});
it('OAuth identity includes platform and concurrent binds cannot reassign it or consume two invites',async()=>{
 const {default:oauthService}=await import('../src/service/oauth-service');const c={env,get:()=>undefined,req:{header:()=>undefined}};
 const google=await oauthService.saveAndLogin(c,{oauthUserId:'collision',platform:'google'});
 const github=await oauthService.saveAndLogin(c,{oauthUserId:'collision',platform:'github'});
 expect(google.userInfo.platform).toBe('google');expect(github.userInfo.oauthId).not.toBe(google.userInfo.oauthId);
 await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('race',2,1,'2099-01-01 00:00:00')").run();
 const attempts=await Promise.all(['oautha','oauthb'].map(name=>req('/oauth/bindUser',{method:'PUT',body:JSON.stringify({oauthUserId:'collision',bindingProof:google.bindingProof,email:name+'@example.test',code:'race'})})));
 const bodies=await Promise.all(attempts.map(r=>r.json()));expect(bodies.filter(b=>b.code===200)).toHaveLength(1);
 expect((await env.db.prepare("SELECT count(*) AS n FROM user WHERE email LIKE 'oauth%@example.test'").first()).n).toBe(1);
 expect((await env.db.prepare("SELECT count FROM reg_key WHERE code='race'").first()).count).toBe(1);
 expect((await env.db.prepare("SELECT user_id FROM oauth WHERE platform='github'").first()).user_id).toBe(0);
});
it('new upstream exceptions and malformed credential JSON are absent from logs and responses',async()=>{
 const {vi}=await import('vitest');const logs=[vi.spyOn(console,'log'),vi.spyOn(console,'error')];
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';env.MAIL_SYNC={fetch:async()=>{throw new Error('secret-marker-provider-password');}};
 const a=await req('/external/accounts',{method:'POST',body:'{"password":"secret-marker-malformed"'});expect(a.status).toBe(400);expect(await a.text()).not.toContain('secret-marker');
 const b=await req('/external/accounts',{method:'POST',body:'{"password":"secret-marker-json"}'});expect(b.status).toBe(503);expect(await b.text()).not.toContain('secret-marker');
 expect(JSON.stringify(logs.map(l=>l.mock.calls))).not.toContain('secret-marker');logs.forEach(l=>l.mockRestore());
});
it('OAuth binding proof permits only its verified identity, then returns a legacy-compatible token',async()=>{
 const {default:oauthService}=await import('../src/service/oauth-service');const contexts=new Map();const c={env,get:k=>contexts.get(k),set:(k,v)=>contexts.set(k,v),req:{header:()=>undefined}};
 const login=await oauthService.saveAndLogin(c,{oauthUserId:'verified',platform:'google',username:'v'});expect(login.bindingProof).toBeTruthy();
 await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('oauth-ok',1,1,'2099-01-01 00:00:00')").run();
 const response=await req('/oauth/bindUser',{method:'PUT',body:JSON.stringify({oauthUserId:'verified',bindingProof:login.bindingProof,email:'verified@example.test',code:'oauth-ok'})});expect(response.status).toBe(200);expect((await response.json()).data.token).toBeTruthy();
});
it('external OAuth callback validates state provider without cookie and never exposes resolved owner',async()=>{
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';let completions=0;
 env.MAIL_SYNC={fetch:async request=>{const path=new URL(request.url).pathname,body=await request.text();const claims=await verifyGatewayAssertion({key:new Uint8Array(32).fill(7),token:request.headers.get('x-gateway-assertion'),method:'POST',path,body,consumeNonce:()=>true});if(path==='/v1/oauth/resolve'){expect(claims.ownerId).toBe('oauth-callback');return Response.json({ownerId:'2',accountId:'same',provider:'gmail'});}expect(path).toBe('/v1/oauth/complete');expect(claims.ownerId).toBe('2');completions++;return Response.json({account:{status:'needs-auth'}});}};
 const mismatch=await app.request(origin+'/external/oauth/microsoft/callback?state=state&code=code',{},env);expect(mismatch.status).toBe(401);expect(completions).toBe(0);
 const valid=await app.request(origin+'/external/oauth/google/callback?state=state&code=code&ownerId=1',{},env);expect(valid.status).toBe(303);expect(valid.headers.get('location')).toBe('/settings?externalOAuth=attention');expect(completions).toBe(1);
 const nested=await app.request(origin+'/external/oauth/google/callback/extra?state=state&code=code',{},env);expect(nested.status).toBe(401);
});
it('same numeric IDs across sources route read/trash/download/send only to authenticated selected source',async()=>{
 await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,subject,create_time) VALUES(1,1,1,'local','2026-01-01 00:00:00')").run();
 const external=encodeSourceRef({source:'external',accountId:'1',id:'1'});const calls=[];env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';
 env.MAIL_SYNC={fetch:async request=>{const url=new URL(request.url);const body=await request.text();const claims=await verifyGatewayAssertion({key:new Uint8Array(32).fill(7),token:request.headers.get('x-gateway-assertion'),method:request.method,path:url.pathname+url.search,body,consumeNonce:()=>true});expect(claims.ownerId).toBe('1');calls.push(url.pathname);return url.pathname.includes('/attachments/')?new Response('external bytes'):Response.json({operation:{state:'failed',errorCode:'AUTH_REQUIRED'},message:{ref:external,text:'external body'}});}};
 expect((await (await req('/unified/messages/'+external)).json()).data.message.text).toBe('external body');
 for(const action of ['read','trash'])expect((await (await req('/unified/messages/'+external+'/'+action,{method:'POST',body:action==='read'?'{"unread":false}':undefined})).json()).data.operation.state).toBe('failed');
 expect(await (await req('/unified/messages/'+external+'/attachments/1')).text()).toBe('external bytes');
 expect((await (await req('/unified/messages/send',{method:'POST',body:JSON.stringify({source:'external',accountId:'1',kind:'reply',ref:external,message:{to:['t@example.test']}})})).json()).data.operation.state).toBe('failed');
 expect((await env.db.prepare('SELECT unread,is_del FROM email WHERE email_id=1').first())).toMatchObject({unread:0,is_del:0});expect(calls).toHaveLength(5);
 const local=await req('/unified/messages/'+ref(1,1)+'/read',{method:'POST',body:'{"unread":false}'});expect((await local.json()).data.operation.state).toBe('succeeded');expect(calls).toHaveLength(5);
});
it('legacy local APIs remain available when sync config and feed index are absent',async()=>{
 await env.db.prepare("INSERT INTO perm(perm_id,name,perm_key,type) VALUES(1,'delete','email:delete',2),(2,'accounts','account:query',2),(3,'all','all-email:query',2),(4,'send','email:send',2)").run();await env.db.prepare('INSERT INTO role_perm(role_id,perm_id) VALUES(1,1),(1,2),(1,3),(1,4)').run();
 await env.db.prepare("CREATE TABLE IF NOT EXISTS star(star_id INTEGER PRIMARY KEY,email_id INTEGER,user_id INTEGER,create_time TEXT)").run();
 await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,subject,create_time) VALUES(1,1,1,'local','2026-01-01 00:00:00'),(2,2,2,'admin-visible','2026-01-01 00:00:00')").run();
 const mine=await req('/my/loginUserInfo');expect((await mine.json()).data.permKeys).toContain('email:send');
 const list=await req('/email/list?accountId=1&type=0&size=20');const body=await list.json();expect(body.code).toBe(200);expect(JSON.stringify(body.data)).toContain('local');expect(JSON.stringify(body.data)).not.toContain('admin-visible');
 const all=await req('/allEmail/list?type=receive&size=20');expect(JSON.stringify((await all.json()).data)).toContain('admin-visible');
 const read=await req('/email/read',{method:'PUT',body:'{"emailIds":[1,2]}'});expect((await read.json()).code).toBe(200);expect((await env.db.prepare('SELECT unread FROM email WHERE email_id=2').first()).unread).toBe(0);
 const deleted=await req('/email/delete?emailIds=1,2',{method:'DELETE'});expect((await deleted.json()).code).toBe(200);expect((await env.db.prepare('SELECT is_del FROM email WHERE email_id=2').first()).is_del).toBe(0);
});
it('unified local send delivers through the existing local channel and refuses another owner sender',async()=>{
 await env.db.prepare("INSERT INTO perm(name,perm_key) VALUES('send','email:send')").run();await env.db.prepare('INSERT INTO role_perm(role_id,perm_id) VALUES(1,1)').run();
 const body={source:'cloud-mail',accountId:'2',kind:'send',message:{to:['u2@example.test'],subject:'local send',text:'retained local delivery'}};
 expect((await req('/unified/messages/send',{method:'POST',body:JSON.stringify(body)})).status).toBe(404);
 body.accountId='1';const r=await req('/unified/messages/send',{method:'POST',body:JSON.stringify(body)});const response=await r.json();expect(response.data?.operation.state).toBe('succeeded');
 const received=await env.db.prepare("SELECT subject,text FROM email WHERE user_id=2 AND type=0").first();expect(received).toMatchObject({subject:'local send',text:'retained local delivery'});
});
