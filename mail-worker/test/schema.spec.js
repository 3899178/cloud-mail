import { it, expect } from 'vitest';
import { fixture, env } from './fixture';
it('fixture enforces production required fields and case-insensitive email/invite indexes',async()=>{
 await fixture();
 await expect(env.db.prepare("INSERT INTO user(email,type) VALUES('missing@example.test',1)").run()).rejects.toThrow();
 await expect(env.db.prepare("INSERT INTO account(user_id,email,name) VALUES(1,'U1@example.test','duplicate')").run()).rejects.toThrow();
 await env.db.prepare("INSERT INTO reg_key(code) VALUES('CaseCode')").run();
 await expect(env.db.prepare("INSERT INTO reg_key(code) VALUES('casecode')").run()).rejects.toThrow();
});
