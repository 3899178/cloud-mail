import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRollout,backupParts,gates,sha256} from '../gates.mjs';
import {planRollout} from '../ops.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const prerequisites=['reviewed-source','linux-image','private-process','resource','backup-restore','isolation','logging-config','quota','other-apps-baseline'];
function input(){
 const source='a'.repeat(40),image='ghcr.io/3899178/cloud-mail/mail-sync@sha256:'+'b'.repeat(64),now=Date.now();
 return {now,source,image,target:'preview',backup:{kind:'backup',capturedAt:new Date(now-1000).toISOString(),target:'preview',source,currentImage:'absent',firstInstall:true,artifacts:Object.fromEntries(backupParts.map(name=>[name,{bytes:1,sha256:'c'.repeat(64)}]))},acceptance:{kind:'preview-bootstrap',target:'preview',source,image,passed:true,memoryMax:335544320,swapMax:0,accounts:50,historicalRowsPerAccount:10000,nodeBridgePassed:6,securitySkipped:0,oomKills:0,restarts:0,gates:[...prerequisites],isolation:{gatewayConsumer:'operator-controller-only',productionWorkerChanged:false,previewWorkerConnected:false,existingUserAccess:false,realMailboxCredentialsPresent:false}}};
}
test('first empty operator-only service preview can bootstrap from actual prerequisite evidence',()=>{
 assert.equal(validateRollout(input()),true);
});
test('bootstrap cannot promote production replace installed service or admit users/credentials',()=>{
 const deltas=[
  v=>{v.target=v.backup.target=v.acceptance.target='production'},
  v=>{v.backup.currentImage=v.image;v.backup.firstInstall=false},
  v=>{delete v.backup.firstInstall},
  v=>{delete v.acceptance.isolation},
  v=>{v.acceptance.isolation.gatewayConsumer='public-worker'},
  ...['productionWorkerChanged','previewWorkerConnected','existingUserAccess','realMailboxCredentialsPresent'].flatMap(key=>[v=>{v.acceptance.isolation[key]=true},v=>{delete v.acceptance.isolation[key]}])
 ];
 for(const change of deltas){const value=input();change(value);assert.throws(()=>validateRollout(value))}
});
test('bootstrap still requires every runtime backup and isolation prerequisite',()=>{
 for(const name of prerequisites){const value=input();value.acceptance.gates=value.acceptance.gates.filter(g=>g!==name);assert.throws(()=>validateRollout(value),name)}
 for(const delta of [{memoryMax:400000000},{swapMax:1},{accounts:49},{nodeBridgePassed:0},{securitySkipped:1},{oomKills:1},{restarts:1},{passed:false}]){const value=input();Object.assign(value.acceptance,delta);assert.throws(()=>validateRollout(value))}
 const stale=input();stale.now+=3600001;assert.throws(()=>validateRollout(stale));
 const incomplete=input();delete incomplete.backup.artifacts['d1-full-sql'];assert.throws(()=>validateRollout(incomplete));
});
test('ordinary preview and production retain full live acceptance with no bootstrap substitution',()=>{
 for(const target of ['preview','production']){
  const value=input();value.target=value.backup.target=value.acceptance.target=target;value.acceptance.kind='acceptance';value.acceptance.gates=[...gates];delete value.acceptance.isolation;
  assert.equal(validateRollout(value),true);
  for(const name of ['providers','legacy','tenant','proxy-redaction','rollback','other-apps']){const missing=structuredClone(value);missing.acceptance.gates=missing.acceptance.gates.filter(g=>g!==name);assert.throws(()=>validateRollout(missing))}
 }
});
test('operator bootstrap planning refuses a pre-existing database or credential data directory',()=>{
 const directory=mkdtempSync(join(tmpdir(),'cloud-mail-bootstrap-'));
 try{
  const value=input();mkdirSync(join(directory,'data'));
  for(const name of backupParts){const bytes=Buffer.from('synthetic backup '+name),file=name+'.backup';writeFileSync(join(directory,file),bytes);value.backup.artifacts[name]={file,bytes:bytes.length,sha256:sha256(bytes)}}
  const caddy='existing.example { respond "old" }\n';
  writeFileSync(join(directory,'backup.json'),JSON.stringify(value.backup));writeFileSync(join(directory,'acceptance.json'),JSON.stringify(value.acceptance));writeFileSync(join(directory,'Caddyfile'),caddy);
  const config={backup:join(directory,'backup.json'),acceptance:join(directory,'acceptance.json'),privateRoot:directory,target:value.target,source:value.source,image:value.image,caddyPath:join(directory,'Caddyfile'),expectedCaddySha256:sha256(caddy),hostname:'sync.example'};
  assert.equal(planRollout(config).root,directory);
  writeFileSync(join(directory,'data','mail.sqlite'),'synthetic existing state');
  assert.throws(()=>planRollout(config),/PREVIEW_BOOTSTRAP_DATA_NOT_EMPTY/);
 }finally{rmSync(directory,{recursive:true,force:true})}
});
