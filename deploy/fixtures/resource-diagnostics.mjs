// Test-harness diagnostics only. Never serialize provider errors, credentials,
// addresses, command lines or environment variables.
import {readFileSync, readdirSync} from 'node:fs';

const codes = new Set(['AUTH_REQUIRED','UNAUTHORIZED','INVALID_INPUT','CAPACITY_EXCEEDED','RESYNC_REQUIRED','PROVIDER_UNAVAILABLE','SYNC_FAILED','BUSY','RATE_LIMITED','STORAGE_FULL','PROVIDER_TIMEOUT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EPIPE','ENOSPC','ABORT_ERR']);
const operations = new Set(['open','folders','snapshot','fetch','validateSnapshot','idle','close']);
export const safeCode = error => codes.has(error?.code) ? error.code : 'UNCLASSIFIED';
export function operationRecorder() {
  const records = [];
  return {
    failure(provider, account, operation, error) {
      if (!['imap','proton'].includes(provider) || !/^a(?:[0-9]|[1-4][0-9])$/.test(account) || !operations.has(operation)) return;
      records.push({provider,account,operation,code:safeCode(error)});
      if (records.length > 32) records.shift();
    },
    snapshot: () => records.map(record => ({...record})),
  };
}
export function observeSession(session, provider, account, recorder) {
  const result = {...session};
  for (const operation of operations) {
    if (operation === 'open' || typeof session[operation] !== 'function') continue;
    result[operation] = async (...args) => {
      try { return await session[operation](...args); }
      catch (error) { recorder.failure(provider,account,operation,error); throw error; }
    };
  }
  return result;
}
export function recordStage(receipt, stage, emit = console.log) {
  receipt.stages.push(stage);
  emit(JSON.stringify(stage));
  if (stage.accounts.some(account => account.status !== 'active')) throw new Error('RESOURCE_STAGE_FAILED');
  return true;
}
export function parseProcessStatus(source, uid) {
  const field = name => source.match(new RegExp(`^${name}:\\s*(.+)$`,'m'))?.[1];
  const names = {'node':'node','proton-helper':'proton-helper','supervisor':'supervisor'};
  const name = field('Name');
  const kind = Object.hasOwn(names,name) ? names[name] : null;
  if (!kind || !field('Uid')?.split(/\s+/).every(value => Number(value) === uid)) return null;
  const bytes = name => { const match = /^(\d+)\s+kB$/.exec(field(name) || ''); return match ? Number(match[1])*1024 : null; };
  return {kind,rssBytes:bytes('VmRSS'),highWaterBytes:bytes('VmHWM')};
}
export function processMemory() {
  const processes = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const status = parseProcessStatus(readFileSync(`/proc/${pid}/status`,'utf8'),process.getuid());
      if (status) processes.push({pid:Number(pid),...status});
    } catch { /* Process may exit between enumeration and read. */ }
    if (processes.length === 16) break;
  }
  return {node:process.memoryUsage(),sameUidProcesses:processes};
}
