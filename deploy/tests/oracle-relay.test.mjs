import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRelay } from '../fixtures/oracle-relay.mjs';

const socketPath=()=>process.platform==='win32'?'\\\\.\\pipe\\cm-relay-'+randomUUID():join(tmpdir(),'cm-relay-'+randomUUID());
async function upstream(t, handler){
 const path=socketPath(),sockets=new Set();
 const server=createServer({allowHalfOpen:true},socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));handler(socket)});
 server.listen(path);await once(server,'listening');
 t.after(()=>{for(const s of sockets)s.destroy();server.close()});
 return path;
}

test('loopback relay preserves binary request/response and half-close to the private oracle socket',{timeout:5000,skip:process.platform==='win32'?'Native Windows named-pipe FIN closes the response direction; require the Linux Unix-socket run':false},async t=>{
 const path=await upstream(t,socket=>{
  const hash=createHash('sha256');socket.on('data',data=>hash.update(data));socket.on('end',()=>socket.end('ack:'+hash.digest('hex')));
 });
 const relay=await startRelay({socketPath:path});t.after(()=>relay.close());
 assert.equal(relay.host,'127.0.0.1');assert(relay.port>0);
 const client=createConnection({host:'127.0.0.1',port:relay.port});t.after(()=>client.destroy());
 const received=[];client.on('data',chunk=>received.push(chunk));
 const bytes=Buffer.alloc(1024*1024);for(let n=0;n<bytes.length;n++)bytes[n]=n%256;
 client.end(bytes);await once(client,'end');
 assert.equal(Buffer.concat(received).toString(),'ack:'+createHash('sha256').update(bytes).digest('hex'));
 await relay.close();assert.equal(relay.stats.open,0);
});

test('unavailable target closes the requesting client without an unhandled socket error',{timeout:5000},async t=>{
 const relay=await startRelay({socketPath:socketPath()});t.after(()=>relay.close());
 const client=createConnection({host:'127.0.0.1',port:relay.port});t.after(()=>client.destroy());client.on('error',()=>{});
 await new Promise(resolve=>client.once('close',resolve));
 await relay.close();assert.equal(relay.stats.open,0);assert.equal(relay.stats.upstreamErrors,1);
});

test('shutdown closes both ends of active relay connections and is idempotent',{timeout:5000},async t=>{
 let signalClosed;
 const upstreamClosed=new Promise(resolve=>{signalClosed=resolve});
 const path=await upstream(t,socket=>{socket.once('close',signalClosed);socket.once('end',()=>socket.end());socket.write('ready')});
 const relay=await startRelay({socketPath:path});t.after(()=>relay.close());
 const client=createConnection({host:'127.0.0.1',port:relay.port});t.after(()=>client.destroy());client.on('error',()=>{});
 await once(client,'data');await relay.close();await relay.close();
 if(!client.destroyed)await new Promise(resolve=>client.once('close',resolve));
 await upstreamClosed;assert.equal(relay.stats.open,0);
});
