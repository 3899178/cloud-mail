// Runs as the sole Node app process, alongside the exact image's Go helper and
// supervisor, under one 320MiB/no-swap cgroup. No replacement SQL/protocol code.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '../../services/mail-sync/node_modules/@hono/node-server/dist/index.mjs';
import { openStore } from '../../services/mail-sync/src/core/store.mjs';
import { createSyncApp } from '../../services/mail-sync/src/app.mjs';
import { createProviderRegistry } from '../../services/mail-sync/src/providers/registry.mjs';
import { createImapSession } from '../../services/mail-sync/src/providers/imap.mjs';
import { createProtonTransport } from '../../services/mail-sync/src/providers/proton.mjs';
import { signGatewayAssertion } from '../../shared/unified-mail/index.mjs';
assert.equal(process.platform,'linux');assert.equal(process.getuid(),10001);
const cg='/sys/fs/cgroup/';const text=f=>readFileSync(cg+f,'utf8').trim();
const metrics=()=>Object.fromEntries(['memory.current','memory.peak','memory.max','memory.swap.max','memory.events','cpu.stat','io.stat'].map(f=>[f,text(f)]));
assert.equal(text('memory.max'),'335544320');assert.equal(text('memory.swap.max'),'0');
const provider=new URL(process.env.SYNTHETIC_PROVIDER_URL);assert.equal(provider.hostname,'provider-fixture');
async function protonInfo(name='info'){const r=await fetch('https://mail.proton.me/control/'+name);assert.equal(r.status,200);return r.json()}
async function info(){const imap=await (await fetch(provider+'info')).json();const proton=await protonInfo();return {...imap,requests:imap.requests+proton.requests,metadataRows:imap.metadataRows+proton.metadataRows,egressBytes:imap.egressBytes+proton.egressBytes,proton}}
async function action(name){const r=await fetch(provider+name,{method:'POST'});assert.equal(r.status,200);await protonInfo(name)}
const remote=await info();let now=Date.now();const masterKey=new Uint8Array(32).fill(17),gatewayKey=new Uint8Array(32).fill(23);
const store=openStore({dbPath:'/data/mail.sqlite',dataDir:'/data/attachments',masterKey,clock:()=>now});
let app;const registry=createProviderRegistry({store,adapters:{proton:options=>app.services.proton.adapter(options)},sessionFactory:o=>createImapSession({...o,clock:()=>now,tlsOptions:{ca:remote.ca},endpointResolver:async()=>({host:provider.hostname,port:remote.port,servername:'fixture.test'})})});
app=createSyncApp({store,gatewayKey,registry,clock:()=>now});const server=serve({fetch:app.fetch,hostname:'0.0.0.0',port:3211});
const helper=createProtonTransport({socketPath:process.env.PROTON_HELPER_SOCKET});
const receipt={kind:'resource-fixture',passed:false,platform:process.platform,node:process.version,accounts:50,tenants:5,historicalRowsPerAccount:10000,protocolMix:{imap:49,proton:1},memoryMax:335544320,swapMax:0,parseConcurrency:1,reconnectConcurrency:2,stages:[],provider:'synthetic TLS IMAP + isolated TLS Proton API, exact production Node and Go binary including refresh/key unlock/PGP',remaining:['live-provider-consent','real-Caddy/Cloudflare-boundary','full-legacy-acceptance']};
const pairs=[];
for(let i=0;i<50;i++){const ownerId=`u${i%5}`,accountId=`a${i}`;pairs.push({ownerId,accountId});store.accounts.create(ownerId,{id:accountId,provider:i===49?'proton':'imap',address:`${accountId}@fixture.test`});if(i===49)store.credentials.set(ownerId,accountId,'proton',JSON.stringify({auth:{UID:'fixture',RefreshToken:'fixture',PasswordMode:1},mailboxPassword:'fixture-password',keySalts:{}}));else store.credentials.set(ownerId,accountId,'protocol',JSON.stringify({user:accountId,password:'synthetic-fixture-only',config:{imap:{host:'fixture.test',port:remote.port,secure:true},smtp:{host:'fixture.test',port:465,secure:true}}}));store.accounts.setStatus(ownerId,accountId,'active')}
const directoryBytes=path=>readdirSync(path,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?directoryBytes(`${path}/${e.name}`):statSync(`${path}/${e.name}`).size),0);
let cycleBegin=0;let latencies=[];const original=app.services.engine.syncAccount;
app.services.engine.syncAccount=async options=>{const started=performance.now();const result=await original(options);latencies.push({account:options.accountId,queueMs:Math.round(started-cycleBegin),completeMs:Math.round(performance.now()-cycleBegin)});return result};
async function cycle(phase,one=false){
 now+=30001;const before=await info();cycleBegin=performance.now();latencies=[];
 if(one)await app.services.engine.syncAccount(pairs[0]);else await app.services.scheduler.tick();
 const after=await info();const stage={phase,wallMs:Math.round(performance.now()-cycleBegin),cgroup:metrics(),diskBytes:directoryBytes('/data'),requests:after.requests-before.requests,metadataRows:after.metadataRows-before.metadataRows,metadataEgressBytes:after.metadataEgressBytes-before.metadataEgressBytes,egressBytes:after.egressBytes-before.egressBytes,proton:after.proton,reconnects:after.connections-before.connections,latencies};
 for(const p of (one?[pairs[0]]:pairs))assert.equal(store.accounts.get(p.ownerId,p.accountId).status,'active');
 await helper.rpc({op:'cancel',owner:'fixture-health',account:'health'});
 receipt.stages.push(stage);console.log(JSON.stringify(stage));return stage;
}
async function request(path,{ownerId='u0',method='GET',body,headers={}}={}){
 const assertionBody=method==='PUT'?'':body||'';
 const assertion=await signGatewayAssertion({key:gatewayKey,ownerId,method,path,body:assertionBody,now});
 return app.request(new Request('http://fixture'+path,{method,headers:{'x-gateway-assertion':assertion,...headers},body,duplex:'half'}));
}
try{
 assert.equal((await app.request('http://fixture/v1/accounts')).status,401);
 await cycle('baseline');for(const p of pairs){assert.equal(store.sources.catalog(p.ownerId,p.accountId).length,10000);assert.equal(store.messages.list(p.ownerId,{accountId:p.accountId}).items.length,0)}
 const unchanged=await cycle('unchanged');assert.equal(unchanged.metadataRows,0);assert.equal(unchanged.metadataEgressBytes,0);
 await action('burst');const burst=await cycle('incoming-old-Date-burst');
 for(const p of pairs)assert.equal(store.messages.list(p.ownerId,{accountId:p.accountId}).items.length,1);
 assert.equal(burst.metadataRows,52,'49 IMAP envelopes plus Proton exact-ID metadata once per normal folder');
 await action('read');await cycle('read');for(const p of pairs)assert.equal(store.messages.list(p.ownerId,{accountId:p.accountId}).items[0].unread,false);
 await action('move');await cycle('move');for(const p of pairs)assert.equal(store.messages.list(p.ownerId,{accountId:p.accountId}).items[0].folder,p.accountId==='a49'?'rule':'Rules');
 await action('delete');await cycle('source-delete');for(const p of pairs)assert.equal(store.messages.list(p.ownerId,{accountId:p.accountId}).items.length,0);
 await registry.close();const reconnect=await cycle('reconnect');assert(reconnect.reconnects>=48);assert.equal(reconnect.metadataRows,0);
 await action('large');await cycle('largest-36MiB-MIME-25MiB-attachment',true);
 const message=store.messages.list('u0',{accountId:'a0'}).items[0];const attachment=store.attachments.list('u0',message.ref)[0];assert.equal(attachment.size,25*1024*1024);
 const hash=createHash('sha256');for(let i=0;i<400;i++)hash.update(Buffer.alloc(65536));const expected=hash.digest('hex');assert.equal(attachment.sha256,expected);
 const upload=await app.services.uploads.create('u0',{accountId:'a0',filename:'upload.bin',contentType:'application/octet-stream',size:attachment.size,sha256:expected});
 async function* zeros(){for(let i=0;i<400;i++){yield Buffer.alloc(65536);if(i%10===0)await delay(1)}}
 const path=`/v1/uploads/${upload.id}`;
 const begin=performance.now();let downloadBytes=0;
 await Promise.all([
  request(path,{method:'PUT',headers:{'x-upload-capability':upload.capability},body:Readable.toWeb(Readable.from(zeros()))}).then(async r=>assert.equal(r.status,200,JSON.stringify(await r.json()))),
  (async()=>{const response=await app.services.downloads.response({ownerId:'u0',ref:message.ref,attachment,headers:{}});const hash=createHash('sha256');for await(const chunk of response.body){hash.update(chunk);downloadBytes+=chunk.length;await delay(1)}assert.equal(hash.digest('hex'),expected)})(),
  app.services.engine.syncAccount(pairs[49]).then(result=>assert.equal(result.status,'active'))
 ]);
 await app.services.uploads.cancel('u0',upload.id);assert.equal(downloadBytes,attachment.size);
 receipt.concurrentStreams={wallMs:Math.round(performance.now()-begin),uploadBytes:attachment.size,downloadBytes,cgroup:metrics()};
 const protonMessage=store.messages.list('u4',{accountId:'a49'}).items[0];const protonAttachment=store.attachments.list('u4',protonMessage.ref)[0];assert.equal(protonAttachment.size,25*1024*1024);assert.equal(protonAttachment.sha256,expected);receipt.concurrentStreams.protonDecryptedBytes=protonAttachment.size;
 await protonInfo('throttle');await registry.invalidate('u4','a49');const previous=store.checkpoints.get('u4','a49','0');
 const {createScheduler:throttleFactory}=await import('../../services/mail-sync/src/sync/scheduler.mjs');
 const throttleScheduler=throttleFactory({store:{accounts:{scheduled:()=>[pairs[49]]}},clock:()=>now,engine:app.services.engine});
 await throttleScheduler.tick();assert.equal(store.accounts.get('u4','a49').status,'error');assert.deepEqual(store.checkpoints.get('u4','a49','0'),previous);const throttleBefore=await protonInfo();now+=1000;await throttleScheduler.tick();const throttleAfter=await protonInfo();assert(throttleAfter.http429>=1);assert.equal(throttleAfter.http429,throttleBefore.http429,'no hot retry during provider backoff');now+=29000;await throttleScheduler.tick();const throttleRetry=await protonInfo();assert(throttleRetry.http429>throttleAfter.http429);await throttleScheduler.close();receipt.actual429={before:throttleBefore.http429,afterEarlyTick:throttleAfter.http429,afterRetry:throttleRetry.http429,checkpointPreserved:true,retryNotBeforeMs:30000,retryAfterSeconds:2};
 const {createSyncEngine}=await import('../../services/mail-sync/src/sync/engine.mjs');
 const quotaStore=openStore({dbPath:'/data/quota.sqlite',dataDir:'/limited/attachments',masterKey,clock:()=>now});
 quotaStore.accounts.create('quota',{id:'quota',provider:'imap',address:'quota@fixture.test'});let incoming=false;
 const quotaEngine=createSyncEngine({store:quotaStore,registry:{open:async()=>({folders:async()=>[{id:'INBOX',kind:'inbox'}],snapshot:async()=>({uidValidity:'q',cursor:incoming?'new':'base',messages:incoming?[{id:'1',receivedAt:now,unread:true}]:[]}),fetch:async()=>Readable.from(['Content-Type: multipart/mixed; boundary=q\r\n\r\n--q\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=quota.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n',Buffer.alloc(3*1024*1024).toString('base64'),'\r\n--q--\r\n']),close:async()=>{}})}});
 assert.equal((await quotaEngine.syncAccount({ownerId:'quota',accountId:'quota'})).status,'active');const prior=quotaStore.checkpoints.get('quota','quota','INBOX');incoming=true;
 const full=await quotaEngine.syncAccount({ownerId:'quota',accountId:'quota'});assert.equal(full.status,'paused');assert.equal(full.errorCode,'STORAGE_FULL');assert.deepEqual(quotaStore.checkpoints.get('quota','quota','INBOX'),prior);quotaStore.close();receipt.filesystemQuota={actualTmpfsBytes:2097152,status:full.status,errorCode:full.errorCode,checkpointPreserved:true};
 receipt.final=metrics();assert(!/oom_kill [1-9]|oom [1-9]/.test(receipt.final['memory.events']));assert(Number(receipt.final['memory.peak'])<=335544320);receipt.softTargetExceeded=Number(receipt.final['memory.peak'])>268435456;receipt.diskBytes=directoryBytes('/data');receipt.passed=true;
}finally{
 receipt.final=metrics();mkdirSync('/evidence',{recursive:true});writeFileSync('/evidence/resource.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({resourcePassed:receipt.passed,peak:receipt.final['memory.peak'],softTargetExceeded:receipt.softTargetExceeded,remaining:receipt.remaining}));
 await new Promise(r=>server.close(r));await app.services.close();store.close();
}
