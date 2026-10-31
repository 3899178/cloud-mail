import { createUploads } from '../routes/uploads.mjs';
import { createWorkLimits } from '../core/limits.mjs';
import { createOAuth } from '../providers/oauth.mjs';
import { createProviderRegistry } from '../providers/registry.mjs';
import { createSyncEngine } from './engine.mjs';
import { createScheduler } from './scheduler.mjs';
import { createActions } from '../send/actions.mjs';
import { createAccountLifecycle } from '../core/lifecycle.mjs';
import { createDownloads } from '../routes/downloads.mjs';
import { createProton, createProtonTransport } from '../providers/proton.mjs';
export function createMailService({ store, clock = Date.now, clients, registry: suppliedRegistry, adapters, proton: protonOptions = {}, limits = createWorkLimits() }) {
  const lifecycle = createAccountLifecycle({ store });
  const oauth = createOAuth({ store, clock, clients, lifecycle }); let scheduler;
  const proton = createProton({ store, clock, lifecycle, transport: protonOptions.transport || createProtonTransport({ socketPath: protonOptions.socketPath || '/run/cloud-mail-proton/helper.sock' }) });
  const registry = suppliedRegistry || createProviderRegistry({ store, oauth, adapters: { proton: proton.adapter, ...adapters }, onChange: pair => scheduler?.wake(pair) });
  const uploads = createUploads({store,lifecycle,clock});
  const engine = createSyncEngine({ store, registry, limits, lifecycle }); const actions = createActions({ store, registry, limits, lifecycle, uploads });
  const downloads = createDownloads({ store, lifecycle });
  scheduler = createScheduler({ store, engine, clock });
  return { uploads, oauth, proton, registry, engine, actions, scheduler, limits, lifecycle, downloads, start() { scheduler.start(); }, async close() { await lifecycle.close(); await uploads.close(); await actions.close(); await scheduler.close(); await registry.close?.(); } };
}
