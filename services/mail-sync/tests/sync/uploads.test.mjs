import {readdirSync} from 'node:fs';
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fixture,account,owner} from '../core/helpers.mjs';
import {createSyncApp} from '../../src/app.mjs';
import {signGatewayAssertion} from '../../../../shared/unified-mail/index.mjs';
const key=new Uint8Array(32).fill(8);
test('fresh upload admission rejects non-object JSON with a safe input error', async t => {
  const { store } = await fixture(t);
  const app = createSyncApp({ store, gatewayKey: key });
  t.after(() => app.services.close());
  for (const value of [null, [], 'secret-marker', 42]) {
    const response = await call(app, '/v1/uploads', value);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_INPUT' } });
  }
});
async function call(app,path,body,who=owner,method='POST',headers={}){const bytes=body===undefined?'':JSON.stringify(body);return app.request('https://sync.test'+path,{method,headers:{'x-gateway-assertion':await signGatewayAssertion({key,ownerId:who,method,path,body:bytes}),...headers},body:method==='GET'?undefined:bytes});}
test('fresh upload is hash-checked, owner/account-bound, one-shot and streams into send',async t=>{
 const {store,options}=await fixture(t);account(store);account(store,'other');account(store,owner,'acc-2');let received;
 const app=createSyncApp({store,gatewayKey:key,registry:{open:async()=>({send:async m=>{const chunks=[];for await(const c of m.attachments[0].content){assert.ok(c.length<=65536);chunks.push(c);}received=Buffer.concat(chunks);},close:async()=>{}}),close:async()=>{}}});t.after(()=>app.services.close());
 const bytes=Buffer.alloc(180000,7),sha256=createHash('sha256').update(bytes).digest('hex');
 const r=await call(app,'/v1/uploads',{accountId:'acc-1',filename:'fresh.bin',size:bytes.length,sha256,contentType:'application/octet-stream'});assert.equal(r.status,201);
 const {upload}=await r.json();
 async function uploadAs(who,cap=upload.capability){const path='/v1/uploads/'+upload.id;return app.request('https://sync.test'+path,{method:'PUT',headers:{'x-gateway-assertion':await signGatewayAssertion({key,ownerId:who,method:'PUT',path,body:''}),'x-upload-capability':cap},body:bytes});}
 assert.equal((await uploadAs('other')).status,404);assert.equal((await uploadAs(owner,'tampered')).status,401);
 assert.equal((await uploadAs(owner)).status,200);assert.equal((await uploadAs(owner)).status,409);
 const body={accountId:'acc-1',kind:'send',message:{to:['to@example.test'],uploadIds:[upload.id]}};
 const wrongAccount=await call(app,'/v1/send',{...body,accountId:'acc-2'});assert.equal((await wrongAccount.json()).operation.state,'failed');
 const send=await call(app,'/v1/send',body);assert.equal(send.status,200);assert.equal((await send.json()).operation.state,'succeeded');assert.deepEqual(received,bytes);assert.equal(readdirSync(options.dataDir,{recursive:true}).some(name=>name.includes('.compose-')),false);
 const replay=await call(app,'/v1/send',body);assert.equal((await replay.json()).operation.state,'failed');
});
test('digest mismatch destroys stage; pause invalidates admission; ordinary 65KiB assertion remains',async t=>{
 const {store,options}=await fixture(t);account(store);const app=createSyncApp({store,gatewayKey:key});t.after(()=>app.services.close());
 const r=await call(app,'/v1/uploads',{accountId:'acc-1',filename:'a',size:1,sha256:'00'.repeat(32),contentType:'text/plain'});assert.equal(r.status,201);const {upload}=await r.json();
 const path='/v1/uploads/'+upload.id;
 const bad=await app.request('https://sync.test'+path,{method:'PUT',headers:{'x-upload-capability':upload.capability,'x-gateway-assertion':await signGatewayAssertion({key,ownerId:owner,method:'PUT',path})},body:'a'});assert.equal(bad.status,400);assert.equal(readdirSync(options.dataDir,{recursive:true}).some(name=>name.includes('.compose-')),false);
 assert.equal((await call(app,'/v1/accounts/acc-1/pause',{})).status,200);
 assert.equal((await call(app,'/v1/uploads',{accountId:'acc-1',filename:'a',size:1,sha256:'00'.repeat(32)})).status,409);
 assert.equal((await call(app,'/v1/accounts',{padding:'a'.repeat(65537)})).status,413);
});
test('pause aborts a pending stream and removes partial files before unbind; expired admission never uploads',async t=>{
 const {store,options}=await fixture(t);let now=Date.now();account(store);const app=createSyncApp({store,gatewayKey:key,clock:()=>now});t.after(()=>app.services.close());
 const r=await call(app,'/v1/uploads',{accountId:'acc-1',filename:'a',size:2,sha256:createHash('sha256').update('ab').digest('hex')});const {upload}=await r.json();
 const path='/v1/uploads/'+upload.id;let started,cancelled=false;const ready=new Promise(r=>started=r);
 const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array([97]));started();return new Promise(()=>{});},cancel(){cancelled=true;}});
 const receiving=app.request(new Request('https://sync.test'+path,{method:'PUT',duplex:'half',body:stream,headers:{'x-upload-capability':upload.capability,'x-gateway-assertion':await signGatewayAssertion({key,ownerId:owner,method:'PUT',path})}}));
 await ready;await new Promise(r=>setTimeout(r,20));const paused=await call(app,'/v1/accounts/acc-1/pause',{});assert.equal(paused.status,200);assert.notEqual((await receiving).status,200);assert.equal(cancelled,true);assert.equal(readdirSync(options.dataDir,{recursive:true}).some(name=>name.includes('.compose-')),false);
 assert.equal((await call(app,'/v1/accounts/acc-1',undefined,owner,'DELETE')).status,200);
 account(store);const admitted=await call(app,'/v1/uploads',{accountId:'acc-1',filename:'a',size:1,sha256:'00'.repeat(32)});const u=(await admitted.json()).upload;now+=600001;
 const expiredPath='/v1/uploads/'+u.id;const expired=await app.request('https://sync.test'+expiredPath,{method:'PUT',body:'a',headers:{'x-upload-capability':u.capability,'x-gateway-assertion':await signGatewayAssertion({key,ownerId:owner,method:'PUT',path:expiredPath,now})}});assert.equal(expired.status,410);
});
test('quota reservation rejects a fifth 25MiB stage and cancellation frees quota',async t=>{
 const {store,options}=await fixture(t);account(store);const app=createSyncApp({store,gatewayKey:key});t.after(()=>app.services.close());
 const uploads=[];for(let i=0;i<4;i++){const r=await call(app,'/v1/uploads',{accountId:'acc-1',filename:'f',size:25*1024*1024,sha256:'00'.repeat(32)});assert.equal(r.status,201);uploads.push((await r.json()).upload);}
 assert.equal((await call(app,'/v1/uploads',{accountId:'acc-1',filename:'f',size:1,sha256:'00'.repeat(32)})).status,507);
 assert.equal((await call(app,'/v1/uploads/'+uploads[0].id,undefined,owner,'DELETE')).status,200);
 assert.equal((await call(app,'/v1/uploads',{accountId:'acc-1',filename:'f',size:1,sha256:'00'.repeat(32)})).status,201);
});
test('request abort removes the partial file and destroys its handle',async t=>{
 const {store,options}=await fixture(t);account(store);const app=createSyncApp({store,gatewayKey:key});t.after(()=>app.services.close());
 const r=await call(app,'/v1/uploads',{accountId:'acc-1',filename:'a',size:2,sha256:'00'.repeat(32)});const {upload}=await r.json();const path='/v1/uploads/'+upload.id;
 const abort=new AbortController();let began;const ready=new Promise(r=>began=r);const stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));began();return new Promise(()=>{});}});
 const receiving=app.request(new Request('https://sync.test'+path,{method:'PUT',duplex:'half',body:stream,signal:abort.signal,headers:{'x-upload-capability':upload.capability,'x-gateway-assertion':await signGatewayAssertion({key,ownerId:owner,method:'PUT',path})}}));await ready;
 // Stream prefetch can precede gateway authentication. Abort only after the
 // real receiver opens its stage, rather than racing a fixed 10ms timer.
 const deadline=Date.now()+5000;
 while(!readdirSync(options.dataDir,{recursive:true}).some(name=>name.includes('.compose-'))){
  if(Date.now()>=deadline){abort.abort();await receiving;assert.fail('upload receiver did not open its stage');}
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 abort.abort();assert.notEqual((await receiving).status,200);assert.equal(readdirSync(options.dataDir,{recursive:true}).some(name=>name.includes('.compose-')),false);
 assert.equal((await call(app,'/v1/uploads/'+upload.id,undefined,owner,'DELETE')).status,404);
});
