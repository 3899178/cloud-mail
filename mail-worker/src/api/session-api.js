import app from '../hono/hono';
import result from '../model/result';
import { exchangeSession } from '../security/session';
app.post('/session/exchange', async c => c.json(result.ok(await exchangeSession(c))));
app.get('/session', c => c.json(result.ok({
  userId: c.get('user').userId,
  csrfToken: c.get('authClaims').csrf || null
})));
