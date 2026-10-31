import test from 'node:test';
import assert from 'node:assert/strict';
test('scheduler rotates fairly, bounds due queue, and excludes paused/needs-auth accounts', async () => {
  const m = await import('../../src/sync/scheduler.mjs').catch(() => ({}));
  assert.equal(typeof m.createScheduler, 'function', 'fair scheduler exists');
  const calls = []; let now = 0;
  const store = { accounts: { scheduled: () => Array.from({ length: 50 }, (_, i) => ({ ownerId: `u${i % 5}`, accountId: `a${i}`, status: i === 0 ? 'paused' : i === 1 ? 'needs-auth' : 'active' })) } };
  let active = 0; let peak = 0;
  const engine = { async syncAccount(pair) { active++; peak = Math.max(peak, active); calls.push(pair.accountId); await new Promise(resolve => setImmediate(resolve)); active--; } };
  const scheduler = m.createScheduler({ store, engine, clock: () => now });
  await scheduler.tick();
  assert.equal(calls.length, 48); assert.ok(peak <= 2); assert.equal(new Set(calls).size, 48);
  await scheduler.tick(); assert.equal(calls.length, 48);
  now += 30000; await scheduler.tick(); assert.equal(calls.length, 96);
  assert.equal(calls[48], calls[1]);
});
