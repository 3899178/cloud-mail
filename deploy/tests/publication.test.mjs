import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const source='a'.repeat(40),testedImageID='sha256:'+'b'.repeat(64),digest='sha256:'+'c'.repeat(64);
const context=()=>({repository:'3899178/cloud-mail',actor:'3899178',event:'push',ref:'refs/tags/mail-sync-preview-'+source,source,checkout:source});
const image=()=>({Id:testedImageID,Os:'linux',Architecture:'amd64',User:'10001:10001',Labels:{'org.opencontainers.image.revision':source,'org.opencontainers.image.source':'https://github.com/3899178/cloud-mail'},RepoDigests:['ghcr.io/3899178/cloud-mail/mail-sync@'+digest]});
const tested=()=>({accepted:true,source,testedImageID});
const coordinator=()=>({repository:'3899178/cloud-mail-build',actor:'3899178',event:'workflow_dispatch',ref:'refs/heads/main',source,checkout:source,workflowSource:'e'.repeat(40)});
const coordinatorImage=(labels={})=>({...image(),Labels:{...image().Labels,'org.opencontainers.image.source':'https://github.com/3899178/cloud-mail-build','org.cloudmail.application-source':'https://github.com/3899178/cloud-mail','org.cloudmail.coordinator-revision':coordinator().workflowSource,...labels},RepoDigests:['ghcr.io/3899178/cloud-mail-build/mail-sync@'+digest]});

test('publication guard binds owner repository event tag and exact checked-out SHA',async()=>{
 const {guardContext}=await import('../publication.mjs');assert.equal(guardContext(context()),source);
 assert.equal(guardContext({...context(),event:'workflow_dispatch',ref:'refs/heads/main'}),source);
 for(const delta of [{repository:'evil/cloud-mail'},{actor:'other'},{event:'pull_request'},{ref:'refs/heads/codex/unified-mail'},{ref:'refs/tags/mail-sync-preview-'+source.slice(0,7)},{ref:'refs/tags/mail-sync-preview-'+'d'.repeat(40)},{source:'bad'},{checkout:'d'.repeat(40)}])assert.throws(()=>guardContext({...context(),...delta}));
});
test('failed full acceptance cannot produce a publish receipt; successful acceptance records tested image',async()=>{
 const {acceptRelease,publishTested}=await import('../publication.mjs');let calls=[];
 const run=async(program,args,options)=>{calls.push({program,args,options});if(program==='bash')throw Error('fixture failure');return JSON.stringify(image())};
 await assert.rejects(acceptRelease(context(),{run,environment:{GHCR_TOKEN:'SECRET',GITHUB_TOKEN:'SECRET'}}));assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['deploy/ci.sh']);assert(!calls[0].options.env.GHCR_TOKEN);assert(!calls[0].options.env.GITHUB_TOKEN);
 await assert.rejects(publishTested(context(),undefined,{run,token:'SECRET',dockerConfig:'/isolated'}));assert.equal(calls.length,1);
 calls=[];const receipt=await acceptRelease(context(),{run:async(program,args)=>{calls.push({program,args});return program==='docker'?JSON.stringify(image()):''},environment:{}});assert.deepEqual(receipt,tested());assert.equal(calls[0].program,'bash');
});
test('publisher pushes only exact tested runtime with stdin login, no rebuild, and always logout',async()=>{
 const {publishTested}=await import('../publication.mjs');const calls=[];
 const run=async(program,args,options)=>{calls.push({program,args,options});return args[0]==='image'?JSON.stringify(image()):''};
 const result=await publishTested(context(),tested(),{run,token:'SECRET_TOKEN',dockerConfig:'/isolated',environment:{GHCR_TOKEN:'SECRET_TOKEN'}});
 assert.deepEqual(result,{source,digest,testedImageID});assert(!calls.some(c=>c.args.includes('build')||c.args.includes('save')));
 const login=calls.find(c=>c.args[0]==='login');assert.equal(login.options.stdin,'SECRET_TOKEN\n');assert(!JSON.stringify(login.args).includes('SECRET'));assert(!login.options.env.GHCR_TOKEN);
 assert.equal(calls.find(c=>c.args[0]==='tag').args[1],testedImageID);assert.equal(calls.find(c=>c.args[0]==='push').args[1],'ghcr.io/3899178/cloud-mail/mail-sync:'+source);assert.equal(calls.at(-1).args[0],'logout');
 const failed=[];await assert.rejects(publishTested(context(),tested(),{run:async(p,args)=>{failed.push(args[0]);if(args[0]==='push')throw Error('SECRET provider body');return args[0]==='image'?JSON.stringify(image()):''},token:'SECRET',dockerConfig:'/isolated'}));assert.equal(failed.at(-1),'logout');
 let pushed=false;await assert.rejects(publishTested(context(),tested(),{run:async(p,args)=>{if(args[0]==='push')pushed=true;return JSON.stringify({...image(),Id:'sha256:'+'d'.repeat(64)})},token:'SECRET',dockerConfig:'/isolated'}));assert.equal(pushed,false);
});

