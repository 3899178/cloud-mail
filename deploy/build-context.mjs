import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
const rootDefault = resolve(import.meta.dirname, '..');
export function allowed(path) {
  if (path.includes('\\') || path.split('/').some(s => s === '..' || s.startsWith('.'))) return false;
  if (/\.(?:db|sqlite\w*|eml|log|pem|key|p12|jks|env|sql|zip|tar|gz)$/i.test(path)) return false;
  if (/^services\/proton-helper\/(?:vendor|third_party)\//.test(path) && !(/\.(?:go|mod|sum|s|h|c|md)$/.test(path) || /\/(?:LICENSE(?:\.txt)?|COPYING|NOTICE|AUTHORS|PATENTS|modules\.txt)$/.test(path))) return false;
  return /^(?:shared\/unified-mail\/index\.mjs|mail-worker\/package\.json|services\/mail-sync\/(?:package(?:-lock)?\.json|(?:src|tests)\/.+\.mjs)|services\/proton-helper\/(?:[^/]+\.(?:go|mod|sum)|(?:vendor|third_party\/hydroxide)\/.+)|deploy\/(?:Dockerfile|pins\.json|runtime\/[^/]+\.go|fixtures\/[^/]+\.(?:mjs|go)|linux-suites\.mjs))$/.test(path)
    && !/(?:^|\/)(?:node_modules|\.data|backups|cache|logs|testdata\/private)(?:\/|$)/.test(path);
}
export function createContext({ root = rootDefault, destination }) {
  root = realpathSync(root); destination = resolve(destination);
  if (destination === root || destination.startsWith(root + sep)) throw new Error('CONTEXT_MUST_BE_OUTSIDE_REPOSITORY');
  if (existsSync(destination)) throw new Error('CONTEXT_DESTINATION_EXISTS');
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  const paths = tracked.filter(allowed).sort();
  for (const essential of ['deploy/Dockerfile','deploy/runtime/supervisor.go','services/mail-sync/src/index.mjs','services/proton-helper/server.go']) if (!paths.includes(essential)) throw new Error('CONTEXT_SOURCE_NOT_INDEXED');
  mkdirSync(destination, { mode: 0o700 }); const files = [];
  for (const path of paths) {
    let current = root;
    for (const part of path.split('/')) { current = resolve(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('CONTEXT_SYMLINK_REFUSED'); }
    if (!lstatSync(current).isFile()) throw new Error('CONTEXT_REGULAR_FILE_REQUIRED');
    const target = resolve(destination, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(current, target);
    files.push({ path, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') });
  }
  const lines = new Set(['**']);
  for (const { path } of files) { let parent = posix.dirname(path); while (parent !== '.') { lines.add('!' + parent + '/'); parent = posix.dirname(parent); } lines.add('!' + path); }
  writeFileSync(resolve(destination, '.dockerignore'), [...lines].join('\n') + '\n');
  writeFileSync(resolve(destination, 'context-manifest.json'), JSON.stringify({ files }, null, 2));
  return { files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { const value = createContext({ destination: process.argv[2] }); console.log(JSON.stringify({ files: value.files.length })); }
