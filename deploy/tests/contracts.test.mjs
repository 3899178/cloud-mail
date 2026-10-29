import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
test('ordinary main merge cannot deploy Worker or initialize production database', () => {
  const workflow = readFileSync(join(root, '.github/workflows/deploy-cloudflare.yml'), 'utf8');
  assert.doesNotMatch(workflow, /push:|secrets\.|wrangler deploy|\/api\/init\/|delete-workflow-runs/);
});
test('build context is selected by explicit file manifest, rejecting ignored adversarial files and links', async () => {
  const file = join(root, 'deploy/build-context.mjs');
  assert.ok(existsSync(file), 'allowlisted context builder required');
  const { createContext, allowed } = await import(pathToFileURL(file));
  const dir = mkdtempSync(join(tmpdir(), 'mail-context-'));
  try {
    const entries = ['services/mail-sync/.env', 'services/mail-sync/src/mail.sqlite', 'services/proton-helper/id_rsa', 'services/proton-helper/vendor/private/id_rsa', 'services/proton-helper/vendor/private/state.json', 'deploy/runtime/private.key', '.data/mail.eml', 'backups/full.sql', 'services/mail-sync/node_modules/leak.txt'];
    for (const entry of entries) { mkdirSync(join(dir, entry, '..'), { recursive: true }); writeFileSync(join(dir, entry), 'PRIVATE_CANARY'); }
    for (const entry of entries) assert.equal(allowed(entry), false, entry);
    const fake=join(dir,'source');mkdirSync(fake);const index=[];
    for(const path of ['deploy/Dockerfile','deploy/runtime/supervisor.go','services/mail-sync/src/index.mjs','services/proton-helper/server.go']){mkdirSync(join(fake,path,'..'),{recursive:true});writeFileSync(join(fake,path),readFileSync(join(root,path)));index.push(path)}
    for(const entry of entries){mkdirSync(join(fake,entry,'..'),{recursive:true});writeFileSync(join(fake,entry),'PRIVATE_CANARY');index.push(entry)}
    const ignored='services/mail-sync/src/ignored-credentials.mjs';writeFileSync(join(fake,ignored),'PRIVATE_CANARY');writeFileSync(join(fake,'.gitignore'),ignored+'\n');
    execFileSync('git',['init','--quiet'],{cwd:fake});execFileSync('git',['add','--',...index],{cwd:fake});
    const out = join(dir, 'out'); const manifest = createContext({ root:fake, destination: out });
    assert.equal(manifest.files.length,4);
    assert(manifest.files.every(f => !entries.includes(f.path)));
    assert(manifest.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256)));
    for(const file of manifest.files)assert(!readFileSync(join(out,file.path)).includes(Buffer.from('PRIVATE_CANARY')));
    assert(!manifest.files.some(f=>f.path===ignored));
    if(process.platform==='linux'){const link='services/mail-sync/src/linked.mjs';symlinkSync(join(fake,entries[0]),join(fake,link));execFileSync('git',['add','--',link],{cwd:fake});assert.throws(()=>createContext({root:fake,destination:join(dir,'symlink-out')}),/SYMLINK/)}
    assert.throws(() => createContext({ root, destination: root }), /OUTSIDE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('rollout gate requires fresh matching private evidence, exact image and no relaxed resource cap', async () => {
  const file = join(root, 'deploy/gates.mjs'); assert.ok(existsSync(file), 'receipt validator required');
  const { validateRollout, caddyAddition } = await import(pathToFileURL(file));
  const sha = 'a'.repeat(40), image = `ghcr.io/example/cloud-mail@sha256:${'b'.repeat(64)}`;
  const now = Date.now();
  const backup = { kind: 'backup', capturedAt: new Date(now - 1000).toISOString(), target: 'preview', source: sha, currentImage: image, artifacts: Object.fromEntries(['worker-version','worker-source','worker-assets','d1-full-sql','kv-data','kv-config','caddy','service-config'].map(k => [k, { sha256: 'c'.repeat(64), bytes: 1 }])) };
  const acceptance = { kind: 'acceptance', target: 'preview', source: sha, image, passed: true, memoryMax: 335544320, swapMax: 0, historicalRowsPerAccount: 10000, accounts: 50, nodeBridgePassed: 6, securitySkipped: 0, oomKills: 0, restarts: 0, gates: ['linux-image','private-process','resource','rollback','legacy','tenant','providers','proxy-redaction','other-apps'] };
  const input = { backup, acceptance, target: 'preview', source: sha, image, now };
  assert.equal(validateRollout(input), true);
  for (const field of ['d1-full-sql', 'worker-assets', 'kv-data', 'caddy']) { const b = structuredClone(backup); delete b.artifacts[field]; assert.throws(() => validateRollout({ ...input, backup: b })); }
  for (const delta of [{ memoryMax: 400000000 }, { accounts: 49 }, { securitySkipped: 1 }, { nodeBridgePassed: 0 }, { passed: false }, { image: image + 'x' }, { historicalRowsPerAccount: 0 }, { gates: [] }]) assert.throws(() => validateRollout({ ...input, acceptance: { ...acceptance, ...delta } }));
  assert.throws(() => validateRollout({ ...input, now: now + 3600001 }), /STALE/);
  const original = 'other.example { respond "old" }\n';
  const next = caddyAddition(original, 'sync.example', 'cloud-mail-sync:3211');
  assert(next.startsWith(original)); assert.throws(() => caddyAddition(original, 'other.example', 'cloud-mail-sync:3211'), /EXISTS/);
  assert.throws(() => caddyAddition(original, 'evil\n}', 'x'), /INVALID/);
});
test('public tests cannot access secrets or publish; image publication waits for Linux acceptance', () => {
  const ci=readFileSync(join(root,'.github/workflows/mail-sync-linux.yml'),'utf8');
  assert.doesNotMatch(ci,/secrets\.|packages: write|pull_request_target|docker login|ssh /);
  assert.match(ci,/persist-credentials: false/);
  const publish=readFileSync(join(root,'.github/workflows/publish-mail-sync.yml'),'utf8');
  assert.doesNotMatch(publish,/push:|pull_request:|pull_request_target|\$\{\{\s*secrets\.|ssh /);
  assert.match(publish,/needs: acceptance/);assert.match(publish,/refs\/heads\/main/);
  for(const workflow of [ci,publish])for(const line of workflow.split('\n').filter(l=>/uses:/.test(l)&&!l.includes('./')))assert.match(line,/@[a-f0-9]{40}(?:\s|$)/);
});
test('operator backup integrity refuses an edited prerequisite and never needs real credentials',async()=>{
  assert(existsSync(join(root,'deploy/ops.mjs')),'operator implementation required');
  const {verifyBackupFiles,privatePath}=await import(pathToFileURL(join(root,'deploy/ops.mjs')));
  const {sha256,backupParts}=await import(pathToFileURL(join(root,'deploy/gates.mjs')));
  const dir=mkdtempSync(join(tmpdir(),'mail-backup-'));
  try{const backup={artifacts:{}};for(const part of backupParts){const file=part+'.backup',bytes=Buffer.from('synthetic fixture '+part);writeFileSync(join(dir,file),bytes);backup.artifacts[part]={file,bytes:bytes.length,sha256:sha256(bytes)}}
    assert.equal(verifyBackupFiles(backup,dir),true);writeFileSync(join(dir,'caddy.backup'),'tampered');assert.throws(()=>verifyBackupFiles(backup,dir),/HASH/);assert.throws(()=>privatePath(join(root,'private')),/INSIDE/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('owned Caddy addition is idempotent while unrelated host bytes stay exact',async()=>{
 const {caddyAddition}=await import(pathToFileURL(join(root,'deploy/gates.mjs')));
 const old='existing.example { respond "old" }\n';const added=caddyAddition(old,'sync.example','cloud-mail-sync:3211');
 assert.equal(caddyAddition(added,'sync.example','cloud-mail-sync:3211'),added);assert(added.startsWith(old));
});