function registryFixture(){
 const config=Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',config:{User:'10001:10001',Labels:image().Labels}}));
 const id='sha256:'+createHash('sha256').update(config).digest('hex');
 const manifest=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:id,size:config.length},layers:[{mediaType:'application/vnd.oci.image.layer.v1.tar+gzip',digest:'sha256:'+'d'.repeat(64),size:20}]}));
 const md='sha256:'+createHash('sha256').update(manifest).digest('hex');
 const metadata={source,digest:md,testedImageID:id};const requests=[];
 const fetch=async(url,options)=>{requests.push({url,options});if(url.includes('/token?'))return new Response(JSON.stringify({token:'ANONYMOUS_CAPABILITY'}));if(url.includes('/manifests/'))return new Response(manifest,{headers:{'docker-content-digest':md,'content-type':'application/vnd.oci.image.manifest.v1+json'}});return new Response(config)};
 const run=async(p,args,options)=>{requests.push({program:p,args,options});return args[0]==='image'?JSON.stringify({...image(),Id:id,RepoDigests:['ghcr.io/3899178/cloud-mail/mail-sync@'+md]}):''};
 return {metadata,fetch,run,requests,manifest,config};
}
test('anonymous verifier hashes manifest and config then pulls immutable tested image with isolated credentials',async()=>{
 const {verifyPublic}=await import('../publication.mjs');const f=registryFixture();const result=await verifyPublic(context(),f.metadata,{fetch:f.fetch,run:f.run,dockerConfig:'/empty',environment:{GHCR_TOKEN:'SECRET'}});assert.deepEqual(result,f.metadata);
 const pull=f.requests.find(c=>c.args?.[0]==='pull');assert.equal(pull.args[1],'ghcr.io/3899178/cloud-mail/mail-sync@'+f.metadata.digest);assert.equal(pull.options.env.DOCKER_CONFIG,'/empty');assert(!pull.options.env.GHCR_TOKEN);assert(!f.requests.some(c=>c.args?.includes('login')));assert(!JSON.stringify(result).includes('CAPABILITY'));
});
test('anonymous refusal malformed metadata manifest/config hash and pulled identity mismatch fail closed',async()=>{
 const {verifyPublic}=await import('../publication.mjs');
 for(const change of [{source:'bad'},{source:'d'.repeat(40)},{digest:'tag:latest'},{testedImageID:null}]){const f=registryFixture();await assert.rejects(verifyPublic(context(),{...f.metadata,...change},{fetch:f.fetch,run:f.run,dockerConfig:'/empty'}));assert.equal(f.requests.length,0)}
 for(const failure of ['private','manifest-hash','config-hash','pull-id','revision','manifest-type']){
  const f=registryFixture();let pulled=false;
  const fetch=async(url,options)=>{if(failure==='private')return new Response('SECRET provider body',{status:403});if(failure==='manifest-hash'&&url.includes('/manifests/'))return new Response('{}',{headers:{'docker-content-digest':f.metadata.digest}});if(failure==='config-hash'&&url.includes('/blobs/'))return new Response('{}');return f.fetch(url,options)};
  const run=async(p,args,options)=>{if(args[0]==='pull')pulled=true;if(args[0]==='image'&&failure==='pull-id')return JSON.stringify({...image(),Id:testedImageID});if(args[0]==='image'&&failure==='revision')return JSON.stringify({...image(),Id:f.metadata.testedImageID,Labels:{...image().Labels,'org.opencontainers.image.revision':'d'.repeat(40)}});return f.run(p,args,options)};
  const metadata={...f.metadata};if(failure==='manifest-type'){const bad=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[]}));metadata.digest='sha256:'+createHash('sha256').update(bad).digest('hex');const original=fetch;await assert.rejects(verifyPublic(context(),metadata,{fetch:async(u,o)=>u.includes('/manifests/')?new Response(bad,{headers:{'docker-content-digest':metadata.digest}}):original(u,o),run,dockerConfig:'/empty'}));continue}
  await assert.rejects(verifyPublic(context(),metadata,{fetch,run,dockerConfig:'/empty'}));if(['private','manifest-hash','config-hash'].includes(failure))assert.equal(pulled,false);
 }
});
test('trusted publisher workflow runs full acceptance before token step and has independent read-only verification',()=>{
 const workflow=readFileSync('.github/workflows/publish-mail-sync.yml','utf8');
 assert.match(workflow,/mail-sync-preview-\*/);assert.match(workflow,/environment: public-image-release/);assert.match(workflow,/verify-public:/);assert.match(workflow,/needs: publish/);assert.match(workflow,/publication\.mjs accept/);assert.match(workflow,/publication\.mjs publish/);assert.match(workflow,/publication\.mjs verify/);assert.doesNotMatch(workflow,/docker build|upload-artifact|download-artifact|pull_request|secrets\.|ssh /);
 assert(workflow.indexOf('publication.mjs accept')<workflow.indexOf('GHCR_TOKEN:'));assert.equal((workflow.match(/packages: write/g)||[]).length,1);
});

