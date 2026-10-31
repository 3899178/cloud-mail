export function createScheduler({ store, engine, clock = Date.now, intervalMs = 30000 }) {
  const due = new Map(); const lastStart = new Map(); const abort = new AbortController();
  let offset = 0; let ticking; let timer;
  const key = pair => JSON.stringify([pair.ownerId, pair.accountId]);
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const all = store.accounts.scheduled().filter(a => !['paused', 'needs-auth', 'pending'].includes(a.status));
      const keys = new Set(all.map(key)); for (const k of due.keys()) if (!keys.has(k)) { due.delete(k); lastStart.delete(k); }
      const ordered = [...all.slice(offset % (all.length || 1)), ...all.slice(0, offset % (all.length || 1))];
      const ready = ordered.filter(a => (due.get(key(a)) || 0) <= clock());
      if (ready.length) offset++;
      async function worker() {
        while (ready.length && !abort.signal.aborted) {
          const pair = ready.shift(); const k = key(pair); lastStart.set(k, clock()); due.set(k, clock() + intervalMs);
          try { await engine.syncAccount({ ownerId: pair.ownerId, accountId: pair.accountId, signal: abort.signal }); } catch { /* Retry in a later fair cycle; never log provider errors. */ }
        }
      }
      await Promise.all([worker(), worker()]);
    })().finally(() => { ticking = null; });
    return ticking;
  }
  return { tick, wake(pair) { const k = key(pair); due.set(k, Math.max(clock(), (lastStart.get(k) || 0) + 5000)); }, start() { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, 1000); timer.unref(); tick().catch(() => {}); } }, async close() { clearInterval(timer); abort.abort(); await ticking; } };
}
