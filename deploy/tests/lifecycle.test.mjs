import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
for(const corruption of ['checkpoint','vault','attachment'])test(`exact-image lifecycle fixture detects lost ${corruption} after reopening`,async()=>{
 assert(existsSync('deploy/fixtures/lifecycle.mjs'),'durable lifecycle fixture required');
 const {lifecycleState}=await import('../fixtures/lifecycle.mjs');
 const dir=mkdtempSync(join(tmpdir(),'cm-lifecycle-'));
 const options={dataDir:join(dir,'data'),receiptPath:join(dir,'expected.json'),masterKey:new Uint8Array(32).fill(7)};
 try{
  await lifecycleState('seed',options);await lifecycleState('verify',options);
  const expected=JSON.parse(readFileSync(options.receiptPath));assert.equal(expected.length,2);assert.notEqual(expected[0].credential,expected[1].credential);
  // A structurally valid but emptied checkpoint table must fail preservation.
  if(corruption==='attachment'){const item=expected[0];writeFileSync(join(options.dataDir,'attachments',item.owner,'same-account',item.message.attachments[0].id),'corrupt')}
  else{const db=new DatabaseSync(join(options.dataDir,'mail.sqlite'));db.exec(corruption==='checkpoint'?'DELETE FROM checkpoints':'DELETE FROM credentials');db.close()}
  await assert.rejects(lifecycleState('verify',options));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('CI seeds before helper crash and verifies retained logical state after restart and stop/start',()=>{
 const ci=readFileSync('deploy/ci.sh','utf8');const seed=ci.indexOf('lifecycle.mjs seed'),crash=ci.indexOf('kill -KILL');assert(seed>0&&seed<crash);
 assert.equal(ci.match(/lifecycle\.mjs verify/g)?.length,3);assert.doesNotMatch(ci,/before=\$\(sha256sum/);
 assert(ci.indexOf('lifecycle.mjs verify',crash)<ci.indexOf('docker stop --time 25',crash));
});
