import { beforeEach, describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import app from '../src/hono/webs';
import render from '../src/template/email-html';
import { env, fixture } from './fixture';
import jwt from '../src/utils/jwt-utils';

function isolatedDocument(output) {
 const { document } = parseHTML(output);
 expect(document.querySelectorAll('iframe')).toHaveLength(1);
 expect(document.querySelectorAll('script,img,form,object,embed,svg')).toHaveLength(0);
 const frame = document.querySelector('iframe');
 expect(frame.getAttribute('sandbox')?.split(/\s+/).sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
 expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
 return parseHTML(frame.getAttribute('srcdoc')).document;
}

describe('HTML notification containment', () => {
 it('keeps formatted mail in a script-disabled opaque frame with usable HTTP and mailto links', () => {
  const inner = isolatedDocument(render('<p class="mail">Readable <strong>formatting</strong></p><style>.mail{color:#123456}</style><table><tr><td>Cell</td></tr></table><a href="https://example.test/path">HTTPS</a><a href="mailto:test@example.test">Mail</a><img src="{{domain}}attachments/test.png">', 'files.example.test'));
  expect(inner.querySelector('strong').textContent).toBe('formatting');
  expect(inner.querySelector('td').textContent).toBe('Cell');
  expect([...inner.querySelectorAll('style')].map(node => node.textContent).join('\n')).toContain('.mail{color:#123456}');
  expect(inner.querySelector('img').getAttribute('src')).toBe('https://files.example.test/attachments/test.png');
  expect([...inner.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])).toEqual([
   ['https://example.test/path', '_blank', 'noopener noreferrer'], ['mailto:test@example.test', '_blank', 'noopener noreferrer']
  ]);
 });

 it('contains attribute-breaking markup and removes active nested content and unsafe links', () => {
  const inner = isolatedDocument(render('<p>"</iframe><script>window.parentProbe=1</script> &amp; literal</p><img src="data:image/png;base64,AA==" onerror="parent.document.documentElement.dataset.probe=1"><svg onload="parentProbe=1"></svg><iframe srcdoc="&lt;script&gt;parentProbe=1&lt;/script&gt;"></iframe><form action="https://example.test/"><input name=x></form><base href="https://example.test/"><meta http-equiv="refresh" content="0;url=https://example.test/"><a href="javascript:parentProbe=1">Unsafe</a>', ''));
  expect(inner.querySelectorAll('script,iframe,form,input,base,meta[http-equiv],svg')).toHaveLength(0);
  expect(inner.querySelector('img').hasAttribute('onerror')).toBe(false);
  expect(inner.querySelector('a').hasAttribute('href')).toBe(false);
  expect(inner.querySelector('p').textContent).toContain(' & literal');
 });

 beforeEach(fixture);
 it('the signed real route uses containment and does not publish an immutable cached message', async () => {
  await env.db.prepare('INSERT INTO email(email_id,account_id,user_id,content) VALUES(10,1,1,?)').bind('<p>Route <strong>body</strong></p><img src="data:image/png;base64,AA==" onerror="window.routeProbe=1">').run();
  const token = await jwt.generateToken({ env }, { emailId: 10 });
  const response = await app.request('https://mail.example.test/telegram/getEmail/' + token, {}, env);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const inner = isolatedDocument(await response.text());
  expect(inner.querySelector('strong').textContent).toBe('body');
 });
});