test('anonymous blob redirects strip authorization and refuse other hosts or HTTP',async()=>{
 const {verifyPublic}=await import('../publication.mjs');
 const f=registryFixture();let redirected=false;
 const fetch=async(url,options)=>{
  if(url.startsWith('https://ghcr.io/')&&url.includes('/blobs/'))return new Response(null,{status:307,headers:{location:'https://pkg-containers.githubusercontent.com/config'}});
  if(url==='https://pkg-containers.githubusercontent.com/config'){redirected=true;assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,'omit');return new Response(f.config)}
  return f.fetch(url,options);
 };
 assert.deepEqual(await verifyPublic(context(),f.metadata,{fetch,run:f.run,dockerConfig:'/empty'}),f.metadata);assert(redirected);
 for(const location of ['http://pkg-containers.githubusercontent.com/config','https://attacker.example/config','https://user:password@ghcr.io/config']){
  const g=registryFixture();let followed=false;
  await assert.rejects(verifyPublic(context(),g.metadata,{fetch:async(u,o)=>{
   if(u.includes('/blobs/'))return new Response(null,{status:307,headers:{location}});
   if(!u.startsWith('https://ghcr.io/'))followed=true;
   return g.fetch(u,o);
  },run:g.run,dockerConfig:'/empty'}));assert.equal(followed,false);
 }
});

