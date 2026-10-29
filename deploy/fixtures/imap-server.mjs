// External synthetic provider: runs outside the measured service cgroup. No live
// mailbox or credentials. Real TLS/IMAP production clients consume its traffic.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { imapFixture, wireMime } from '../../services/mail-sync/tests/protocol/fixtures.mjs';
const cleanups=[];const imap=await imapFixture({listenHost:'0.0.0.0',after:fn=>cleanups.push(fn)});const s=imap.state;
s.condstore=true;
const rows=s.folders.get('Archive');
for(let i=1;i<=10000;i++) rows.push({uid:i,key:`history-${i}`,subject:'retained historical catalog',unread:false,raw:wireMime(`h-${i}`),internalDate:'01-Jan-2020 12:00:00 +0000'});
const summary=()=>({port:imap.port,requests:s.commands.length,fetchRequests:s.commands.filter(v=>/ FETCH /.test(v)).length,metadataRows:s.metadataRows,metadataEgressBytes:s.metadataEgressBytes,egressBytes:s.egressBytes,connections:s.connections});
function largeMime(){
 const payload=Buffer.alloc(25*1024*1024).toString('base64').match(/.{1,76}/g).join('\r\n');
 const head='From: fixture@example.test\r\nDate: Thu, 01 Jan 2020 00:00:00 +0000\r\nSubject: largest\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=large\r\n\r\n--large\r\nContent-Type: text/plain\r\n\r\nfixture\r\n--large\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=largest.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n';
 const base=Buffer.from(head+payload+'\r\n--large--\r\n');const total=36*1024*1024;if(base.length>total)throw Error('MIME_OVER_LIMIT');return Buffer.concat([base,Buffer.alloc(total-base.length,0x20)],total);
}
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname==='/info'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...summary(),ca:imap.ca}));return}
  if(req.method!=='POST')throw Error('METHOD');
  const action=url.pathname.slice(1);s.modseq++;
  if(action==='burst')rows.push({uid:10001,key:'new-old-date',subject:'new-old-date',unread:true,modseq:s.modseq,raw:wireMime('new-old-date'),internalDate:'01-Jan-2020 12:00:00 +0000'});
  else if(action==='read'){const m=rows.find(m=>m.uid===10001);m.unread=false;m.modseq=s.modseq}
  else if(action==='move'){const i=rows.findIndex(m=>m.uid===10001);const [m]=rows.splice(i,1);s.folders.get('Rules').push({...m,uid:1,modseq:s.modseq})}
  else if(action==='delete')s.folders.get('Rules').length=0;
  else if(action==='large')rows.push({uid:10002,key:'largest',subject:'largest',unread:true,modseq:s.modseq,raw:largeMime(),internalDate:'01-Jan-2020 12:00:00 +0000'});
  else throw Error('ACTION');
  res.end(JSON.stringify(summary()));
 }catch{res.writeHead(400);res.end('{"error":"FIXTURE_INPUT"}')}
});
await new Promise(r=>server.listen(8080,'0.0.0.0',r));console.log(JSON.stringify({ready:true,...summary()}));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{for(const close of cleanups)close();server.close();process.exit(0)});
