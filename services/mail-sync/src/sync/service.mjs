import { createWorkLimits } from '../core/limits.mjs';
import { createOAuth } from '../providers/oauth.mjs';
import { createProviderRegistry } from '../providers/registry.mjs';
import { createSyncEngine } from './engine.mjs';
import { createScheduler } from './scheduler.mjs';
import { createActions } from '../send/actions.mjs';
export function createMailService({ store, clock = Date.now, clients, registry: suppliedRegistry, adapters, limits = createWorkLimits() }) {
  const oauth = createOAuth({ store, clock, clients }); let scheduler;
  const registry = suppliedRegistry || createProviderRegistry({ store, oauth, adapters, onChange: pair => scheduler?.wake(pair) });
  const engine = createSyncEngine({ store, registry, limits }); const actions = createActions({ store, registry, limits });
  scheduler = createScheduler({ store, engine, clock });
  return { oauth, registry, engine, actions, scheduler, limits, start() { scheduler.start(); }, async close() { await actions.close(); await scheduler.close(); await registry.close?.(); } };
}
