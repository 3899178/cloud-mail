import { fail } from '../../../../shared/unified-mail/index.mjs';
import { createImapSession, mailConfig } from './imap.mjs';

export function createProviderRegistry({ store, oauth, adapters = {}, onChange = () => {}, sessionFactory = createImapSession }) {
  const sessions = new Map(); const tails = new Map();
  async function invalidate(ownerId, accountId) {
    const key = JSON.stringify([ownerId, accountId]); const existing = sessions.get(key); sessions.delete(key); await existing?.close();
  }
  return {
    async open({ ownerId, account, signal }) {
      const key = JSON.stringify([ownerId, account.id]);
      const previous = tails.get(key) || Promise.resolve(); let release;
      const gate = new Promise(resolve => { release = resolve; }); tails.set(key, gate);
      await previous;
      let session;
      try {
        signal?.throwIfAborted();
        session = sessions.get(key);
        if (!session || !session.usable?.()) {
          await invalidate(ownerId, account.id);
          if (adapters[account.provider]) session = await adapters[account.provider]({ ownerId, account, signal });
          else {
            if (account.provider === 'proton') fail('PROVIDER_UNAVAILABLE');
            let stored; try { stored = JSON.parse(store.credentials.get(ownerId, account.id, 'protocol')); } catch { fail('AUTH_REQUIRED'); }
            const auth = stored.authType === 'oauth' ? () => oauth.auth(ownerId, account.id) : async () => ({ user: stored.user || account.address, pass: stored.password });
            session = await sessionFactory({ account, config: mailConfig(account.provider, stored.config), auth, signal, onChange: () => onChange({ ownerId, accountId: account.id }) });
          }
          sessions.set(key, session);
        }
        session.acquire?.();
        signal?.throwIfAborted();
      } catch (error) { release(); if (tails.get(key) === gate) tails.delete(key); throw error; }
      const abort = () => { invalidate(ownerId, account.id).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      let closed = false;
      return { ...session, async close() {
        if (closed) return; closed = true;
        signal?.removeEventListener('abort', abort);
        try { await session.idle?.(); } catch { await invalidate(ownerId, account.id); }
        finally { release(); if (tails.get(key) === gate) tails.delete(key); }
      } };
    },
    invalidate,
    async close() { await Promise.all([...sessions.values()].map(s => s.close())); sessions.clear(); },
  };
}
