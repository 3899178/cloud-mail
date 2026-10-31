import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rollback,privatePath} from '../ops.mjs';
import {sha256} from '../gates.mjs';

for(const previous of ['absent','image'])for(const drift of [true,false])test(`rollback preserves exact concurrent Caddy bytes (drift=${drift}, prior=${previous})`,()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-rollback-'));const caddy=join(root,'Caddyfile');const old='old.example { respond "retained" }\n',current=old+'sync.example { respond "new" }\n',changed=current+'unrelated.example { respond "concurrent" }\n';
 const image=`ghcr.io/example/mail@sha256:${'a'.repeat(64)}`;const calls=[];
 try{
  writeFileSync(caddy,current);writeFileSync(join(root,'Caddyfile.previous'),old);writeFileSync(join(root,'release.env'),'synthetic-only\n');writeFileSync(join(root,'rollout.json'),JSON.stringify({target:'preview',image,previousImage:previous==='absent'?'absent':image,caddyBefore:sha256(old),caddyAfter:sha256(current)}));
  const options={apply:true,checkPrivate:(path,options)=>privatePath(path,{...options,secure:false}),runCommand:(program,args)=>{calls.push(args);if(drift&&args.includes('validate'))writeFileSync(caddy,changed);return Buffer.alloc(0)}};
  if(drift){assert.throws(()=>rollback({privateRoot:root,target:'preview',currentImage:image,caddyPath:caddy,caddyContainer:'fixture'},options),/CADDY_CHANGED_BEFORE_RENAME/);assert.equal(readFileSync(caddy,'utf8'),changed);assert(!calls.some(args=>args.includes('reload')));assert(!existsSync(caddy+'.cloud-mail-rollback'))}
  else{assert.equal(rollback({privateRoot:root,target:'preview',currentImage:image,caddyPath:caddy,caddyContainer:'fixture'},options).rolledBack,true);assert.equal(readFileSync(caddy,'utf8'),old);assert(calls.some(args=>args.includes('reload')))}
  assert(!existsSync(caddy+'.cloud-mail.lock'),'cooperating lock released on failure/success');
 }finally{rmSync(root,{recursive:true,force:true})}
});
