import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {fixture,account,owner} from '../core/helpers.mjs';
import {createSyncEngine} from '../../src/sync/engine.mjs';
import {quotaMime} from '../../../../deploy/fixtures/resource-quota.mjs';
import {safeCode} from '../../../../deploy/fixtures/resource-diagnostics.mjs';

for (const exhausted of [false,true]) test(`resource quota MIME reaches bounded storage ${exhausted?'exhaustion':'success'}`,async t=>{
 const {store,options}=await fixture(t);const a=account(store);let incoming=false;
 const sizes=[];const failures=[];let decoded=0;
 const original=store.attachments.stage;
 store.attachments.stage=async(who,id,chunks)=>{
  async function* observed(){for await(const chunk of chunks){if(exhausted&&decoded>=2*1024*1024)throw Object.assign(new Error('synthetic storage full'),{code:'ENOSPC'});sizes.push(chunk.length);decoded+=chunk.length;yield chunk}}
  try{return await original(who,id,observed())}catch(error){failures.push(safeCode(error));throw error}
 };
 const engine=createSyncEngine({store,registry:{open:async()=>({folders:async()=>[{id:'INBOX',kind:'inbox'}],snapshot:async()=>({uidValidity:'q',cursor:incoming?'new':'base',messages:incoming?[{id:'1',receivedAt:a.createdAt+1,unread:true}]:[]}),fetch:async()=>Readable.from(quotaMime()),close:async()=>{}})}});
 assert.equal((await engine.syncAccount({ownerId:owner,accountId:a.id})).status,'active');
 const checkpoint=store.checkpoints.get(owner,a.id,'INBOX');incoming=true;
 const result=await engine.syncAccount({ownerId:owner,accountId:a.id});
 t.diagnostic(JSON.stringify({status:result.status,errorCode:result.errorCode,stageFailures:failures,maxDecodedChunk:Math.max(0,...sizes),decoded}));
 assert.equal(result.status,exhausted?'paused':'active');assert.equal(result.errorCode,exhausted?'STORAGE_FULL':null);
 assert(sizes.length>0&&sizes.every(size=>size<=262144));
 const directory=join(options.dataDir,owner,a.id);
 assert(!readdirSync(directory).some(name=>name.startsWith('.stage-')));
 if(exhausted){assert.deepEqual(store.checkpoints.get(owner,a.id,'INBOX'),checkpoint);assert.equal(store.messages.list(owner).items.length,0);assert.deepEqual(readdirSync(directory),[])}
 else{const message=store.messages.list(owner).items[0];const attachment=store.attachments.list(owner,message.ref)[0];assert.equal(attachment.size,3*1024*1024);assert.equal(decoded,attachment.size);assert.equal(attachment.sha256,createHash('sha256').update(Buffer.alloc(3*1024*1024)).digest('hex'))}
});
