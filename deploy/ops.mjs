// Controller/operator entry point. No implicit remote connection or shell eval.
// All private paths are outside the checkout; command output is never logged.
import { execFileSync } from 'node:child_process';
import { constants, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, copyFileSync, renameSync, openSync, closeSync, fsyncSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve, sep, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupParts, validateRollout, caddyAddition, sha256 } from './gates.mjs';
const repo=realpathSync(resolve(import.meta.dirname,'..'));
const code=value=>{throw new Error(value)};
export function privatePath(path,{mustExist=true,secure=false}={}){
 if(!isAbsolute(path||'')||/[\r\n]/.test(path))code('PRIVATE_ABSOLUTE_PATH_REQUIRED');path=resolve(path);
 if(path===repo||path.startsWith(repo+sep))code('PRIVATE_PATH_INSIDE_REPOSITORY');
 let current=path;
 while(!existsSync(current)){const parent=dirname(current);if(parent===current)code('PATH_MISSING');current=parent}
 if(realpathSync(current)!==current)code('PRIVATE_SYMLINK_REFUSED');
 if(mustExist&&!existsSync(path))code('PRIVATE_PATH_MISSING');
 if(secure){if(process.platform==='win32')code('USE_OWNER_DPAPI_CONTROLLER_ADAPTER');const s=lstatSync(path);if((s.mode&0o077)||s.uid!==process.getuid())code('PRIVATE_OWNER_MODE_REQUIRED')}
 return path;
}
export function verifyBackupFiles(backup,root){
 root=privatePath(root);
 for(const part of backupParts){const item=backup.artifacts?.[part];if(!item||!/^[a-z0-9-]+\.backup$/.test(item.file||''))code('BACKUP_FILE_MISSING');const path=join(root,item.file);const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)code('BACKUP_FILE_UNSAFE');const bytes=readFileSync(path);if(bytes.length!==item.bytes||sha256(bytes)!==item.sha256)code('BACKUP_HASH_MISMATCH')}
 return true;
}
const json=path=>JSON.parse(readFileSync(privatePath(path),'utf8'));
function run(program,args,options={}){try{return execFileSync(program,args,{stdio:['ignore','pipe','pipe'],maxBuffer:128*1024*1024,...options})}catch{code('OPERATOR_COMMAND_FAILED') }}
function durable(path,bytes,mode=0o600){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),mode);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}}
export function captureBackup(config){
 const root=privatePath(config.output,{mustExist:false});privatePath(dirname(root),{secure:true});mkdirSync(root,{mode:0o700});
 const receipt={kind:'backup',capturedAt:new Date().toISOString(),target:config.target,source:config.source,currentImage:config.currentImage,firstInstall:config.firstInstall===true,artifacts:{}};
 for(const part of backupParts){const collector=config.collectors?.[part];if(!collector||!isAbsolute(collector.program)||!Array.isArray(collector.args)||!collector.args.every(a=>typeof a==='string'))code('BACKUP_COLLECTOR_MISSING');
  const bytes=run(collector.program,collector.args);if(!bytes.length)code('EMPTY_BACKUP');const file=part+'.backup';durable(join(root,file),bytes);receipt.artifacts[part]={file,bytes:bytes.length,sha256:sha256(bytes)};
 }
 const version=config.collectors['worker-version'];if(sha256(run(version.program,version.args))!==receipt.artifacts['worker-version'].sha256)code('WORKER_CHANGED_DURING_BACKUP');
 verifyBackupFiles(receipt,root);durable(join(root,'backup.json'),JSON.stringify(receipt,null,2));return receipt;
}
export function planRollout(config){
 const backup=json(config.backup);const acceptance=json(config.acceptance);validateRollout({backup,acceptance,target:config.target,source:config.source,image:config.image});
 verifyBackupFiles(backup,dirname(config.backup));const root=privatePath(config.privateRoot,{secure:process.platform!=='win32'});
 const caddy=readFileSync(privatePath(config.caddyPath),'utf8');if(sha256(caddy)!==config.expectedCaddySha256)code('CADDY_CHANGED');
 const candidate=caddyAddition(caddy,config.hostname,'cloud-mail-sync:3211');
 return {backup,acceptance,root,caddy,candidate,candidateSha256:sha256(candidate),source:config.source,image:config.image,target:config.target};
}
const docker=(args,options)=>run('docker',args,options);
function compose(config,args){return docker(['compose','--project-name','cloud-mail-'+config.target,'--env-file',join(config.privateRoot,'release.env'),'-f',resolve(import.meta.dirname,'compose.yaml'),...args])}
export function rollout(config,{apply=false}={}){
 const plan=planRollout(config);if(!apply)return {dryRun:true,target:plan.target,source:plan.source,image:plan.image,caddyBefore:sha256(plan.caddy),caddyAfter:plan.candidateSha256};
 privatePath(plan.root,{secure:true});if(!/^[a-z0-9-]+$/.test(config.caddyContainer||''))code('INVALID_CADDY_CONTAINER');
 // Runtime data is operator-provisioned with a filesystem/project quota; never
 // auto-create a storage pool, delete mail or grow a paid disk.
 privatePath(join(plan.root,'runtime.env'),{secure:true});if(!lstatSync(join(plan.root,'data')).isDirectory())code('DATA_DIRECTORY_REQUIRED');
 const releaseEnv=join(plan.root,'release.env');if(existsSync(releaseEnv))code('ARCHIVE_PRIOR_RELEASE_ENV_FIRST');
 durable(releaseEnv,`MAIL_SYNC_IMAGE=${plan.image}\nPRIVATE_ROOT=${plan.root}\n`);
 compose(config,['config','--quiet']);compose(config,['pull']);
 const candidatePath=join(plan.root,'Caddyfile.candidate');durable(candidatePath,plan.candidate);
 docker(['cp',candidatePath,`${config.caddyContainer}:/tmp/cloud-mail-candidate.caddy`]);
 docker(['exec',config.caddyContainer,'caddy','validate','--config','/tmp/cloud-mail-candidate.caddy','--adapter','caddyfile']);
 // Recheck immediately before any service/config mutation; expiry/hash drift
 // cannot be hidden by a long pull or validation phase.
 planRollout(config);
 const previous=join(plan.root,'Caddyfile.previous');durable(previous,plan.caddy);
 durable(join(plan.root,'rollout.json'),JSON.stringify({kind:'rollout',target:plan.target,source:plan.source,image:plan.image,previousImage:plan.backup.currentImage,caddyBefore:sha256(plan.caddy),caddyAfter:plan.candidateSha256,backup:config.backup,preparedAt:new Date().toISOString()},null,2));
 compose(config,['up','-d','--no-build','--wait','mail-sync']);
 if(sha256(readFileSync(config.caddyPath))!==sha256(plan.caddy))code('CADDY_CHANGED_BEFORE_RENAME');
 const temp=config.caddyPath+'.cloud-mail-new';durable(temp,plan.candidate,lstatSync(config.caddyPath).mode&0o777);renameSync(temp,config.caddyPath);
 docker(['exec',config.caddyContainer,'caddy','reload','--config','/tmp/cloud-mail-candidate.caddy','--adapter','caddyfile']);
 durable(join(plan.root,'applied.json'),JSON.stringify({image:plan.image,appliedAt:new Date().toISOString()},null,2));
 return {applied:true,image:plan.image,caddyAfter:plan.candidateSha256};
}
export function rollback(config,{apply=false}={}){
 const root=privatePath(config.privateRoot,{secure:process.platform!=='win32'});const receipt=json(join(root,'rollout.json'));
 if(receipt.target!==config.target||receipt.image!==config.currentImage||!(receipt.previousImage==='absent'||/^ghcr\.io\/[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(receipt.previousImage)))code('ROLLBACK_UNIT_MISMATCH');
 const current=readFileSync(privatePath(config.caddyPath));if(![receipt.caddyBefore,receipt.caddyAfter].includes(sha256(current)))code('CADDY_CHANGED_AFTER_ROLLOUT');
 const old=readFileSync(join(root,'Caddyfile.previous'));if(sha256(old)!==receipt.caddyBefore)code('ROLLBACK_CONFIG_HASH_MISMATCH');
 if(!apply)return {dryRun:true,previousImage:receipt.previousImage,preserveData:true,schemaBackMigration:false};
 privatePath(root,{secure:true});
 if(receipt.previousImage==='absent'){
  compose(config,['stop','mail-sync']);
 }else{
 // Probe SQLite with the current image, read-only. Never restore a backup DB
 // over live mail or run an older schema migration against newer data.
 docker(['run','--rm','--network','none','--read-only','--user','10001:10001','--entrypoint','node','-v',join(root,'data')+':/data:ro',receipt.image,'-e','const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/mail.sqlite",{readOnly:true});if(d.prepare("PRAGMA user_version").get().user_version!==1)process.exit(1);d.close()']);
 const env=join(root,'release.env');renameSync(env,join(root,'release.env.before-rollback'));durable(env,`MAIL_SYNC_IMAGE=${receipt.previousImage}\nPRIVATE_ROOT=${root}\n`);
 compose(config,['up','-d','--no-build','--wait','mail-sync']);
 }
 docker(['cp',join(root,'Caddyfile.previous'),`${config.caddyContainer}:/tmp/cloud-mail-rollback.caddy`]);docker(['exec',config.caddyContainer,'caddy','validate','--config','/tmp/cloud-mail-rollback.caddy','--adapter','caddyfile']);
 const temp=config.caddyPath+'.cloud-mail-rollback';durable(temp,old,lstatSync(config.caddyPath).mode&0o777);renameSync(temp,config.caddyPath);docker(['exec',config.caddyContainer,'caddy','reload','--config','/tmp/cloud-mail-rollback.caddy','--adapter','caddyfile']);
 return {rolledBack:true,image:receipt.previousImage,preserveData:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const mode=process.argv[2],config=json(process.argv[3]);let output;
  if(mode==='backup')output=captureBackup(config);
  else if(mode==='dry-run'||mode==='rollout')output=rollout(config,{apply:mode==='rollout'&&process.argv[4]==='--apply'});
  else if(mode==='rollback')output=rollback(config,{apply:process.argv[4]==='--apply'});
  else code('UNKNOWN_OPERATOR_MODE');
  // No data, environment values or backup names/hashes are printed wholesale.
  console.log(JSON.stringify(mode==='backup'?{backupCaptured:true,parts:Object.keys(output.artifacts).length}:output));
 }catch(error){console.error(/^[A-Z_]+$/.test(error.message)?error.message:'OPERATOR_FAILED');process.exitCode=1}
}