test('acceptance rejects image platform user or provenance drift and strips ambient credentials',async()=>{
 const {acceptRelease}=await import('../publication.mjs');
 for(const delta of [{Os:'windows'},{Architecture:'arm64'},{User:'root'},{Id:'tag'},{Labels:{...image().Labels,'org.opencontainers.image.source':'https://github.com/attacker/other'}}]){
  await assert.rejects(acceptRelease(context(),{environment:{PATH:'fixture-path',GHCR_TOKEN:'SECRET',ACTIONS_RUNTIME_TOKEN:'SECRET',DOCKER_AUTH_CONFIG:'SECRET'},run:async(p,a,o)=>{
   assert.equal(o.env.PATH,'fixture-path');assert.equal(o.env.GHCR_TOKEN,undefined);assert.equal(o.env.ACTIONS_RUNTIME_TOKEN,undefined);assert.equal(o.env.DOCKER_AUTH_CONFIG,undefined);
   return p==='docker'?JSON.stringify({...image(),...delta}):'';
  }}));
 }
});

test('coordinator guard requires owner manual main and independently valid application and workflow commits',async()=>{
 const {guardContext}=await import('../publication.mjs');
 assert.equal(guardContext(coordinator()),source);
 for(const delta of [{repository:'3899178/cloud-mail-build-other'},{actor:'other'},{event:'push',ref:'refs/tags/mail-sync-preview-'+source},{ref:'refs/heads/feature'},{workflowSource:undefined},{workflowSource:'short'},{source:'short'},{checkout:coordinator().workflowSource}])assert.throws(()=>guardContext({...coordinator(),...delta}));
});

test('CLI context preserves the actual workflow repository and keeps its SHA separate from the application checkout',async()=>{
 const {contextFromEnvironment,guardContext}=await import('../publication.mjs');
 const env={GITHUB_REPOSITORY:coordinator().repository,GITHUB_ACTOR:'3899178',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_SHA:coordinator().workflowSource,CLOUD_MAIL_APPLICATION_SOURCE:source};
 const c=contextFromEnvironment(env,source);assert.equal(c.repository,env.GITHUB_REPOSITORY);assert.equal(c.workflowSource,env.GITHUB_SHA);assert.equal(c.source,source);assert.equal(guardContext(c),source);
 assert.throws(()=>guardContext(contextFromEnvironment({...env,CLOUD_MAIL_APPLICATION_SOURCE:undefined},source)));
 assert.throws(()=>guardContext(contextFromEnvironment(env,env.GITHUB_SHA)));
 const original=contextFromEnvironment({...env,GITHUB_REPOSITORY:'3899178/cloud-mail',GITHUB_SHA:source,CLOUD_MAIL_APPLICATION_SOURCE:'f'.repeat(40)},source);assert.equal(original.source,source);assert.equal(guardContext(original),source);
});

test('coordinator acceptance binds build labels to both trusted commits and removes publication tokens',async()=>{
 const {acceptRelease}=await import('../publication.mjs');let built=false;
 const receipt=await acceptRelease(coordinator(),{environment:{GITHUB_REPOSITORY:coordinator().repository,GITHUB_SHA:coordinator().workflowSource,CLOUD_MAIL_IMAGE_REPOSITORY:'attacker/other',CLOUD_MAIL_COORDINATOR_SHA:'wrong',GHCR_TOKEN:'SECRET',GITHUB_TOKEN:'SECRET'},run:async(program,args,options)=>{
  if(program==='bash'){built=true;assert.equal(options.env.GITHUB_SHA,source);assert.equal(options.env.GITHUB_REPOSITORY,coordinator().repository);assert.equal(options.env.CLOUD_MAIL_IMAGE_REPOSITORY,coordinator().repository);assert.equal(options.env.CLOUD_MAIL_COORDINATOR_SHA,coordinator().workflowSource);assert.equal(options.env.GHCR_TOKEN,undefined);assert.equal(options.env.GITHUB_TOKEN,undefined);return ''}
  return JSON.stringify(coordinatorImage());
 }});assert(built);assert.deepEqual(receipt,tested());
});

