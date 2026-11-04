// Production helper response envelopes captured from actual HTTP JSON by Go.
// This transport bridge does not claim real Proton or private Unix acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,owner} from '../core/helpers.mjs';
import {wireMime} from './fixtures.mjs';
import {createProton} from '../../src/providers/proton.mjs';
import {createAccountLifecycle} from '../../src/core/lifecycle.mjs';
import {createSyncEngine} from '../../src/sync/engine.mjs';

const responses=JSON.parse(process.env.CLOUD_MAIL_INVENTORY_FIXTURE);
for(const malformed of ['missing-all','null-envelope','missing-total','null-total','missing-messages','null-messages','missing-code','null-code','failed-code','changing-total']){
 test(`actual helper ${malformed} inventory preserves committed mail, checkpoint and attachment`,async t=>{
  const {store,options}=await fixture(t);
  const account=store.accounts.create(owner,{id:'proton-inventory',provider:'proton',address:'user@proton.me'});
  store.credentials.set(owner,account.id,'proton',JSON.stringify({auth:{RefreshToken:'fixture'}}));
  let phase='baseline',bodyReads=0;
  const transport={async rpc(request){
   if(request.op==='open')return {material:request.material,session:'fixture-session',expiresAt:options.clock()+600000};
   if(request.op==='folders')return {folders:[{id:'0',kind:'inbox'}]};
   if(request.op==='validate')return {valid:true};
   if(request.op==='snapshot'){const result=responses[phase];if(result.error)throw Object.assign(new Error(result.error),{code:result.error});return result}
   return {ok:true};
  },async fetch(){bodyReads++;return Readable.from([wireMime('admitted','preserved inventory body')])}};
  const lifecycle=createAccountLifecycle({store}),proton=createProton({store,lifecycle,transport,clock:options.clock});
  const engine=createSyncEngine({store,lifecycle,registry:{open:request=>proton.adapter(request)}});
  const sync=()=>engine.syncAccount({ownerId:owner,accountId:account.id});
  assert.equal((await sync()).status,'active');
  const ref=store.messages.list(owner).items[0].ref,checkpoint=store.checkpoints.get(owner,account.id,'0');
  const catalog=store.sources.catalog(owner,account.id),message=store.messages.get(owner,ref),attachments=store.attachments.list(owner,ref);
  assert.match(message.text,/preserved inventory body/);assert.equal(attachments.length,1);
  const bytes=await store.attachments.read(owner,ref,attachments[0].id);assert.deepEqual(bytes,Buffer.from([0,1,2,255]));
  phase=malformed;assert.equal((await sync()).errorCode,'SYNC_FAILED');
  assert.deepEqual(store.checkpoints.get(owner,account.id,'0'),checkpoint);assert.deepEqual(store.sources.catalog(owner,account.id),catalog);
  assert.deepEqual(store.messages.get(owner,ref),message);assert.deepEqual(store.attachments.list(owner,ref),attachments);
  assert.deepEqual(await store.attachments.read(owner,ref,attachments[0].id),bytes);assert.equal(bodyReads,1);
  phase='retry';assert.equal((await sync()).status,'active');assert.equal(store.checkpoints.get(owner,account.id,'0').cursor,'retry');
  assert.equal(store.messages.get(owner,ref).unread,false);assert.deepEqual(await store.attachments.read(owner,ref,attachments[0].id),bytes);assert.equal(bodyReads,1);
  phase='empty';assert.equal((await sync()).status,'active');assert.equal(store.messages.list(owner).items.length,0);
  assert.equal(store.sources.catalog(owner,account.id).length,0,'an explicit successful empty inventory retains source-deletion authority');
  await assert.rejects(store.attachments.read(owner,ref,attachments[0].id),{code:'NOT_FOUND'});
  assert.equal(existsSync(join(options.dataDir,owner,account.id,attachments[0].id)),false,'confirmed source deletion removes the online attachment file');
 });
}
