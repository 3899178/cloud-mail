// Operator-only host test. Real provider processes run on the desktop and are
// reached exclusively through owned SSH reverse Unix sockets. These relay
// buffers remain INSIDE the same measured Node+helper 320 MiB cgroup.
import { startRelay } from './oracle-relay.mjs';
const port=Number(process.env.CLOUD_MAIL_FIXTURE_IMAP_PORT);
if(process.platform!=='linux'||process.getuid()!==10001||!Number.isInteger(port)||port<1024||port>65535||port===8080)throw Error('INVALID_TUNNEL_FIXTURE_CONTEXT');
const relays=[];
try{
 for(const [name,listenPort] of [['control',8080],['imap',port],['proton',443]])relays.push(await startRelay({socketPath:'/oracles/'+name+'.sock',port:listenPort}));
 await import('./resource.mjs');
}finally{
 await Promise.all(relays.map(relay=>relay.close()));
}
