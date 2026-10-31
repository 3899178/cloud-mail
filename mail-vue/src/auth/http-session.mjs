// Install before response consumers, so stale 401s cannot reset the next owner's session.
export function installSessionFence(http, session) {
  http.interceptors.request.use(config => {
    const lease = session.lease();
    config.sessionLease = lease;
    config.signal = config.signal ? AbortSignal.any([config.signal, lease.signal]) : lease.signal;
    return config;
  });
  http.interceptors.response.use(response => {
    response.config.sessionLease?.assertCurrent();
    return response;
  }, error => {
    error.config?.sessionLease?.assertCurrent();
    return Promise.reject(error);
  });
}
