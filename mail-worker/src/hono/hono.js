import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';
import { safePath } from '../security/session';

app.use('*', cors());
app.use('*', async (c, next) => {
    if (safePath(c.req.path)) c.header('Cache-Control', 'no-store');
    await next();
});

// Only public error codes cross credential/session boundaries. Never log the raw error.
const safeStatuses = {
    CONFLICT: 409, UNAUTHORIZED: 401, CSRF_REJECTED: 403, FORBIDDEN: 403,
    INVALID_INPUT: 400, INVALID_REF: 400, INVALID_CURSOR: 400, NOT_FOUND: 404,
    PAYLOAD_TOO_LARGE: 413, SYNC_UNAVAILABLE: 503, INVALID_TRANSITION: 409,
    BUSY: 503, AUTH_REQUIRED: 401, PROVIDER_UNAVAILABLE: 503, SYNC_FAILED: 502,
    RATE_LIMITED: 429, RESYNC_REQUIRED: 409, INCOMPLETE_SWEEP: 409,
    STORAGE_FULL: 507, UPLOAD_EXPIRED: 410, UPLOAD_CORRUPT: 400,
    LOCAL_INDEX_NOT_READY: 503, REGISTRATION_NOT_READY: 503
};

app.onError((err, c) => {
    if (safePath(c.req.path) || err.code === 'CSRF_REJECTED') {
        const code = safeStatuses[err.code] ? err.code : (err.code === 401 ? 'UNAUTHORIZED' : 'REQUEST_FAILED');
        const status = safeStatuses[code] || 400;
        const legacy = !['/session', '/external/', '/unified/'].some(prefix => c.req.path.startsWith(prefix));
        return c.json({ code: status, message: code, error: { code } }, legacy ? 200 : status);
    }

	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定<br/>D1 database not bound',502));
	}

	if (err.message?.includes('D1_ERROR: no such column')) {
		return c.json(result.fail('请按照文档更新数据库<br/>Please update the database as documented',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


