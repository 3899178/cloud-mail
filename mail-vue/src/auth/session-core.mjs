export const isStaleSession = error => error?.code === 'STALE_SESSION';

function staleSession() {
  return Object.assign(new Error('STALE_SESSION'), { code: 'STALE_SESSION' });
}

export function createSession({
  storage,
  fetcher,
  base
}) {
  let controller = new AbortController();
  const state = {
    generation: 0,
    authenticated: false,
    csrfToken: null,
    lease() {
      const generation = this.generation;
      const signal = controller.signal;
      const current = () => this.generation === generation && !signal.aborted;
      return { signal, current, assertCurrent() { if (!current()) throw staleSession(); } };
    },
    advance() {
      this.generation++;
      controller.abort();
      controller = new AbortController();
      return this.lease();
    },
    reset() {
      this.advance();
      this.authenticated = false;
      this.csrfToken = null;
      storage.removeItem('token');
      this.onReset?.();
    },
    async adopt(token) {
      const lease = this.advance();
      this.authenticated = false;
      this.csrfToken = null;
      this.onReset?.();
      try {
        const response = await fetcher(base.replace(/\/$/, '') + '/session/exchange', {
          method: 'POST',
          credentials: 'same-origin',
          signal: lease.signal,
          headers: { Authorization: token }
        });
        const result = await response.json();
        lease.assertCurrent();
        if (!response.ok || result.code !== 200 || !result.data?.csrfToken) throw new Error('SESSION_EXCHANGE_FAILED');
        this.csrfToken = result.data.csrfToken;
        this.authenticated = true;
        storage.removeItem('token');
      } catch (error) {
        lease.assertCurrent();
        throw error;
      }
    },
    async bootstrap() {
      const token = storage.getItem('token');
      if (token && token !== 'null') return this.adopt(token);
      const lease = this.advance();
      this.authenticated = false;
      this.csrfToken = null;
      this.onReset?.();
      try {
        const response = await fetcher(base.replace(/\/$/, '') + '/session', {
          signal: lease.signal,
          credentials: 'same-origin'
        });
        const result = await response.json();
        lease.assertCurrent();
        this.authenticated = response.ok && result.code === 200;
        this.csrfToken = this.authenticated ? result.data.csrfToken : null;
      } catch (error) {
        lease.assertCurrent();
        throw error;
      }
    }
  };
  return state;
}
