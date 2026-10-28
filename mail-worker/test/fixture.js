import { env } from 'cloudflare:test';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import user from '../src/entity/user';
import { account } from '../src/entity/account';
import { email } from '../src/entity/email';
import { att } from '../src/entity/att';
import { role } from '../src/entity/role';
import { regKey } from '../src/entity/reg-key';
import { oauth } from '../src/entity/oauth';
import { perm } from '../src/entity/perm';
import { rolePerm } from '../src/entity/role-perm';
import Kv from '../src/const/kv-const';
import jwt from '../src/utils/jwt-utils';
export async function fixture() {
 for (const table of [user,account,email,att,role,regKey,oauth,perm,rolePerm]) {
  const {name,columns}=getTableConfig(table);
  const fields=columns.map(c=>`"${c.name}" ${c.getSQLType()} ${c.primary?'PRIMARY KEY AUTOINCREMENT':''} ${c.notNull?'NOT NULL':''} ${name==='reg_key'&&c.name==='code'?'COLLATE NOCASE':''} ${c.default===undefined?'':`DEFAULT ${typeof c.default==='number'?c.default:typeof c.default==='string'?"'"+c.default.replaceAll("'","''")+"'":'CURRENT_TIMESTAMP'}`}`);
  await env.db.prepare(`CREATE TABLE IF NOT EXISTS "${name}" (${fields.join(',')})`).run();
 }
 // Corresponding additive indexes in src/init/init.js v1_4DB/v1_6DB.
 await env.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_nocase ON account(email COLLATE NOCASE); CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_nocase ON user(email COLLATE NOCASE); CREATE UNIQUE INDEX IF NOT EXISTS idx_setting_code ON reg_key(code COLLATE NOCASE);');
 await env.kv.put(Kv.SETTING,JSON.stringify({register:0,regKey:1,registerVerify:1,minEmailPrefix:1,emailPrefixFilter:'',syncDelete:1,resendTokens:{},title:'Mail',background:'',manyEmail:0,addEmail:0}));
 await env.db.prepare("INSERT INTO role(role_id,name,key,is_default,avail_domain) VALUES(1,'member','member',1,'example.test')").run();
 for (const id of [1,2]) {
  await env.db.prepare("INSERT INTO user(user_id,email,type,password,salt) VALUES(?,?,1,'fixture-password-hash','fixture-salt')").bind(id,`u${id}@example.test`).run();
  await env.db.prepare('INSERT INTO account(account_id,user_id,email,name) VALUES(?,?,?,?)').bind(id,id,`u${id}@example.test`,`User${id}`).run();
 }
}
export async function auth(id=1) {
 const token=`uuid-${id}`;
 await env.kv.put(Kv.AUTH_INFO+id,JSON.stringify({tokens:[token],user:{userId:id,email:`u${id}@example.test`},refreshTime:new Date().toISOString()}));
 return jwt.generateToken({env},{userId:id,token});
}
export {env};
