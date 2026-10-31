// Development evidence only. Linux execution is intentionally never substituted
// with a cross-build. No external network/provider or production credentials.
import { spawnSync } from 'node:child_process';
import { mkdirSync,writeFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');const dir=resolve(root,'.data/task7b-evidence');mkdirSync(dir,{recursive:true});
const go=process.env.CLOUD_MAIL_LOCAL_GO||'D:/File/CodexConfig/.cache/cloud-mail-runtimes/go1.27.3/go/bin/go.exe';
const env={...process.env,GOTOOLCHAIN:'local',GOTELEMETRY:'off',GOPROXY:'off',CLOUD_MAIL_TEST_NODE:process.execPath};
const results=[];
function run(name,program,args,options={}){const r=spawnSync(program,args,{cwd:root,env,encoding:'utf8',timeout:180000,...options});const record={name,program,args,cwd:options.cwd||root,status:r.status,signal:r.signal,error:r.error?.code};results.push(record);writeFileSync(resolve(dir,name+'.log'),JSON.stringify(record)+'\n'+(r.stdout||'')+(r.stderr||''));console.log(JSON.stringify(record));if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);return r.status===0}
let pass=true;
const tests=readdirSync(resolve(root,'deploy/tests')).filter(f=>f.endsWith('.test.mjs')).map(f=>'deploy/tests/'+f);
pass=run('contracts-green',process.execPath,['--test',...tests])&&pass;
pass=run('linux-go-env',go,['env','GOOS','GOARCH','GOTOOLCHAIN'],{env:{...env,GOOS:'linux',GOARCH:'amd64'}})&&pass;
pass=run('supervisor-linux-build',go,['build','-trimpath','-o',resolve(dir,'supervisor-linux'),'deploy/runtime/supervisor.go'],{env:{...env,GOOS:'linux',GOARCH:'amd64',CGO_ENABLED:'0'}})&&pass;
pass=run('helper-linux-test-build',go,['test','-c','-mod=vendor','-o',resolve(dir,'helper-fixtures-linux'),'.'],{cwd:resolve(root,'services/proton-helper'),env:{...env,GOOS:'linux',GOARCH:'amd64',CGO_ENABLED:'0'}})&&pass;
pass=run('bridge-scoped',go,['test','-v','-timeout=120s','-mod=vendor','-run','TestEventActionActualJSONAndNodePersistence|TestLinuxNodePrivateProcess|TestResourceProviderChild','.'],{cwd:resolve(root,'services/proton-helper')})&&pass;
pass=run('listener-app',process.execPath,['--test','services/mail-sync/tests/core/app.test.mjs','services/mail-sync/tests/protocol/incremental.test.mjs'])&&pass;
for(const path of ['deploy/build-context.mjs','deploy/gates.mjs','deploy/ops.mjs','deploy/linux-suites.mjs','deploy/fixtures/resource.mjs','deploy/fixtures/imap-server.mjs','deploy/fixtures/private-process.mjs'])pass=run('syntax-'+path.split('/').at(-1),process.execPath,['--check',path])&&pass;
pass=run('diff-check','git',['diff','--check'])&&pass;
writeFileSync(resolve(dir,'summary.json'),JSON.stringify({platform:process.platform,passed:pass,results,linuxRuntime:'PENDING: Windows has no Docker/WSL; cross-builds are compilation only'},null,2));if(!pass)process.exitCode=1;
