// Shared by the external Linux fixture and host CI receipt check. Kernel
// memory.max is the enforced limit; memory.peak remains an unmodified metric.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export const memoryMax=335544320,softTarget=268435456;
const refuse=()=>{throw new Error('INVALID_MEMORY_EVIDENCE')};
function counter(value){
  if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value)))refuse();
  return Number(value);
}
function fields(value,required){
  if(typeof value!=='string'||!value.length||value.length>65536)refuse();
  const result=Object.create(null);
  for(const line of value.split('\n')){
    const match=/^([a-z][a-z0-9_]*)[ \t]+(0|[1-9][0-9]*)$/.exec(line);
    if(!match||Object.hasOwn(result,match[1]))refuse();
    result[match[1]]=counter(match[2]);
  }
  if(required.some(key=>!Object.hasOwn(result,key)))refuse();
  return result;
}
export function validateMemoryEvidence(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))refuse();
  const cap=counter(raw['memory.max']),swap=counter(raw['memory.swap.max']);
  const current=counter(raw['memory.current']),peak=counter(raw['memory.peak']);
  const events=fields(raw['memory.events'],['low','high','max','oom','oom_kill','oom_group_kill']);
  const stat=fields(raw['memory.stat'],['anon','file','kernel']);
  if(cap!==memoryMax||swap!==0||events.oom!==0||events.oom_kill!==0||events.oom_group_kill!==0||current>peak)refuse();
  return {memoryMax:cap,swapMax:swap,current,peak,peakAboveConfiguredMax:peak>cap,softTargetExceeded:peak>softTarget,events,stat};
}
function validateContainer(value){
  if(!value||value.memory!==memoryMax||value.memorySwap!==memoryMax||value.oomKilled!==false||value.restarts!==0||value.exitCode!==0)refuse();
}
export function validateResourceReceipt(receipt,before,after){
  if(receipt?.passed!==true||receipt.accounts!==50||receipt.historicalRowsPerAccount!==10000)throw new Error('RESOURCE_RECEIPT_FAILED');
  validateContainer(before);validateContainer(after);
  validateMemoryEvidence(receipt.initial);
  return validateMemoryEvidence(receipt.final);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [receipt,before,after]=process.argv.slice(2).map(path=>JSON.parse(readFileSync(path,'utf8')));
    const memoryEvidence=validateResourceReceipt(receipt,before,after);
    console.log(JSON.stringify({...receipt,memoryEvidence,containerEvidence:{before,after},peakAboveConfiguredMax:memoryEvidence.peakAboveConfiguredMax,softTargetExceeded:memoryEvidence.softTargetExceeded}));
  }catch{console.error('RESOURCE_MEMORY_EVIDENCE_FAILED');process.exitCode=1}
}
