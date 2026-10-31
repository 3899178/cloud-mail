// Explicit local probe: node --test deploy/tests/resource-burst.probe.mjs.
// Requires installed services/mail-sync dependencies; excluded from the
// dependency-free host CI *.test.mjs preflight. Not a Linux resource proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {imapFixture,wireMime} from '../../services/mail-sync/tests/protocol/fixtures.mjs';
import {openStore} from '../../services/mail-sync/src/core/store.mjs';
import {createImapSession} from '../../services/mail-sync/src/providers/imap.mjs';
import {createSyncEngine} from '../../services/mail-sync/src/sync/engine.mjs';
test('resource-scale TLS IMAP burst retains 10000 history rows and admits old-Date body',async t=>{
 const imap=await imapFixture(t);imap.state.condstore=true;
 const rows=imap.state.folders.get('Archive');
 for(let i=1;i<=10000;i++)rows.push({uid:i,key:`history-${i}`,subject:'history',unread:false,raw:wireMime(`h-${i}`),internalDate:'01-Jan-2020 12:00:00 +0000'});
 const dir=mkdtempSync(join(tmpdir(),'cm-burst-'));const store=openStore({dbPath:join(dir,'mail.sqlite'),dataDir:join(dir,'attachments'),masterKey:new Uint8Array(32).fill(7)});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
 const account=store.accounts.create('fixture',{id:'scale',provider:'imap',address:'fixture@example.test'});
 const phases=[];
 const registry={open:async()=>{const s=await createImapSession({account,config:{imap:{host:'fixture.test',port:imap.port,secure:true}},auth:async()=>({user:'fixture',pass:'fixture'}),tlsOptions:{ca:imap.ca},endpointResolver:async()=>({host:'127.0.0.1',port:imap.port,servername:'fixture.test'})});
  for(const op of ['snapshot','fetch','validateSnapshot']){const original=s[op];s[op]=async(...args)=>{try{return await original(...args)}catch(e){phases.push({op,code:e.code||'unclassified'});throw e}}}return s}};
 const engine=createSyncEngine({store,registry});const sync=()=>engine.syncAccount({ownerId:'fixture',accountId:account.id});
 assert.equal((await sync()).status,'active');assert.equal(store.sources.catalog('fixture',account.id).length,10000);
 rows.push({uid:10001,key:'new-old-date',subject:'new-old-date',unread:true,modseq:2,raw:wireMime('new-old-date'),internalDate:'01-Jan-2020 12:00:00 +0000'});imap.state.modseq=2;
 const result=await sync();t.diagnostic(JSON.stringify({status:result.status,errorCode:result.errorCode,phases}));assert.equal(result.status,'active');assert.equal(store.messages.list('fixture').items.length,1);
});
