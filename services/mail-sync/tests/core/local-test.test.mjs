import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tempBase } from './helpers.mjs';
import { spawnSync } from 'node:child_process';

test('worker npm test executes local tests without invoking deployment', t => {
  const dir = mkdtempSync(join(tempBase, 'mail-worker-script-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = JSON.parse(readFileSync(new URL('../../../../mail-worker/package.json', import.meta.url))).scripts;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  const bin = join(dir, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  for (const executable of ['vitest', 'wrangler']) {
    const path = join(bin, executable + (process.platform === 'win32' ? '.cmd' : ''));
    writeFileSync(path, process.platform === 'win32' ? `@echo ${executable}> "${join(dir, executable)}"\r\n` : `#!/bin/sh\necho ${executable} > '${join(dir, executable)}'\n`, { mode: 0o755 });
  }
  const result = spawnSync('npm test', { cwd: dir, shell: true, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(dir, 'wrangler')), false, 'npm test must never invoke wrangler deployment');
  assert.equal(existsSync(join(dir, 'vitest')), true, 'npm test must run the local suite');
});
