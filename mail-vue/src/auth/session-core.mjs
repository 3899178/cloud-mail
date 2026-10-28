export function createSession({
  storage,
  fetcher,
  base
}) {
  const state = {
    authenticated: false,
    csrfToken: null,
    reset() {
      this.authenticated = false;
      this.csrfToken = null;
      storage.removeItem('token');
      this.onReset?.();
    },
    async adopt(token) {
      const response = await fetcher(base.replace(/\/$/, '') + '/session/exchange', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Authorization: token
        }
      });
      const result = await response.json();
      if (!response.ok || result.code !== 200 || !result.data?.csrfToken) throw new Error('SESSION_EXCHANGE_FAILED');
      this.csrfToken = result.data.csrfToken;
      this.authenticated = true;
      storage.removeItem('token');
    },
    async bootstrap() {
      const token = storage.getItem('token');
      if (token && token !== 'null') return this.adopt(token);
      const response = await fetcher(base.replace(/\/$/, '') + '/session', {
        credentials: 'same-origin'
      });
      const result = await response.json();
      this.authenticated = response.ok && result.code === 200;
      this.csrfToken = this.authenticated ? result.data.csrfToken : null;
    }
  };
  return state;
}
