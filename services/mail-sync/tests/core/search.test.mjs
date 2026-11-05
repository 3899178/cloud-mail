import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, ingest, mail, owner } from './helpers.mjs';
import { createSyncApp } from '../../src/app.mjs';
import { signGatewayAssertion } from '../../../../shared/unified-mail/index.mjs';

test('searches subjects, senders and stored text/HTML bodies before paging, with owner/account isolation', async t => {
  const { store } = await fixture(t);
  account(store); account(store, owner, 'acc-2'); account(store, 'other');
  ingest(store, owner, 'acc-1', [
    { ...mail('subject'), subject: 'Receipt 学费', text: 'ordinary', html: '' },
    { ...mail('sender'), from: '学费办公室 <billing@test>', text: 'ordinary', html: '' },
    { ...mail('body'), subject: 'Other', text: '请查收学费收据', html: '' },
    { ...mail('html'), subject: 'Other', text: '', html: '<p>学费到账</p>' },
    { ...mail('unrelated'), subject: 'Nothing', text: 'ordinary', html: '' }
  ]);
  ingest(store, owner, 'acc-2', [{ ...mail('alias'), subject: '学费', text: '', html: '' }]);
  ingest(store, 'other', 'acc-1', [{ ...mail('private'), subject: '学费', text: '', html: '' }]);
  const find = (searchField = 'all', accountId = 'acc-1') => store.messages.list(owner, { search: ' 学费 ', searchField, accountId }).items;
  assert.equal(find().length, 4);
  assert.equal(find('subject').length, 1);
  assert.equal(find('sender').length, 1);
  assert.equal(find('body').length, 2);
  assert.equal(store.messages.list(owner, { search: '学费' }).items.length, 5);
  assert.equal(find('all', 'acc-2').length, 1);
  assert.throws(() => find('all', 'missing'), { code: 'NOT_FOUND' });
});

test('literal metacharacters and quoted SQL stay data, with ASCII case-insensitive and Chinese matching', async t => {
  const { store } = await fixture(t); account(store);
  ingest(store, owner, 'acc-1', [
    { ...mail('literal'), subject: 'Invoice 10%_! 中文', text: '', html: '' },
    { ...mail('wildcard'), subject: 'Invoice 10000 中文', text: '', html: '' },
    { ...mail('quote'), subject: "x' OR 1=1 --", text: '', html: '' }
  ]);
  assert.equal(store.messages.list(owner, { search: '10%_!', searchField: 'subject' }).items.length, 1);
  assert.equal(store.messages.list(owner, { search: "' OR 1=1 --" }).items.length, 1);
  assert.equal(store.messages.list(owner, { search: 'invoice' }).items.length, 2);
  assert.equal(store.messages.list(owner, { search: '中文' }).items.length, 2);
  assert.equal(store.messages.list(owner, { search: ' ' }).items.length, 3);
});

test('finds older matches beyond the initial page and paginates ties without duplicates', async t => {
  const { store } = await fixture(t); account(store);
  ingest(store, owner, 'acc-1', Array.from({ length: 60 }, (_, i) => ({ ...mail('new-' + i, 2000), subject: 'unrelated', text: '', html: '' })));
  ingest(store, owner, 'acc-1', Array.from({ length: 7 }, (_, i) => ({ ...mail('old-' + i, 1000), subject: 'needle', text: '', html: '' })));
  const found = []; let cursor;
  do {
    const page = store.messages.list(owner, { search: 'needle', searchField: 'subject', limit: 2, cursor });
    found.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(found.length, 7);
  assert.equal(new Set(found.map(m => m.ref)).size, 7);
  assert.deepEqual(found.map(m => m.ref), found.map(m => m.ref).sort().reverse());
  assert.ok(found.every(m => m.subject === 'needle' && !('text' in m)));
});

test('rejects oversized/control search strings and unknown fields instead of silently returning unfiltered mail', async t => {
  const { store } = await fixture(t); account(store); ingest(store);
  for (const search of ['x'.repeat(201), 'line\nbreak', '\0', 12, null]) {
    assert.throws(() => store.messages.list(owner, { search }), { code: 'INVALID_INPUT' });
  }
  for (const searchField of ['subject) OR 1=1', 'unknown', null]) {
    assert.throws(() => store.messages.list(owner, { search: 'hello', searchField }), { code: 'INVALID_INPUT' });
  }
});

test('authenticated message API passes search through and keeps results inside assertion owner', async t => {
  const { store, options } = await fixture(t); account(store); account(store, 'other');
  ingest(store, owner, 'acc-1', [{ ...mail('yes'), subject: 'needle' }, { ...mail('no'), subject: 'unrelated' }]);
  ingest(store, 'other', 'acc-1', [{ ...mail('private'), subject: 'needle' }]);
  const key = new Uint8Array(32).fill(19), app = createSyncApp({ store, gatewayKey: key, clock: options.clock });
  const path = '/v1/messages?search=needle&searchField=subject';
  const token = await signGatewayAssertion({ key, ownerId: owner, method: 'GET', path, now: options.clock() });
  const r = await app.request(path, { headers: { 'x-gateway-assertion': token } });
  assert.equal(r.status, 200);
  const data = await r.json(); assert.equal(data.items.length, 1); assert.equal(data.items[0].subject, 'needle');
});
