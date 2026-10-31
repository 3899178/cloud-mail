// Trusted-source publication only. This module never deploys the service.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = '3899178/cloud-mail';
const imageName = `ghcr.io/${repository}/mail-sync`;
const sourceURL = `https://github.com/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const hash = /^sha256:[a-f0-9]{64}$/;
const manifestTypes = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const configTypes = ['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'];
function requireValue(condition) { if (!condition) throw Error('PUBLICATION_REFUSED'); }
function cleanEnvironment(environment = {}) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|DOCKER_AUTH_CONFIG/i.test(key)));
}
export function guardContext(c) {
  requireValue(c?.repository === repository && c.actor === '3899178' && sha.test(c.source) && c.checkout === c.source);
  requireValue((c.event === 'push' && c.ref === `refs/tags/mail-sync-preview-${c.source}`) || (c.event === 'workflow_dispatch' && c.ref === 'refs/heads/main'));
  return c.source;
}
function validateImage(value, source, expectedID) {
  requireValue(value && hash.test(value.Id) && value.Os === 'linux' && value.Architecture === 'amd64' && value.User === '10001:10001');
  requireValue(value.Labels?.['org.opencontainers.image.revision'] === source && value.Labels?.['org.opencontainers.image.source'] === sourceURL);
  if (expectedID) requireValue(value.Id === expectedID);
  return value;
}
const inspectArgs = ref => ['image', 'inspect', ref, '--format', '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"User":{{json .Config.User}},"Labels":{{json .Config.Labels}},"RepoDigests":{{json .RepoDigests}}}'];
const inspect = async (run, ref, options) => JSON.parse(await run('docker', inspectArgs(ref), options));
export async function acceptRelease(c, { run = execute, environment = process.env } = {}) {
  const source = guardContext(c), env = cleanEnvironment(environment);
  await run('bash', ['deploy/ci.sh'], { env, inherit: true });
  const image = validateImage(await inspect(run, 'cloud-mail:runtime', { env }), source);
  return { accepted: true, source, testedImageID: image.Id };
}
function validateMetadata(c, metadata) {
  const source = guardContext(c);
  requireValue(metadata?.source === source && hash.test(metadata.testedImageID) && hash.test(metadata.digest));
  return { source, digest: metadata.digest, testedImageID: metadata.testedImageID };
}
export async function publishTested(c, accepted, { run = execute, token, dockerConfig, environment = process.env } = {}) {
  const source = guardContext(c);
  requireValue(accepted?.accepted === true && accepted.source === source && hash.test(accepted.testedImageID));
  requireValue(typeof token === 'string' && token.length > 0 && typeof dockerConfig === 'string' && dockerConfig.length > 0);
  const options = { env: { ...cleanEnvironment(environment), DOCKER_CONFIG: dockerConfig } };
  const image = validateImage(await inspect(run, accepted.testedImageID, options), source, accepted.testedImageID);
  const tag = `${imageName}:${source}`;
  try {
    await run('docker', ['login', 'ghcr.io', '-u', '3899178', '--password-stdin'], { ...options, stdin: token + '\n' });
    await run('docker', ['tag', image.Id, tag], options);
    await run('docker', ['push', tag], options);
    const pushed = validateImage(await inspect(run, tag, options), source, accepted.testedImageID);
    const digests = [...new Set((pushed.RepoDigests || []).filter(d => d.startsWith(imageName + '@')).map(d => d.slice(imageName.length + 1)))];
    requireValue(digests.length === 1 && hash.test(digests[0]));
    return { source, digest: digests[0], testedImageID: image.Id };
  } finally {
    await run('docker', ['logout', 'ghcr.io'], options);
  }
}
async function boundedBytes(response, limit) {
  requireValue(response.ok && (!response.headers.get('content-length') || Number(response.headers.get('content-length')) <= limit));
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; requireValue(bytes <= limit); chunks.push(chunk);
    }
  } catch { throw Error('PUBLICATION_REFUSED'); }
  return Buffer.concat(chunks);
}
const digestOf = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function registryBytes(fetch, url, capability, limit, accept) {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    requireValue(current.protocol === 'https:' && !current.username && !current.password);
    const headers = { Accept: accept };
    // OCI redirects must never forward registry authorization across hosts.
    if (current.origin === 'https://ghcr.io') headers.Authorization = `Bearer ${capability}`;
    const response = await fetch(current.href, { headers, redirect: 'manual', signal: AbortSignal.timeout(60000), credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), current);
      requireValue(next.hostname === 'ghcr.io' || next.hostname.endsWith('.githubusercontent.com'));
      await response.body?.cancel(); current = next; continue;
    }
    return boundedBytes(response, limit);
  }
  throw Error('PUBLICATION_REFUSED');
}
export async function verifyPublic(c, input, { fetch = globalThis.fetch, run = execute, dockerConfig, environment = process.env } = {}) {
  const metadata = validateMetadata(c, input);
  requireValue(typeof dockerConfig === 'string' && dockerConfig.length > 0);
  // This is an anonymous pull capability, never the publisher credential.
  const auth = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}/mail-sync:pull`, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60000) });
  const capability = JSON.parse((await boundedBytes(auth, 16384)).toString()).token;
  requireValue(typeof capability === 'string' && capability.length > 0 && capability.length <= 12000 && !/[\r\n]/.test(capability));
  const rawManifest = await registryBytes(fetch, `https://ghcr.io/v2/${repository}/mail-sync/manifests/${metadata.digest}`, capability, 1024 * 1024, manifestTypes.join(', '));
  requireValue(digestOf(rawManifest) === metadata.digest);
  const manifest = JSON.parse(rawManifest.toString());
  requireValue(manifest.schemaVersion === 2 && manifestTypes.includes(manifest.mediaType) && configTypes.includes(manifest.config?.mediaType));
  requireValue(manifest.config.digest === metadata.testedImageID && Number.isSafeInteger(manifest.config.size) && manifest.config.size > 0 && manifest.config.size <= 1024 * 1024);
  const rawConfig = await registryBytes(fetch, `https://ghcr.io/v2/${repository}/mail-sync/blobs/${metadata.testedImageID}`, capability, 1024 * 1024, configTypes.join(', '));
  requireValue(rawConfig.length === manifest.config.size && digestOf(rawConfig) === metadata.testedImageID);
  const config = JSON.parse(rawConfig.toString());
  validateImage({ Id: metadata.testedImageID, Os: config.os, Architecture: config.architecture, User: config.config?.User, Labels: config.config?.Labels }, metadata.source, metadata.testedImageID);
  const options = { env: { ...cleanEnvironment(environment), DOCKER_CONFIG: dockerConfig } };
  const immutable = `${imageName}@${metadata.digest}`;
  await run('docker', ['pull', immutable], options);
  const pulled = validateImage(await inspect(run, immutable, options), metadata.source, metadata.testedImageID);
  requireValue(pulled.RepoDigests?.includes(immutable));
  return metadata;
}

