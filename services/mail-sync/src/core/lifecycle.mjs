import { AsyncLocalStorage } from 'node:async_hooks';
import { fail } from '../../../../shared/unified-mail/index.mjs';

// One process-local barrier is shared by every service subsystem. Nested provider OAuth
// refreshes inherit the account lease; a transition never waits on its own nested task.
export function createAccountLifecycle({ store }) {
  const states = new Map(); const context = new AsyncLocalStorage();
  const key = (who, id) => JSON.stringify([who, id]);
  function state(who, id) {
    const k = key(who, id); if (!states.has(k)) states.set(k, { generation: 0, blocked: false, active: new Set() });
    return states.get(k);
  }
  function enter(who, id, { signal, allowPaused = false } = {}) {
    const account = store.accounts.get(who, id); const s = state(who, id);
    if (s.blocked) fail('BUSY'); if (!allowPaused && account.status === 'paused') fail('INVALID_TRANSITION');
    const generation = s.generation; const controller = new AbortController(); let release;
    const entry = { controller, done: new Promise(resolve => { release = resolve; }) }; s.active.add(entry);
    const lease = {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      current: () => !s.blocked && s.generation === generation,
      check() { if (!this.current()) fail('BUSY'); this.signal.throwIfAborted(); },
      release() { if (s.active.delete(entry)) release(); },
    };
    return lease;
  }
  return {
    enter,
    run(who, id, task, options) {
      const k = key(who, id); const inherited = context.getStore()?.get(k);
      if (inherited) { inherited.check(); return Promise.resolve(task(inherited)); }
      const lease = enter(who, id, options); const nested = new Map(context.getStore() || []); nested.set(k, lease);
      return context.run(nested, async () => { try { lease.check(); return await task(lease); } finally { lease.release(); } });
    },
    transition(who, id, { begin = () => {}, commit }) {
      store.accounts.get(who, id); const s = state(who, id); if (s.blocked) fail('BUSY');
      s.blocked = true; s.generation++;
      let began;
      try { began = begin(); } catch (error) { s.blocked = false; throw error; }
      const active = [...s.active]; for (const entry of active) entry.controller.abort();
      return (async () => {
        try { await Promise.all(active.map(entry => entry.done)); return await commit(began); }
        finally { s.blocked = false; }
      })();
    },
    async close() {
      const active = []; for (const s of states.values()) { s.blocked = true; s.generation++; for (const entry of s.active) { active.push(entry); entry.controller.abort(); } }
      await Promise.all(active.map(entry => entry.done));
    },
  };
}
