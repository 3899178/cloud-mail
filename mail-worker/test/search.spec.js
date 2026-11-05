import { beforeEach,it,expect } from 'vitest';
import app from '../src/hono/webs';
import { fixture,auth,env } from './fixture';
import migration from '../migrations/0001_unified_feed.sql?raw';
let token;
beforeEach(async()=>{await fixture();token=await auth();await env.db.exec(migration.replace(/^--.*$/gm,''));});
const req=(query='')=>app.request('https://mail.example.test/unified/messages?'+query,{headers:{Authorization:token}},env);
async function insert(id, values={}){
 const v={user:1,account:1,subject:'ordinary',sender:'sender@test',name:'Sender',text:'plain',html:'',deleted:0,...values};
 await env.db.prepare('INSERT INTO email(email_id,user_id,account_id,subject,send_email,name,text,content,is_del,create_time) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,v.user,v.account,v.subject,v.sender,v.name,v.text,v.html,v.deleted,'2026-01-01 00:00:00').run();
}
it('searches local subject, sender and text/HTML body with original visibility and owner checks',async()=>{
 await insert(1,{subject:'学费 receipt'});await insert(2,{name:'学费办公室'});await insert(3,{text:'学费到账'});await insert(4,{text:'',html:'<p>学费到账</p>'});await insert(5);
 await insert(6,{user:2,account:2,subject:'学费'});await insert(7,{subject:'学费',deleted:1});
 for(const [field,count] of [['all',4],['subject',1],['sender',1],['body',2]]){
  const r=await req(new URLSearchParams({source:'cloud-mail',search:' 学费 ',searchField:field}));expect(r.status).toBe(200);expect((await r.json()).data.items).toHaveLength(count);
 }
});
it('uses literal wildcard/quote terms and rejects invalid input before a broad listing',async()=>{
 await insert(1,{subject:'10%_! receipt'});await insert(2,{subject:'10000 receipt'});
 const r=await req(new URLSearchParams({source:'cloud-mail',search:'10%_!',searchField:'subject'}));expect((await r.json()).data.items).toHaveLength(1);
 for(const query of [{search:'x'.repeat(201)},{search:'a\nb'},{search:'x',searchField:'not-a-field'}]){
  const response=await req(new URLSearchParams({source:'cloud-mail',...query}));expect(response.status).toBe(400);expect((await response.json()).error.code).toBe('INVALID_INPUT');
 }
});
it('forwards normalized search with account scope to the signed external request',async()=>{
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';let captured;
 env.MAIL_SYNC={fetch:async request=>{captured=new URL(request.url);return Response.json({items:[],nextCursor:null});}};
 const r=await req(new URLSearchParams({source:'external',accountId:'acc-1',search:' 中文 ',searchField:'body'}));expect(r.status).toBe(200);
 expect(captured.searchParams.get('search')).toBe('中文');expect(captured.searchParams.get('searchField')).toBe('body');expect(captured.searchParams.get('accountId')).toBe('acc-1');
});
it('returns only matching local rows as incomplete during external outage, without continuation',async()=>{
 await insert(1,{subject:'needle'});await insert(2,{subject:'unrelated'});
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';env.MAIL_SYNC={fetch:async()=>{throw Error('fixture unavailable');}};
 const r=await req('search=needle&searchField=subject');expect(r.status).toBe(200);const d=(await r.json()).data;
 expect(d.items).toHaveLength(1);expect(d.incomplete).toBe(true);expect(d.nextCursor).toBeNull();
});
it('searches beyond the newest fifty rows with stable selected-account pagination',async()=>{
 for(let i=1;i<=58;i++)await insert(i,{subject:i<=6?'needle':'unrelated'});
 await insert(59,{user:2,account:2,subject:'needle'});
 const items=[];let cursor;
 do {
  const q=new URLSearchParams({source:'cloud-mail',accountId:'1',search:'needle',searchField:'subject',limit:'2'});if(cursor)q.set('cursor',cursor);
  const r=await req(q);expect(r.status).toBe(200);const d=(await r.json()).data;items.push(...d.items);cursor=d.nextCursor;
 }while(cursor);
 expect(items).toHaveLength(6);expect(new Set(items.map(m=>m.ref)).size).toBe(6);
 const denied=await req('source=cloud-mail&accountId=2&search=needle');expect((await denied.json()).data.items).toEqual([]);
});
