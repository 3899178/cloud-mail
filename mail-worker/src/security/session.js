import { getCookie, setCookie } from 'hono/cookie';
import jwtUtils from '../utils/jwt-utils';
import constant from '../const/constant';
import { fail } from '../../../shared/unified-mail/index.mjs';
export const SESSION_COOKIE = '__Host-cloud-mail';
export const callbackPaths = new Set(['/external/oauth/google/callback', '/external/oauth/microsoft/callback']);
export function requestToken(c) {
  const authorization = c.req.header('Authorization');
  if (authorization !== undefined) return authorization.replace(/^Bearer\s+/i, '');
  return getCookie(c, SESSION_COOKIE);
}
export function sameOrigin(c, required = false) {
  const origin = c.req.header('Origin');
  const mismatched = origin && origin !== new URL(c.req.url).origin;
  if ((required && !origin) || mismatched || c.req.header('Sec-Fetch-Site') === 'cross-site') {
    fail('CSRF_REJECTED');
  }
}
export function safePath(path) {
  return ['/external/', '/unified/', '/session'].some(p => path.startsWith(p)) || ['/login', '/register', '/logout', '/public/addUser', '/user/add'].includes(path) || path.startsWith('/oauth/');
}
export async function enforceCookieWrite(c, claims) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.header('Authorization') !== undefined) return;
  sameOrigin(c, true);
  if (!claims.csrf || c.req.header('X-CSRF-Token') !== claims.csrf) fail('CSRF_REJECTED');
}
export async function exchangeSession(c) {
  sameOrigin(c, true);
  if (!c.req.header('Authorization')) fail('UNAUTHORIZED');
  const claims = c.get('authClaims');
  const csrfToken = crypto.randomUUID();
  const token = await jwtUtils.generateToken(c, {
    userId: claims.userId,
    token: claims.token,
    csrf: csrfToken
  }, constant.TOKEN_EXPIRE);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: constant.TOKEN_EXPIRE
  });
  return {
    csrfToken
  };
}
export function clearSession(c) {
  setCookie(c, SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0
  });
}
