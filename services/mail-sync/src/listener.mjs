// This opt-in is only for a private container network. All business routes still
// verify the Worker assertion; compose must never publish this port on the host.
export function listenHost(env = process.env) {
  if (env.MAIL_SYNC_PRIVATE_CONTAINER === undefined) return '127.0.0.1';
  if (env.MAIL_SYNC_PRIVATE_CONTAINER !== '1') throw new Error('INVALID_LISTENER_CONFIGURATION');
  return '0.0.0.0';
}
