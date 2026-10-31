import { beforeEach,it,expect } from 'vitest';
import app from '../src/hono/webs';
import { fixture,auth,env } from './fixture';
import migration from '../migrations/0001_unified_feed.sql?raw';
import {encodeSourceRef,encodeCursor,decodeCursor} from '../../shared/unified-mail/index.mjs';
let token;
beforeEach(async()=>{await fixture();token=await auth();await env.db.exec(migration.replace(/^--.*$/gm,""));});
const req=(query='')=>app.request('https://mail.example.test/unified/messages'+query,{headers:{Authorization:token}},env);
it('backfills boundedly and merges exact BINARY refs at equal UTC timestamps without skipping',async()=>{
 const rows=[];for(let id=1;id<=320;id++)rows.push(env.db.prepare("INSERT INTO email(email_id,user_id,account_id,subject,create_time) VALUES(?,1,1,'same','2026-01-01 00:00:00')").bind(id));await env.db.batch(rows);
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';env.MAIL_SYNC={fetch:async()=>Response.json({items:[],nextCursor:null})};
 let response=await req();expect(response.status).toBe(503);expect((await response.json()).error.code).toBe('LOCAL_INDEX_NOT_READY');
 let items=[],cursor='';for(let i=0;i<40;i++){response=await req('?limit=17'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(response.status===503)continue;expect(response.status).toBe(200);const d=(await response.json()).data;items.push(...d.items);cursor=d.nextCursor;if(!cursor)break;}
 const expected=Array.from({length:320},(_,i)=>encodeSourceRef({source:'cloud-mail',accountId:'1',id:String(i+1)})).sort().reverse();
 expect(items.map(m=>m.ref)).toEqual(expected);expect(items[0].receivedAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
 await env.db.prepare('UPDATE email SET user_id=2,account_id=2 WHERE email_id=1').run();await env.db.prepare('DELETE FROM email WHERE email_id=2').run();
 const d=(await (await req('?limit=100')).json()).data;expect(d.items.some(m=>m.accountId==='2')).toBe(false);
});
it('outage returns explicitly incomplete local page without a skipping cursor; recovery restarts all sources',async()=>{
 await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,create_time) VALUES(1,1,1,'2026-01-01 00:00:00')").run();
 env.MAIL_SYNC_GATEWAY_KEY='07'.repeat(32);env.MAIL_SYNC_URL='https://sync.example.test';env.MAIL_SYNC={fetch:async()=>{throw Error('secret-marker');}};
 const r=await req();expect(r.status).toBe(200);const d=(await r.json()).data;expect(d.incomplete).toBe(true);expect(d.resetRequired).toBe(true);expect(d.nextCursor).toBeNull();expect(d.items).toHaveLength(1);
 const external={ref:encodeSourceRef({source:'external',accountId:'1',id:'1'}),source:'external',accountId:'1',receivedAt:Date.parse('2026-01-01T00:00:00Z'),subject:'external'};
 env.MAIL_SYNC={fetch:async request=>{const q=new URL(request.url).searchParams;const cursor=q.get('cursor')?decodeCursor(q.get('cursor')):null;return Response.json({items:!cursor||external.ref<cursor.ref?[external]:[],nextCursor:null});}};
 const recovered=[];let cursor='';for(let i=0;i<3;i++){const page=(await (await req('?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json()).data;expect(page.incomplete).toBe(false);recovered.push(...page.items);cursor=page.nextCursor;if(!cursor)break;}
 expect(recovered.map(m=>m.ref)).toEqual([d.items[0].ref,external.ref].sort().reverse());
});
it('concurrent backfill and a new dirty generation cannot erase unindexed changes',async()=>{
 await env.db.prepare("INSERT INTO email(email_id,user_id,account_id,create_time) VALUES(1,1,1,'2026-01-01 00:00:00')").run();
 let intercepted=false;
 const db={batch:statements=>env.db.batch(statements),prepare(sql){const statement=env.db.prepare(sql);if(!sql.startsWith('SELECT q.email_id'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async all(){const snapshot=await bound.all();if(!intercepted){intercepted=true;await req('?source=cloud-mail');await env.db.prepare("UPDATE email SET create_time='2026-02-01 00:00:00' WHERE email_id=1").run();}return snapshot;}};}};}};
 const raced=await app.request('https://mail.example.test/unified/messages?source=cloud-mail',{headers:{Authorization:token}},{...env,db});expect(raced.status).toBe(503);
 const page=(await (await req('?source=cloud-mail')).json()).data;expect(page.items[0].receivedAt).toBe(Date.parse('2026-02-01T00:00:00Z'));
 expect((await env.db.prepare('SELECT received_at FROM unified_feed_index WHERE email_id=1').first()).received_at).toBe(page.items[0].receivedAt);
});
