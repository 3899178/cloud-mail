// Test transport only: loopback TCP -> an operator-owned SSH Unix socket.
// No payload accumulation, authentication data, retry or public listener.
import { createServer, createConnection } from 'node:net';

export async function startRelay({ socketPath, port = 0 }) {
 if (typeof socketPath !== 'string' || !socketPath || socketPath.includes('\0') || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_ORACLE_RELAY');
 const active = new Map(), streams = new Set(); const stats = { open: 0, accepted: 0, upstreamErrors: 0 };
 const server = createServer({ allowHalfOpen: true }, client => {
  if (active.size >= 32) { client.destroy(); return; }
  const target = createConnection({ path: socketPath, allowHalfOpen: true });
  streams.add(client); streams.add(target);
  active.set(client, target); stats.open = active.size; stats.accepted++;
  client.on('error', () => target.destroy());
  target.once('error', () => { stats.upstreamErrors++; client.destroy(); });
  client.once('close', hadError => {
   streams.delete(client);
   active.delete(client); stats.open = active.size;
   if (hadError || !client.readableEnded) target.destroy();
  });
  target.once('close', hadError => { streams.delete(target); if (hadError || !target.readableEnded) client.destroy(); });
  // Built-in pipe backpressure keeps socket writes bounded. Normal FIN must
  // flush the opposite writable side, rather than destroy its queued reply.
  client.pipe(target); target.pipe(client);
 });
 await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
 });
 let closing;
 return { host: '127.0.0.1', port: server.address().port, stats,
  close() {
   closing ||= (async () => {
    // Track emitted close events ourselves: stream.closed can become true
    // before the close listeners (and connection accounting) have run.
    const closed = [...streams].map(socket => new Promise(resolve => {
     socket.once('close', resolve); socket.destroy();
    }));
    const stopped = new Promise(resolve => server.close(resolve));
    await Promise.all([...closed, stopped]);
   })();
   return closing;
  }
 };
}
