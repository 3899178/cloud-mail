// Read-only mounted CI operator fixture; never an app route/runtime image file.
// Synthetic retained state only. Assertions compare logical data, never a live
// SQLite/WAL file checksum. No claim of in-flight request draining is made.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openStore} from '../../services/mail-sync/src/core/store.mjs';
const owners=['lifecycle-alpha','lifecycle-beta'];const id='same-account';
function bytesFor(owner){return Buffer.from(Array.from({length:180013},(_,i)=>(i*31+owner.length+i%251)%256))}
async function snapshot(store){
 const result=[];
 for(const owner of owners){
  const accounts=store.accounts.list(owner);assert.equal(accounts.length,1);
  const messages=store.messages.list(owner,{accountId:id}).items;assert.equal(messages.length,1);
  const message=store.messages.get(owner,messages[0].ref);assert.equal(message.attachments.length,1);
  const attachment=message.attachments[0];const content=await store.attachments.read(owner,message.ref,attachment.id);
  assert.deepEqual(content,bytesFor(owner));assert.equal(attachment.size,content.length);
  const digest=createHash('sha256').update(content).digest('hex');assert.equal(attachment.sha256,digest);
  const credential=store.credentials.get(owner,id,'protocol');assert.equal(credential,`synthetic-vault-${owner}`);
  const checkpoint=store.checkpoints.get(owner,id,'Archive');assert.deepEqual(checkpoint,{cursor:`retained-${owner}`,uidValidity:'fixture-42',baselineAt:1000});
  result.push({owner,accounts,message,checkpoint,credential,attachmentSha256:digest});
 }
 return result;
}
export async function lifecycleState(mode,{dataDir,receiptPath,masterKey}){
 assert(['seed','verify'].includes(mode));const store=openStore({dbPath:join(dataDir,'mail.sqlite'),dataDir:join(dataDir,'attachments'),masterKey});
 try{
  if(mode==='seed'){
   assert(!existsSync(receiptPath),'seed receipt must be new');
   for(const owner of owners){
    assert.equal(store.accounts.list(owner).length,0);
    store.accounts.create(owner,{id,provider:'imap',address:`${owner}@fixture.test`});store.accounts.setStatus(owner,id,'paused');
    store.credentials.set(owner,id,'protocol',`synthetic-vault-${owner}`);
    store.messages.ingest(owner,id,{folder:'Archive',folderKind:'archive',checkpoint:{cursor:`retained-${owner}`,uidValidity:'fixture-42',baselineAt:1000},messages:[{sourceId:'same-source-id',receivedAt:1793100000000,subject:`retained ${owner}`,from:'fixture@example.test',text:`retained body ${owner}`,html:'<p>retained original</p>',unread:owner===owners[0]}]});
    const ref=store.messages.list(owner).items[0].ref;const bytes=bytesFor(owner);
    await store.attachments.put(owner,ref,{filename:'original.bin',contentType:'application/octet-stream',chunks:[bytes.subarray(0,65536),bytes.subarray(65536)]});
   }
   writeFileSync(receiptPath,JSON.stringify(await snapshot(store),null,2),{flag:'wx',mode:0o600});
  }else assert.deepEqual(await snapshot(store),JSON.parse(readFileSync(receiptPath,'utf8')));
  return {preserved:true,owners:2,accounts:2,messages:2,checkpoints:2,vaultAccessible:2,attachments:2};
 }finally{store.close()}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const value=process.env.MAIL_SYNC_MASTER_KEY;assert.match(value||'',/^[a-f0-9]{64}$/i);
 const result=await lifecycleState(process.argv[2],{dataDir:'/data',receiptPath:'/evidence/lifecycle.json',masterKey:new Uint8Array(Buffer.from(value,'hex'))});
 console.log(JSON.stringify({gate:'LIFECYCLE_DURABLE_STATE',mode:process.argv[2],...result}));
}
