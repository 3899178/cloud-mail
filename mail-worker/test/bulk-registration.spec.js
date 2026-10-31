import { beforeEach, it, expect } from 'vitest';
import app from '../src/hono/webs';
import { fixture, env } from './fixture';
import Kv from '../src/const/kv-const';

const origin = 'https://mail.example.test';
const row = (name, code = 'bulk-invite') => ({ email: name + '@example.test', password: 'password', code });
const bulk = (list, bindings = env) => app.request(origin + '/public/addUser', {
  method: 'POST', headers: { Authorization: 'automation' }, body: JSON.stringify({ list })
}, bindings);

// Count binding invocations, not SQL statements inside a batch. All work still runs on real D1.
function countedD1(db) {
  let invocations = 0, maxBindings = 0;
  const originals = new WeakMap();
  function statement(target) {
    const wrapped = new Proxy(target, {
      get(target, key) {
        if (key === 'bind') return (...args) => {
          maxBindings = Math.max(maxBindings, args.length);
          return statement(target.bind(...args));
        };
        if (['first', 'all', 'run', 'raw'].includes(key)) return (...args) => {
          invocations++;
          return target[key](...args);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    originals.set(wrapped, target);
    return wrapped;
  }
  return {
    get invocations() { return invocations; },
    get maxBindings() { return maxBindings; },
    binding: new Proxy(db, {
      get(target, key) {
        if (key === 'prepare') return query => statement(target.prepare(query));
        if (key === 'batch') return queries => {
          invocations++;
          return target.batch(queries.map(query => originals.get(query) || query));
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    })
  };
}
async function snapshot() {
  return {
    users: (await env.db.prepare("SELECT count(*) AS n FROM user WHERE email LIKE 'bulk%@example.test'").first()).n,
    accounts: (await env.db.prepare("SELECT count(*) AS n FROM account WHERE email LIKE 'bulk%@example.test'").first()).n,
    remaining: (await env.db.prepare("SELECT count FROM reg_key WHERE code='bulk-invite'").first()).count
  };
}
beforeEach(async () => {
  await fixture(); await env.kv.put(Kv.PUBLIC_KEY, 'automation');
  await env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES('bulk-invite',3,1,'2099-01-01 00:00:00'),('expired',1,1,'2000-01-01 00:00:00'),('exhausted',0,1,'2099-01-01 00:00:00')").run();
});

for (const invalid of ['wrong', 'expired', 'exhausted', 'duplicate-existing', 'duplicate-list', 'account-failure']) {
  it('whole public bulk rolls back first valid row when second row is ' + invalid, async () => {
    const first = row('bulkfirst');
    let second = row('bulksecond', invalid);
    if (invalid === 'duplicate-existing') second = row('u1');
    if (invalid === 'duplicate-list') second = row('BULKFIRST');
    if (invalid === 'account-failure') {
      second = row('bulksecond');
      await env.db.exec("CREATE TRIGGER reject_bulk_account BEFORE INSERT ON account WHEN NEW.email='bulksecond@example.test' BEGIN SELECT RAISE(ABORT,'isolated account failure'); END;");
    }
    const response = await bulk([first, second]);
    expect(response.status).toBe(200); expect((await response.json()).code).not.toBe(200);
    expect(await snapshot()).toEqual({ users: 0, accounts: 0, remaining: 3 });
  });
}

it('whole public bulk rejects repeated invite overuse without admitting its first row', async () => {
  await env.db.prepare("UPDATE reg_key SET count=1 WHERE code='bulk-invite'").run();
  expect((await (await bulk([row('bulkfirst'), row('bulksecond')])).json()).code).not.toBe(200);
  expect(await snapshot()).toEqual({ users: 0, accounts: 0, remaining: 1 });
});

it('successful repeated-invite bulk creates exactly the full list and consumes exactly two uses', async () => {
  expect((await (await bulk([row('bulkfirst'), row('bulksecond')])).json()).code).toBe(200);
  expect(await snapshot()).toEqual({ users: 2, accounts: 2, remaining: 1 });
  const rows = await env.db.prepare("SELECT u.user_id,a.user_id AS owner FROM user u JOIN account a ON a.email=u.email WHERE u.email LIKE 'bulk%@example.test'").all();
  expect(rows.results.every(row => row.user_id === row.owner)).toBe(true);
});

it('case-varied invitation codes share the authoritative invite count and leave no guard rows', async () => {
  await env.db.prepare("UPDATE reg_key SET count=1 WHERE code='bulk-invite'").run();
  expect((await (await bulk([row('bulkfirst'), row('bulksecond', 'BULK-INVITE')])).json()).code).not.toBe(200);
  expect(await snapshot()).toEqual({ users: 0, accounts: 0, remaining: 1 });
  await env.db.prepare("UPDATE reg_key SET count=2 WHERE code='bulk-invite'").run();
  expect((await (await bulk([row('bulkfirst'), row('bulksecond', 'BULK-INVITE')])).json()).code).toBe(200);
  expect(await snapshot()).toEqual({ users: 2, accounts: 2, remaining: 0 });
  expect((await env.db.prepare('SELECT count(*) AS n FROM registration_admission_guard').first()).n).toBe(0);
});

it('missing operator migration rejects bulk honestly without creating the schema or any user', async () => {
  await env.db.exec('DROP TABLE registration_admission_guard;');
  const response = await bulk([row('bulkfirst')]);
  expect(response.status).toBe(200);
  expect((await response.json()).error.code).toBe('REGISTRATION_NOT_READY');
  expect(await snapshot()).toEqual({ users: 0, accounts: 0, remaining: 3 });
  expect(await env.db.prepare("SELECT name FROM sqlite_master WHERE name='registration_admission_guard'").first()).toBeNull();
});

it('keeps the legacy 100-row bound with bounded statement bindings and rejects 101 rows without writes', async () => {
  const list = Array.from({ length: 100 }, (_, index) => row('bulk' + index));
  expect((await (await bulk([...list, row('bulkextra')])).json()).code).not.toBe(200);
  expect(await snapshot()).toEqual({ users: 0, accounts: 0, remaining: 3 });
  await env.db.prepare("UPDATE reg_key SET count=100 WHERE code='bulk-invite'").run();
  expect((await (await bulk(list)).json()).code).toBe(200);
  expect(await snapshot()).toEqual({ users: 100, accounts: 100, remaining: 0 });
}, 30000);

it('fits the D1 Free request budget for 100 distinct role names and invitation codes', async () => {
  const list = Array.from({ length: 100 }, (_, index) => ({
    ...row('bulk' + index, 'BULK-INVITE-' + index), roleName: 'bulk-role-' + index
  }));
  await env.db.batch(list.flatMap((entry, index) => [
    env.db.prepare("INSERT INTO role(role_id,name,key,avail_domain) VALUES(?,?,?,'example.test')")
      .bind(101 + index, entry.roleName, entry.roleName),
    env.db.prepare("INSERT INTO reg_key(code,count,role_id,expire_time) VALUES(?,1,1,'2099-01-01 00:00:00')")
      .bind('bulk-invite-' + index)
  ]));
  const measured = countedD1(env.db);
  const response = await bulk(list, { ...env, db: measured.binding });
  expect((await response.json()).code).toBe(200);
  console.info('D1_ENDPOINT_INVOCATIONS=' + measured.invocations);
  expect(measured.invocations).toBeLessThanOrEqual(50);
  expect(measured.maxBindings).toBeLessThanOrEqual(100);
  const users = await env.db.prepare("SELECT u.type,r.name FROM user u JOIN role r ON r.role_id=u.type WHERE u.email LIKE 'bulk%@example.test'").all();
  expect(users.results).toHaveLength(100);
  expect(users.results.every(entry => entry.type >= 101 && entry.name === 'bulk-role-' + (entry.type - 101))).toBe(true);
  expect((await env.db.prepare("SELECT count(*) AS n FROM account WHERE email LIKE 'bulk%@example.test'").first()).n).toBe(100);
  expect((await env.db.prepare("SELECT sum(count) AS n FROM reg_key WHERE code LIKE 'bulk-invite-%'").first()).n).toBe(0);
}, 30000);

it('preloaded zero-role invites retain default-role fallback and ignore unknown public role names', async () => {
  await env.db.prepare("UPDATE reg_key SET role_id=0 WHERE code='bulk-invite'").run();
  const list = [row('bulkfirst'), { ...row('bulksecond'), roleName: 'unknown-role', type: 999 }];
  expect((await (await bulk(list)).json()).code).toBe(200);
  expect(await snapshot()).toEqual({ users: 2, accounts: 2, remaining: 1 });
  const users = await env.db.prepare("SELECT type FROM user WHERE email LIKE 'bulk%@example.test'").all();
  expect(users.results.map(user => user.type)).toEqual([1, 1]);
});

it('preloaded account lookups reject a case-varied deleted account without committing the first valid row', async () => {
  await env.db.prepare('UPDATE account SET is_del=1 WHERE account_id=2').run();
  expect((await (await bulk([row('bulkfirst'), row('U2')])).json()).code).not.toBe(200);
  expect(await snapshot()).toEqual({ users: 0, accounts: 0, remaining: 3 });
});

it('concurrent two-row bulk and another registration never commit a partial bulk or overuse an invite', async () => {
  await env.db.prepare("UPDATE reg_key SET count=2 WHERE code='bulk-invite'").run();
  const [batchResponse, singleResponse] = await Promise.all([
    bulk([row('bulkfirst'), row('bulksecond')]),
    app.request(origin + '/register', { method: 'POST', body: JSON.stringify(row('single-racer')) }, env)
  ]);
  const batch = await batchResponse.json(), single = await singleResponse.json();
  const state = await snapshot();
  expect(state.users).toBe(batch.code === 200 ? 2 : 0); expect(state.accounts).toBe(state.users);
  const singleCount = (await env.db.prepare("SELECT count(*) AS n FROM user WHERE email='single-racer@example.test'").first()).n;
  expect(singleCount).toBe(single.code === 200 ? 1 : 0);
  expect(state.remaining).toBe(2 - state.users - singleCount);
  expect(state.remaining).toBeGreaterThanOrEqual(0);
});