test('coordinator pushes the accepted image into its own fixed package namespace without rebuilding',async()=>{
 const {publishTested}=await import('../publication.mjs');const calls=[];
 const result=await publishTested(coordinator(),tested(),{token:'SECRET',dockerConfig:'/isolated',run:async(program,args,options)=>{calls.push({program,args,options});return args[0]==='image'?JSON.stringify(coordinatorImage()):''}});
 assert.deepEqual(result,{source,digest,testedImageID});assert.equal(calls.find(c=>c.args[0]==='tag').args[1],testedImageID);assert.equal(calls.find(c=>c.args[0]==='push').args[1],'ghcr.io/3899178/cloud-mail-build/mail-sync:'+source);assert(!calls.some(c=>c.args.includes('build')));assert.equal(calls.at(-1).args[0],'logout');
});

function coordinatorRegistryFixture(labels={}){
 const config=Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',config:{User:'10001:10001',Labels:coordinatorImage(labels).Labels}}));
 const id='sha256:'+createHash('sha256').update(config).digest('hex');
 const manifest=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{mediaType:'application/vnd.oci.image.config.v1+json',digest:id,size:config.length},layers:[]}));
 const md='sha256:'+createHash('sha256').update(manifest).digest('hex');const requests=[];
 const fetch=async(url,options)=>{requests.push({url,options});return new Response(url.includes('/token?')?JSON.stringify({token:'ANONYMOUS_CAPABILITY'}):url.includes('/manifests/')?manifest:config)};
 const run=async(program,args,options)=>{requests.push({program,args,options});return args[0]==='image'?JSON.stringify({...coordinatorImage(labels),Id:id,RepoDigests:['ghcr.io/3899178/cloud-mail-build/mail-sync@'+md]}):''};
 return{metadata:{source,digest:md,testedImageID:id},fetch,run,requests};
}

test('coordinator anonymous verification pulls the same public image from its own package and checks both provenances',async()=>{
 const {verifyPublic}=await import('../publication.mjs');const f=coordinatorRegistryFixture();
 assert.deepEqual(await verifyPublic(coordinator(),f.metadata,{fetch:f.fetch,run:f.run,dockerConfig:'/empty'}),f.metadata);
 assert(f.requests[0].url.includes('scope=repository:3899178/cloud-mail-build/mail-sync:pull'));
 assert.equal(f.requests.find(c=>c.args?.[0]==='pull').args[1],'ghcr.io/3899178/cloud-mail-build/mail-sync@'+f.metadata.digest);
});

test('coordinator rejects wrong application source or workflow provenance before pushing or anonymously pulling',async()=>{
 const {acceptRelease,publishTested,verifyPublic}=await import('../publication.mjs');
 for(const labels of [{'org.opencontainers.image.source':'https://github.com/3899178/cloud-mail'},{'org.cloudmail.application-source':'https://github.com/attacker/other'},{'org.cloudmail.coordinator-revision':'f'.repeat(40)},{'org.cloudmail.coordinator-revision':undefined},{'org.opencontainers.image.revision':coordinator().workflowSource}]){
  await assert.rejects(acceptRelease(coordinator(),{run:async p=>p==='docker'?JSON.stringify(coordinatorImage(labels)):''}));
  let pushed=false;await assert.rejects(publishTested(coordinator(),tested(),{token:'SECRET',dockerConfig:'/empty',run:async(p,a)=>{if(a[0]==='push')pushed=true;return JSON.stringify(coordinatorImage(labels))}}));assert.equal(pushed,false);
  const f=coordinatorRegistryFixture(labels);await assert.rejects(verifyPublic(coordinator(),f.metadata,{fetch:f.fetch,run:f.run,dockerConfig:'/empty'}));assert(!f.requests.some(c=>c.args?.[0]==='pull'));
 }
});
