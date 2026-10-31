import { unifiedFeed } from '../service/unified-feed';
import app from '../hono/hono';
import result from '../model/result';
import { decodeSourceRef, fail } from '../../../shared/unified-mail/index.mjs';
import { proxyJson, syncRequest, boundedBody, parseJson } from '../service/sync-gateway';
import { localDetail, localAttachment, localRead, localTrash, localSend } from '../service/unified-local';
app.get('/unified/messages', async c => c.json(result.ok(await unifiedFeed(c))));
const isLocal = ref => decodeSourceRef(ref).source === 'cloud-mail';
app.get('/unified/messages/:ref', async c => {
  const ref = c.req.param('ref');
  return isLocal(ref) ? c.json(result.ok({
    message: await localDetail(c, ref)
  })) : proxyJson(c, '/v1/messages/' + encodeURIComponent(ref));
});
app.get('/unified/messages/:ref/attachments/:id', async c => {
  const ref = c.req.param('ref'),
    id = c.req.param('id');
  if (isLocal(ref)) return localAttachment(c, ref, id);
  const response = await syncRequest(c, {
    path: '/v1/messages/' + encodeURIComponent(ref) + '/attachments/' + encodeURIComponent(id)
  });
  return new Response(response.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Disposition': response.headers.get('Content-Disposition') || 'attachment'
    }
  });
});
for (const action of ['read', 'trash']) app.post('/unified/messages/:ref/' + action, async c => {
  const ref = c.req.param('ref');
  if (!isLocal(ref)) return proxyJson(c, '/v1/messages/' + encodeURIComponent(ref) + '/' + action);
  const operation = action === 'read' ? await localRead(c, ref, parseJson(await boundedBody(c.req.raw)).unread) : await localTrash(c, ref);
  return c.json(result.ok({
    operation
  }));
});
app.post('/unified/messages/send', async c => {
  const bytes = await boundedBody(c.req.raw),
    body = parseJson(bytes);
  if (body.source === 'cloud-mail') return c.json(result.ok({
    operation: await localSend(c, body)
  }));
  if (body.source !== 'external') fail('INVALID_INPUT');
  return proxyJson(c, '/v1/send', bytes);
});
