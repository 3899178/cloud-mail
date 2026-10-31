import { createHash } from 'node:crypto';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
export const gates = ['linux-image','private-process','resource','rollback','legacy','tenant','providers','proxy-redaction','other-apps'];
export const previewBootstrapGates = ['reviewed-source','linux-image','private-process','resource','backup-restore','isolation','logging-config','quota','other-apps-baseline'];
export const backupParts = ['worker-version','worker-source','worker-assets','d1-full-sql','kv-data','kv-config','caddy','service-config'];
export function validateRollout({ backup, acceptance, target, source, image, now = Date.now() }) {
  if (!['preview','production'].includes(target) || !/^[a-f0-9]{40}$/.test(source) || !/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(image)) fail('INVALID_RELEASE');
  if (backup?.kind !== 'backup' || backup.target !== target || backup.source !== source || !(/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(backup.currentImage || '') || (backup.currentImage === 'absent' && backup.firstInstall === true))) fail('BACKUP_MISMATCH');
  const age = now - Date.parse(backup.capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 3600000) fail('BACKUP_STALE');
  for (const name of backupParts) if (!/^[a-f0-9]{64}$/.test(backup.artifacts?.[name]?.sha256 || '') || !(backup.artifacts[name].bytes > 0)) fail('BACKUP_INCOMPLETE');
  const bootstrap = acceptance?.kind === 'preview-bootstrap';
  if ((!bootstrap && acceptance?.kind !== 'acceptance') || acceptance.target !== target || acceptance.source !== source || acceptance.image !== image || acceptance.passed !== true) fail('ACCEPTANCE_MISMATCH');
  if (bootstrap) {
    const isolation = acceptance.isolation;
    if (target !== 'preview' || backup.currentImage !== 'absent' || backup.firstInstall !== true || isolation?.gatewayConsumer !== 'operator-controller-only' || ['productionWorkerChanged','previewWorkerConnected','existingUserAccess','realMailboxCredentialsPresent'].some(name => isolation[name] !== false)) fail('PREVIEW_BOOTSTRAP_REFUSED');
  }
  if (acceptance.memoryMax !== 335544320 || acceptance.swapMax !== 0 || acceptance.accounts !== 50 || !Number.isSafeInteger(acceptance.historicalRowsPerAccount) || acceptance.historicalRowsPerAccount < 10000 || acceptance.nodeBridgePassed !== 6 || acceptance.securitySkipped !== 0 || acceptance.oomKills !== 0 || acceptance.restarts !== 0) fail('RUNTIME_GATE_FAILED');
  if (!Array.isArray(acceptance.gates)) fail('ACCEPTANCE_INCOMPLETE');
  for (const name of bootstrap ? previewBootstrapGates : gates) if (!acceptance.gates.includes(name)) fail('ACCEPTANCE_INCOMPLETE');
  return true;
}
export function caddyAddition(original, hostname, upstream) {
  if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(hostname) || !/^[a-z0-9-]+:3211$/.test(upstream)) fail('INVALID_CADDY_TARGET');
  const stanza = `\n# cloud-mail managed addition\n${hostname} {\n\tlog {\n\t\toutput discard\n\t}\n\treverse_proxy ${upstream}\n}\n`;
  if (original.endsWith(stanza)) return original;
  if (original.includes(hostname)) fail('CADDY_HOST_EXISTS');
  return original + stanza;
}
