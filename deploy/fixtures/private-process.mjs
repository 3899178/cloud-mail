import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, lstatSync, existsSync, readFileSync, rmSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createProtonTransport } from '../../services/mail-sync/src/providers/proton.mjs';
import { createAccountLifecycle } from '../../services/mail-sync/src/core/lifecycle.mjs';
assert.equal(process.platform,'linux'); assert.notEqual(process.getuid(),0);
const dir=mkdtempSync('/tmp/cm-unix-');chmodSync(dir,0o700);const socketPath=`${dir}/helper.sock`;
const transport=createProtonTransport({socketPath});
const scope={owner:'one',account:'account',session:'fixture-session'};
let child;
async function until(check){for(let i=0;i<200;i++){if(await check())return;await delay(25)}throw Error('FIXTURE_TIMEOUT')}
function launch(){const p=spawn(process.env.CLOUD_MAIL_UNIX_TEST_BINARY,['-test.run=^TestUnixProcessFixtureChild$'],{env:{...process.env,CLOUD_MAIL_UNIX_CHILD:'1',CLOUD_MAIL_UNIX_DIR:dir},stdio:['ignore','ignore','pipe']});p.exitResult=new Promise(r=>p.once('exit',(code,signal)=>r({code,signal})));return p;}
try {
  await assert.rejects(transport.rpc({...scope,op:'folders'}));
  child=launch(); await until(()=>existsSync(socketPath));
  for(const p of [dir,socketPath]){const s=lstatSync(p);assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o777,p===dir?0o700:0o600)}
  const collision=launch();assert.equal((await collision.exitResult).code,22,'active socket never overwritten');
  await assert.rejects(transport.rpc({...scope,owner:'two',op:'folders'}),{code:'AUTH_REQUIRED'});
  chmodSync(socketPath,0o666);await assert.rejects(transport.rpc({...scope,op:'folders'}));chmodSync(socketPath,0o600);
  const abort=new AbortController();const waiting=transport.fetch({...scope,op:'fetch',id:'wait'},{signal:abort.signal});
  await until(()=>existsSync(`${dir}/waiting`));abort.abort();await assert.rejects(waiting,{code:'BUSY'});await until(()=>existsSync(`${dir}/cancelled-before`));
  const during=new AbortController();const stream=await transport.fetch({...scope,op:'fetch',id:'stream'},{signal:during.signal});
  stream.on('error',()=>{});stream.pause();await delay(300);
  const progress=Number(readFileSync(`${dir}/progress`,'utf8'));assert(progress>0&&progress<25*1024*1024,'slow reader backpressures actual Go upstream');
  during.abort();stream.destroy();await until(()=>existsSync(`${dir}/cancelled-stream`));
  const lifecycle=createAccountLifecycle({store:{accounts:{get:()=>({status:'active'})}}});
  let stale;
  const leaseWork=lifecycle.run('one','account',async lease=>{stale=lease;const controller=transport.fetch({...scope,op:'fetch',id:'wait'},{signal:lease.signal});await assert.rejects(controller);});
  await delay(50);await lifecycle.transition('one','account',{commit:()=>{}});await leaseWork;assert.equal(stale.current(),false);
  await transport.rpc({...scope,op:'cancel'});await assert.rejects(transport.rpc({...scope,op:'folders'}),{code:'AUTH_REQUIRED'});
  child.kill('SIGKILL');await child.exitResult;
  const staleAttempt=launch();assert.equal((await staleAttempt.exitResult).code,22,'stale socket refused without proof/cleanup');
  unlinkSync(socketPath);child=launch();await until(()=>existsSync(socketPath));
  await assert.rejects(transport.rpc({...scope,owner:'two',op:'folders'}),{code:'AUTH_REQUIRED'});
  child.kill('SIGKILL');await child.exitResult;unlinkSync(socketPath);symlinkSync('/tmp',socketPath);
  await assert.rejects(transport.rpc({...scope,op:'folders'}));
  console.log(JSON.stringify({gate:'PRIVATE_PROCESS_PASSED',abortBefore:true,abortDuring:true,backpressureBytes:progress,owner:true,generation:true,cancel:true,restart:true,mode:true}));
}finally{child?.kill('SIGKILL');await child?.exitResult;rmSync(dir,{recursive:true,force:true})}
