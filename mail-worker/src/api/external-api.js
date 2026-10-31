import app from '../hono/hono';
import { fail } from '../../../shared/unified-mail/index.mjs';
import { proxyJson, syncRequest, jsonBytes, parseJson, boundedBody } from '../service/sync-gateway';
const base = '/external/accounts';
for (const method of ['get', 'post']) app[method](base, c => proxyJson(c, '/v1/accounts'));
app.get(base + '/:id', c => proxyJson(c, '/v1/accounts/' + encodeURIComponent(c.req.param('id'))));
app.delete(base + '/:id', c => proxyJson(c, '/v1/accounts/' + encodeURIComponent(c.req.param('id'))));
app.put(base + '/:id/credentials', c => proxyJson(c, '/v1/accounts/' + encodeURIComponent(c.req.param('id')) + '/credentials'));
for (const action of ['connect', 'pause', 'resume', 'oauth/start', 'proton/start', 'proton/complete']) app.post(base + '/:id/' + action, c => proxyJson(c, '/v1/accounts/' + encodeURIComponent(c.req.param('id')) + '/' + action));
for (const [name, provider] of [['google', 'gmail'], ['microsoft', 'outlook']]) app.get('/external/oauth/' + name + '/callback', async c => {
  const state = c.req.query('state'),
    code = c.req.query('code');
  if (!state || !code || c.req.query('error')) fail('AUTH_REQUIRED');
  const resolved = await syncRequest(c, {
    path: '/v1/oauth/resolve',
    method: 'POST',
    ownerId: 'oauth-callback',
    body: jsonBytes({
      state
    })
  });
  const identity = parseJson(await boundedBody(resolved));
  if (identity.provider !== provider) fail('UNAUTHORIZED');
  const response = await syncRequest(c, {
    path: '/v1/oauth/complete',
    method: 'POST',
    ownerId: identity.ownerId,
    body: jsonBytes({
      state,
      code
    })
  });
  const data = parseJson(await boundedBody(response));
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  // No tokens/state in redirect or browser storage. UI reads actual account status on return.
  return c.redirect('/settings?externalOAuth=' + encodeURIComponent(data.account?.status === 'active' ? 'active' : 'attention'), 303);
});
app.get('/external/operations', c => proxyJson(c, '/v1/operations'));
app.get('/external/operations/:id', c => proxyJson(c, '/v1/operations/' + encodeURIComponent(c.req.param('id'))));
app.post('/external/uploads', c => proxyJson(c, '/v1/uploads'));
app.delete('/external/uploads/:id', c => proxyJson(c, '/v1/uploads/' + encodeURIComponent(c.req.param('id'))));
app.put('/external/uploads/:id', async c => {
  const capability = c.req.header('x-upload-capability');
  if (!capability || capability.length > 8192) fail('UNAUTHORIZED');
  const response = await syncRequest(c, {
    path: '/v1/uploads/' + encodeURIComponent(c.req.param('id')),
    body: c.req.raw.body,
    stream: true,
    headers: {
      'x-upload-capability': capability
    }
  });
  c.header('Cache-Control', 'no-store');
  return c.json({
    code: 200,
    message: 'success',
    data: parseJson(await boundedBody(response))
  });
});
