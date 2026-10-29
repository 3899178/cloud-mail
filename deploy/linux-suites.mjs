// Secret-free Linux gate. A platform/security/Node bridge skip is a failure.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 10001);
assert.equal(process.env.CLOUD_MAIL_TEST_NODE, '/usr/local/bin/node');
mkdirSync('/tmp/evidence',{recursive:true});
async function run(name, command, args, cwd = '/app') {
  let output = ''; const child = spawn(command,args,{cwd,env:process.env});
  child.stdout.on('data',b => { output += b; process.stdout.write(b); }); child.stderr.on('data',b => { output += b; process.stderr.write(b); });
  const code = await new Promise((resolve,reject) => {child.once('error',reject);child.once('exit',resolve);});
  writeFileSync(`/tmp/evidence/${name}.log`,output);
  assert.equal(code,0,name); assert.doesNotMatch(output,/--- SKIP:|# SKIP|# skip(?:ped)? [1-9]/,`${name}: no skipped Linux cases`); return output;
}
const nodeFiles = ['core','protocol','sync'].flatMap(d => readdirSync(`/app/services/mail-sync/tests/${d}`).filter(f => f.endsWith('.test.mjs')).map(f => `services/mail-sync/tests/${d}/${f}`));
await run('node','/usr/local/bin/node',['--test','--test-reporter=tap',...nodeFiles]);
const go = await run('go','go',['test','-v','-timeout=180s','-mod=vendor','./...'],'/app/services/proton-helper');
assert.match(go,/TestPrivateUnixSocketPermissionsAndHTTP/);
assert.match(go,/# tests 6/); assert.match(go,/# pass 6/); assert.match(go,/# fail 0/); assert.match(go,/# skipped 0/);
await run('pinned-client','go',['test','-v','-timeout=120s','-mod=vendor','github.com/emersion/hydroxide/protonmail'],'/app/services/proton-helper');
assert.match(go,/TestLinuxNodePrivateProcess/);
console.log(JSON.stringify({platform:'linux',nodeBridgePassed:6,securitySkipped:0,passed:true}));
