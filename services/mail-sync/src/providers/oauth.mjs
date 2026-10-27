import { createHash, randomBytes } from 'node:crypto';
import { fail } from '../../../../shared/unified-mail/index.mjs';
import { text } from '../core/validation.mjs';

const providers = {
  gmail: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', scope: 'https://mail.google.com/' },
  outlook: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send' },
};
async function boundedJson(response) {
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 32768) fail('AUTH_REQUIRED'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('AUTH_REQUIRED'); }
}
export function createOAuth({ store, clients = {}, clock = Date.now, fetcher = fetch }) {
  const refreshing = new Map();
  function config(provider) {
    const client = clients[provider]; const p = providers[provider];
    if (!client || !p) fail('AUTH_REQUIRED');
    text(client.clientId, 1024); text(client.clientSecret, 8192);
    let redirect; try { redirect = new URL(client.redirectUri); } catch { fail('INVALID_INPUT'); }
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash) fail('INVALID_INPUT');
    return { ...p, ...client };
  }
  async function exchange(provider, parameters, previous = {}) {
    const c = config(provider);
    const response = await fetcher(c.token, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...parameters }).toString() });
    const data = await boundedJson(response);
    if (!response.ok || data.error) fail('AUTH_REQUIRED');
    text(data.access_token, 8192);
    if (!Number.isInteger(data.expires_in) || data.expires_in <= 0 || data.expires_in > 86400) fail('AUTH_REQUIRED');
    const refreshToken = data.refresh_token || previous.refreshToken;
    text(refreshToken, 8192);
    return { accessToken: data.access_token, refreshToken, expiresAt: clock() + data.expires_in * 1000 };
  }
  return {
    async start(ownerId, accountId) {
      const account = store.accounts.get(ownerId, accountId); const c = config(account.provider);
      const verifier = randomBytes(32).toString('base64url');
      const state = store.oauthStates.create(ownerId, accountId, { verifier, provider: account.provider, redirectUri: c.redirectUri });
      const url = new URL(c.authorize);
      url.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: c.scope, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(account.provider === 'gmail' ? { access_type: 'offline', prompt: 'consent' } : {}) }).toString();
      return { authorizationUrl: url.href, expiresIn: 600 };
    },
    resolve(state) { const identity = store.oauthStates.resolve(state); return { ...identity, provider: store.accounts.get(identity.ownerId, identity.accountId).provider }; },
    async complete(ownerId, { state, code }) {
      text(code, 8192);
      const { accountId, value } = store.oauthStates.consume(ownerId, state);
      if (store.accounts.get(ownerId, accountId).provider !== value.provider) fail('UNAUTHORIZED');
      const token = await exchange(value.provider, { grant_type: 'authorization_code', code, code_verifier: value.verifier, redirect_uri: value.redirectUri });
      store.credentials.set(ownerId, accountId, 'oauth', JSON.stringify(token));
      return { accountId };
    },
    async auth(ownerId, accountId) {
      const account = store.accounts.get(ownerId, accountId);
      const key = JSON.stringify([ownerId, accountId]);
      if (refreshing.has(key)) return refreshing.get(key);
      const task = (async () => {
        let token; try { token = JSON.parse(store.credentials.get(ownerId, accountId, 'oauth')); } catch { fail('AUTH_REQUIRED'); }
        if (token.expiresAt <= clock() + 60000) {
          token = await exchange(account.provider, { grant_type: 'refresh_token', refresh_token: token.refreshToken }, token);
          store.credentials.set(ownerId, accountId, 'oauth', JSON.stringify(token));
        }
        return { type: 'OAuth2', user: account.address, accessToken: token.accessToken };
      })().finally(() => refreshing.delete(key));
      refreshing.set(key, task); return task;
    },
  };
}