async function execute(program, args, { env, stdin, inherit = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { env, stdio: [stdin === undefined ? 'ignore' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'] });
    let output = '', size = 0;
    if (!inherit) {
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) child.kill(); else output += chunk; });
      child.stderr.on('data', () => {});
    }
    child.once('error', () => reject(Error('PUBLICATION_COMMAND_FAILED')));
    child.once('close', code => code === 0 && size <= 1024 * 1024 ? resolveResult(output) : reject(Error('PUBLICATION_COMMAND_FAILED')));
    if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}
async function cli() {
  const c = { repository: process.env.GITHUB_REPOSITORY, actor: process.env.GITHUB_ACTOR, event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, source: process.env.GITHUB_SHA, checkout: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
  guardContext(c);
  const directory = process.env.RUNNER_TEMP; requireValue(typeof directory === 'string' && directory.length > 0);
  const acceptedPath = join(directory, 'mail-sync-accepted.json');
  const command = process.argv[2]; let result;
  if (command === 'accept') {
    result = await acceptRelease(c); writeFileSync(acceptedPath, JSON.stringify(result), { mode: 0o600 });
  } else if (command === 'publish' || command === 'verify') {
    const dockerConfig = mkdtempSync(join(directory, 'mail-sync-docker-'));
    try {
      if (command === 'publish') result = await publishTested(c, JSON.parse(readFileSync(acceptedPath)), { token: process.env.GHCR_TOKEN, dockerConfig });
      else result = await verifyPublic(c, { source: process.env.PUBLIC_SOURCE, digest: process.env.PUBLIC_DIGEST, testedImageID: process.env.PUBLIC_TESTED_IMAGE_ID }, { dockerConfig });
    } finally { rmSync(dockerConfig, { recursive: true, force: true }); }
    if (command === 'publish') {
      requireValue(typeof process.env.GITHUB_OUTPUT === 'string');
      for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  } else throw Error('PUBLICATION_REFUSED');
  console.log(JSON.stringify({ gate: command, ...result }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(() => { console.error('PUBLICATION_FAILED'); process.exitCode = 1; });
