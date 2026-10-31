import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import axios from 'axios';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createSession } from '../src/auth/session-core.mjs';
import { createOwnerSession } from '../src/auth/owner-session.mjs';
import { installSessionFence } from '../src/auth/http-session.mjs';

let vite, useEmailStore, useUserStore;
before(async () => {
  vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, entries: [] },
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true },
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    plugins: [{
      name: 'isolated-request-session', enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('/request/my.js')) return '\0fixture-current-user';
        if (id.endsWith('/auth/session.js')) return '\0fixture-session';
      },
      load(id) {
        if (id === '\0fixture-current-user') return "export const loginUserInfo = () => globalThis.mailRaceFixture.http.get('/my/loginUserInfo');";
        if (id === '\0fixture-session') return 'export const session = new Proxy({}, {get(_target,key) { const session=globalThis.mailRaceFixture.session; const value=session[key]; return typeof value === "function" ? value.bind(session) : value; }});';
      }
    }]
  });
});
after(async () => { await vite?.close(); delete globalThis.mailRaceFixture; });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const user = name => ({ email: name + '@example.test', account: { accountId: name }, permKeys: [name] });
function session(fetcher = async () => ({ ok: true, json: async () => ({ code: 200, data: { csrfToken: 'csrf-B' } }) })) {
  return createSession({ storage: { getItem: () => null, removeItem() {} }, fetcher, base: '/api' });
}
async function fixture() {
  const state = session(), requests = [];
  const http = axios.create({ adapter: async config => {
    const wait = deferred(); requests.push({ config, ...wait });
    try {
      const data = await wait.promise;
      return { data, config, status: 200, headers: {} };
    } catch (error) { error.config = config; throw error; }
  } });
  installSessionFence(http, state);
  http.interceptors.response.use(response => response.data);
  globalThis.mailRaceFixture = { http, session: state };
  // Execute the real store modules and their Pinia actions; only network/session instances are injected.
  ({ useEmailStore } = await vite.ssrLoadModule('/src/store/email.js'));
  ({ useUserStore } = await vite.ssrLoadModule('/src/store/user.js'));
  setActivePinia(createPinia());
  const email = useEmailStore(), users = useUserStore();
  const account = { $reset() { this.currentAccountId = null; }, currentAccount: {} };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', name: 'layout', component: {} }] });
  const owner = createOwnerSession({ session: state, router, userStore: users, accountStore: account,
    caches: [email], routesFor: keys => keys.map(name => ({ path: '/' + name, name, component: {} })) });
  return { state, requests, http, email, users, owner, router };
}

test('delayed old-owner full body and current-user refresh cannot repopulate real Pinia stores', async () => {
  const f = await fixture();
  await f.owner.load(async () => user('A'));
  const first = f.email.fetchList(full => f.http.get(full ? '/full' : '/summary'));
  await tick(); f.requests[0].resolve([]); await first; await tick();
  const refreshed = f.users.refreshUserInfo(); await tick();
  f.state.reset(); await f.owner.load(async () => user('B'));
  f.requests[1].resolve([{ emailId: 100, text: 'OWNER_A_PRIVATE_BODY' }]);
  f.requests[2].resolve(user('A'));
  await refreshed; await tick(); await tick();
  assert.equal(f.users.user.email, 'B@example.test');
  assert.equal(f.email.detailMap[100], undefined);
  assert.equal(f.router.hasRoute('A'), false);
  assert.equal(f.router.hasRoute('B'), true);
});

test('old HTTP 401 after a new login is stale before downstream authentication handlers', async () => {
  const f = await fixture();
  let resets = 0;
  f.http.interceptors.response.use(undefined, error => {
    if (error.response?.status === 401) { resets++; f.state.reset(); }
    throw error;
  });
  const old = f.http.get('/old-request').catch(error => error);
  await tick(); await f.state.adopt('B'); await f.owner.load(async () => user('B'));
  f.requests[0].reject(Object.assign(new Error('old unauthorized'), { response: { status: 401 } }));
  assert.equal((await old).code, 'STALE_SESSION');
  assert.equal(resets, 0);
  assert.equal(f.state.authenticated, true);
  assert.equal(f.users.user.email, 'B@example.test');
});

test('old owner load success or failure never overrides or resets a newer owner', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(), old = deferred();
    const loading = f.owner.load(() => old.promise).catch(error => error);
    await f.owner.load(async () => user('B'));
    if (fail) old.reject(new Error('old 401')); else old.resolve(user('A'));
    await loading;
    assert.equal(f.users.user.email, 'B@example.test');
    assert.equal(f.router.hasRoute('B'), true);
  }
});

test('old bootstrap and exchange results cannot overwrite current session or remove a newer legacy token', async () => {
  for (const method of ['bootstrap', 'adopt']) {
    const old = deferred(); let stored = method === 'adopt' ? 'legacy-A' : null;
    const state = createSession({ storage: { getItem: () => stored, removeItem() { stored = null; } }, base: '/api',
      fetcher: async (_url, options) => options?.headers?.Authorization === 'B'
        ? { ok: true, json: async () => ({ code: 200, data: { csrfToken: 'csrf-B' } }) }
        : old.promise });
    const pending = (method === 'bootstrap' ? state.bootstrap() : state.adopt('A')).catch(error => error);
    state.reset(); await state.adopt('B'); stored = 'newer-legacy-value';
    old.resolve({ ok: true, json: async () => ({ code: 200, data: { csrfToken: 'csrf-A' } }) });
    await pending;
    assert.equal(state.csrfToken, 'csrf-B');
    assert.equal(stored, 'newer-legacy-value');
  }
});
