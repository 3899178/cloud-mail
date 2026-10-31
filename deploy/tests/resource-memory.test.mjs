import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const sample=()=>({'memory.max':'335544320','memory.swap.max':'0','memory.current':'332079104','memory.peak':'335679488','memory.events':'low 0\nhigh 0\nmax 4210\noom 0\noom_kill 0\noom_group_kill 0','memory.stat':'anon 179490816\nfile 145383424\nkernel 6602752'});
const container=()=>({memory:335544320,memorySwap:335544320,oomKilled:false,restarts:0,exitCode:0});
const receipt=()=>({passed:true,accounts:50,historicalRowsPerAccount:10000,initial:sample(),final:sample()});

test('enforced memory evidence retains raw temporary peak overshoot without inventing a new allowance',async()=>{
 const {validateMemoryEvidence,validateResourceReceipt}=await import('../fixtures/resource-memory.mjs');
 const raw=sample(),before=structuredClone(raw);const result=validateMemoryEvidence(raw);
 assert.deepEqual(raw,before);assert.equal(result.memoryMax,335544320);assert.equal(result.peak,335679488);assert.equal(result.peakAboveConfiguredMax,true);assert.equal(result.softTargetExceeded,true);assert.equal(result.events.max,4210);
 assert.equal(validateMemoryEvidence({...raw,'memory.peak':'250000000','memory.current':'240000000'}).peakAboveConfiguredMax,false);
 const value=receipt();assert.equal(validateResourceReceipt(value,container(),container()).peakAboveConfiguredMax,true);assert.deepEqual(value,receipt());
});

test('missing malformed or relaxed cgroup/container evidence refuses admission at both boundaries',async()=>{
 const {validateMemoryEvidence,validateResourceReceipt}=await import('../fixtures/resource-memory.mjs');
 for(const field of Object.keys(sample())){
  for(const value of [undefined,null,0,true,'','-1','1.5','NaN','Infinity','9007199254740992']){const raw=sample();if(value===undefined)delete raw[field];else raw[field]=value;assert.throws(()=>validateMemoryEvidence(raw),/MEMORY_EVIDENCE/,field+':'+value)}
 }
 for(const change of [{'memory.max':'400000000'},{'memory.max':'max'},{'memory.swap.max':'1'},{'memory.current':' 12'},{'memory.peak':'1e9'},{'memory.events':sample()['memory.events']+'\noom 0'},{'memory.events':sample()['memory.events'].replace('max 4210','max secret')},{'memory.stat':'anon 1\nfile 2'},{'memory.stat':'anon 1\nfile 2\nkernel 3\nfile 4'}])assert.throws(()=>validateMemoryEvidence({...sample(),...change}),/MEMORY_EVIDENCE/);
 for(const key of ['low','high','max','oom','oom_kill','oom_group_kill']){const raw=sample();raw['memory.events']=raw['memory.events'].split('\n').filter(line=>!line.startsWith(key+' ')).join('\n');assert.throws(()=>validateMemoryEvidence(raw),/MEMORY_EVIDENCE/)}
 for(const key of ['oom','oom_kill','oom_group_kill']){const raw=sample();raw['memory.events']=raw['memory.events'].replace(key+' 0',key+' 1');assert.throws(()=>validateMemoryEvidence(raw),/MEMORY_EVIDENCE/)}
 for(const boundary of ['initial','final']){const r=receipt();r[boundary]['memory.max']='400000000';assert.throws(()=>validateResourceReceipt(r,container(),container()),/MEMORY_EVIDENCE/)}
 for(const change of [{memory:400000000},{memory:'335544320'},{memorySwap:400000000},{oomKilled:true},{oomKilled:'false'},{restarts:1},{restarts:null},{exitCode:1}])for(const end of [false,true])assert.throws(()=>validateResourceReceipt(receipt(),end?container():{...container(),...change},end?{...container(),...change}:container()),/MEMORY_EVIDENCE/);
 for(const key of Object.keys(container())){const c=container();delete c[key];for(const end of [false,true])assert.throws(()=>validateResourceReceipt(receipt(),end?container():c,end?c:container()),/MEMORY_EVIDENCE/)}
 for(const change of [{passed:false},{passed:'true'},{accounts:49},{historicalRowsPerAccount:'10000'},{initial:null},{final:null}])assert.throws(()=>validateResourceReceipt({...receipt(),...change},container(),container()));
});

test('host CI command accepts only successful synthetic receipt and unchanged measured container limits',()=>{
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'cm-memory-'));
 try{
  const paths=['receipt','before','after'].map(name=>join(dir,name+'.json'));
  const save=(index,value)=>writeFileSync(paths[index],JSON.stringify(value));
  save(0,receipt());save(1,container());save(2,container());
  const args=[fileURLToPath(new URL('../fixtures/resource-memory.mjs',import.meta.url)),...paths];
  let result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);assert.equal(output.final['memory.peak'],'335679488');assert.equal(output.peakAboveConfiguredMax,true);assert.equal(output.memoryEvidence.memoryMax,335544320);assert.deepEqual(output.containerEvidence,{before:container(),after:container()});
  save(2,{...container(),memorySwap:400000000});result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stdout,'');
  save(2,container());save(0,{...receipt(),passed:false});result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stdout,'');
 }finally{assert(dir.startsWith(parent+sep));rmSync(dir,{recursive:true,force:true})}
});
