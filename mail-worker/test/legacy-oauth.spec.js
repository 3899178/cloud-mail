import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import app from '../src/hono/webs';
import { env, fixture } from './fixture';
import Kv from '../src/const/kv-const';

const origin = 'https://mail.example.test';
const providers = [
 { route: 'google', platform: 'google', switch: 'googleSwitch', tokenOrigin: 'https://oauth2.googleapis.com', tokenPath: '/token', profileOrigin: 'https://openidconnect.googleapis.com', profilePath: '/v1/userinfo', id: 'google-subject', profile: { sub: 'google-subject', email: 'identity@example.test', email_verified: true, name: 'Synthetic Google', picture: 'https://images.example.test/google.png' } },
 { route: 'github', platform: 'github', switch: 'githubSwitch', tokenOrigin: 'https://github.com', tokenPath: '/login/oauth/access_token', profileOrigin: 'https://api.github.com', profilePath: '/user', id: '42', profile: { id: 42, login: 'synthetic-github', name: 'Synthetic GitHub', avatar_url: 'https://images.example.test/github.png' } },
 { route: 'linuxDo', platform: 'linuxdo', switch: 'linuxdoSwitch', tokenOrigin: 'https://connect.linux.do', tokenPath: '/oauth2/token', profileOrigin: 'https://connect.linux.do', profilePath: '/api/user', id: '42', profile: { id: 42, username: 'synthetic-linuxdo', name: 'Synthetic LinuxDo', active: true, silenced: false, trust_level: 1, avatar_url: 'https://images.example.test/linuxdo.png' } },
];

const request = (path, body, requestOrigin = origin) => app.request(origin + path, {
 method: 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}, env);

async function enable(provider) {
 const settings = JSON.parse(await env.kv.get(Kv.SETTING));
 settings[provider.switch] = 0;
 await env.kv.put(Kv.SETTING, JSON.stringify(settings));
}

// Only the external provider's token/profile responses are synthetic. Route,
// session creation, profile persistence, invitations and D1/KV remain real.
function exchange(provider) {
 fetchMock.get(provider.tokenOrigin).intercept({ method: 'POST', path: provider.tokenPath }).reply(200, { access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3600 }, { headers: { 'content-type': 'application/json' } });
 fetchMock.get(provider.profileOrigin).intercept({ method: 'GET', path: provider.profilePath }).reply(200, provider.profile, { headers: { 'content-type': 'application/json' } });
}

describe('retained third-party website login', () => {
 beforeEach(async () => { await fixture(); fetchMock.activate(); fetchMock.disableNetConnect(); });
 afterEach(() => { fetchMock.deactivate(); });

 for (const provider of providers) {
  it(`${provider.route} logs into the already bound local user without creating another account`, async () => {
   await enable(provider);
   const otherPlatform = provider.platform === 'github' ? 'linuxdo' : 'github';
   await env.db.prepare('INSERT INTO oauth(oauth_user_id,user_id,platform) VALUES(?,1,?)').bind(provider.id, otherPlatform).run();
   await env.db.prepare('INSERT INTO oauth(oauth_user_id,user_id,platform) VALUES(?,2,?)').bind(provider.id, provider.platform).run();
   exchange(provider);
   const response = await request(`/oauth/${provider.route}/login`, { code: 'synthetic-code', redirectUri: origin + '/oauth' });
   const result = await response.json();
   expect(result.code).toBe(200);
   expect(result.data.userInfo).toMatchObject({ platform: provider.platform, oauthUserId: provider.id, userId: 2 });
   expect(result.data.token).toBeTruthy();
   const session = await app.request(origin + '/session', { headers: { Authorization: `Bearer ${result.data.token}` } }, env);
   expect(session.status).toBe(200);
   expect((await session.json()).data.userId).toBe(2);
   expect((await env.db.prepare('SELECT COUNT(*) AS n FROM user').first()).n).toBe(2);
   expect((await env.db.prepare('SELECT COUNT(*) AS n FROM oauth').first()).n).toBe(2);
   expect((await env.db.prepare('SELECT user_id FROM oauth WHERE platform=?').bind(otherPlatform).first()).user_id).toBe(1);
   fetchMock.assertNoPendingInterceptors();
  });

  it(`${provider.route} leaves a new provider identity unbound and requires an invitation`, async () => {
   await enable(provider); exchange(provider);
   const response = await request(`/oauth/${provider.route}/login`, { code: 'synthetic-code', redirectUri: origin + '/oauth' });
   const result = await response.json();
   expect(result.code).toBe(200);
   expect(result.data.token).toBeNull();
   expect(result.data.bindingProof).toBeTruthy();
   expect(result.data.userInfo).toMatchObject({ platform: provider.platform, userId: 0 });
   const bind = await app.request(origin + '/oauth/bindUser', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new-local@example.test', oauthUserId: provider.id, bindingProof: result.data.bindingProof }) }, env);
   expect((await bind.json()).code).not.toBe(200);
   expect((await env.db.prepare('SELECT COUNT(*) AS n FROM user').first()).n).toBe(2);
   expect(await env.db.prepare("SELECT user_id FROM user WHERE email='new-local@example.test'").first()).toBeNull();
   expect((await env.db.prepare('SELECT user_id FROM oauth').first()).user_id).toBe(0);
   // The same proof must work with a valid invitation. Otherwise an invalid
   // proof or a broken bind route could make the rejection above a false pass.
   await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('login-control-invite',1,1,'2099-01-01 00:00:00')").run();
   const accepted = await app.request(origin + '/oauth/bindUser', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'new-local@example.test', oauthUserId: provider.id, bindingProof: result.data.bindingProof, code: 'login-control-invite' }) }, env);
   const admitted = await accepted.json();
   expect(admitted.code).toBe(200);
   const created = await env.db.prepare("SELECT user_id,type FROM user WHERE email='new-local@example.test'").first();
   expect(created).toMatchObject({ type: 1 });
   expect((await env.db.prepare('SELECT COUNT(*) AS n FROM user').first()).n).toBe(3);
   expect((await env.db.prepare('SELECT user_id FROM oauth').first()).user_id).toBe(created.user_id);
   expect((await env.db.prepare("SELECT count FROM reg_key WHERE code='login-control-invite'").first()).count).toBe(0);
   const session = await app.request(origin + '/session', { headers: { Authorization: `Bearer ${admitted.data.token}` } }, env);
   expect(session.status).toBe(200);
   expect((await session.json()).data.userId).toBe(created.user_id);
   fetchMock.assertNoPendingInterceptors();
  });

  it(`${provider.route} rejects a cross-origin login before creating a provider identity`, async () => {
   await enable(provider);
   const response = await request(`/oauth/${provider.route}/login`, { code: 'synthetic-code' }, 'https://untrusted.example.test');
   expect((await response.json()).error.code).toBe('CSRF_REJECTED');
   expect((await env.db.prepare('SELECT COUNT(*) AS n FROM oauth').first()).n).toBe(0);
  });
 }
});
