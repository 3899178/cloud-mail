import { fail } from '../../../../shared/unified-mail/index.mjs';

function queue(concurrency, maxQueued) {
  let active = 0; const waiting = [];
  function run(task, resolve, reject) {
    active++;
    Promise.resolve().then(task).then(resolve, reject).finally(() => {
      active--; const next = waiting.shift(); if (next) run(...next);
    });
  }
  return task => new Promise((resolve, reject) => {
    if (typeof task !== 'function') { reject(new TypeError('Task required')); return; }
    if (active < concurrency) run(task, resolve, reject);
    else if (waiting.length < maxQueued) waiting.push([task, resolve, reject]);
    else { try { fail('BUSY'); } catch (e) { reject(e); } }
  });
}
export function createWorkLimits({ maxQueued = 50 } = {}) {
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 1000) fail('INVALID_INPUT');
  return { parse: queue(1, maxQueued), reconnect: queue(2, maxQueued) };
}
