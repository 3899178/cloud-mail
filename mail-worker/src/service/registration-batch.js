import { fail } from '../../../shared/unified-mail/index.mjs';
import emailUtils from '../utils/email-utils';
import reqUtils from '../utils/req-utils';
import dayjs from 'dayjs';
import orm from '../entity/orm';
import role from '../entity/role';
import regKey from '../entity/reg-key';
import account from '../entity/account';
import { eq, sql } from 'drizzle-orm';
import { roleConst } from '../const/entity-const';

export async function loadRegistrationContexts(c, list) {
  if (!list.length) return [];
  const db = orm(c);
  const queries = [db.select().from(role).where(eq(role.isDefault, roleConst.isDefault.OPEN)).limit(1)];
  for (const params of list) {
    // Keep matching in SQL: JavaScript case folding is not SQLite's authoritative collation.
    queries.push(
      db.select().from(regKey).where(eq(regKey.code, params.code || '')).limit(1),
      db.select().from(account).where(sql`${account.email} COLLATE NOCASE = ${params.email}`).limit(1),
      db.select().from(role).where(eq(role.name, params.roleName || '')).limit(1)
    );
  }
  // A D1 batch counts as one binding invocation; each member keeps its own bounded parameters.
  const results = await db.batch(queries);
  const defaultRole = results[0][0];
  const contexts = list.map((params, index) => {
    const [invitationRows, accountRows, namedRoleRows] = results.slice(1 + index * 3, 4 + index * 3);
    const invitation = invitationRows[0] || null;
    const privilegedType = params.type ?? namedRoleRows[0]?.roleId;
    const type = privilegedType ?? invitation?.roleId;
    return { invitation, account: accountRows[0] || null, defaultRole, privilegedType, type: type || defaultRole?.roleId };
  });
  const roles = await db.batch(contexts.map(context => db.select().from(role).where(eq(role.roleId, context.type)).limit(1)));
  return contexts.map((context, index) => ({ ...context, role: roles[index][0] }));
}

// Used by both single registration and whole-list public admission. No request-time DDL.
export function registrationStatements(c, row, { admitted = false } = {}) {
  const { email, regKeyId, hash, salt, type, code, binding } = row;
  const { os, browser, device } = reqUtils.getUserAgent(c);
  const ip = reqUtils.getIp(c);
  const args = [email, regKeyId, hash, salt, type, os, browser, device, ip, ip, dayjs().format('YYYY-MM-DD HH:mm:ss')];
  let admission = '';
  if (!admitted) {
    admission = ` WHERE EXISTS(SELECT 1 FROM reg_key WHERE rege_key_id=? AND code=? AND count>0 AND datetime(expire_time)>CURRENT_TIMESTAMP)
      AND NOT EXISTS(SELECT 1 FROM account WHERE email=? COLLATE NOCASE)
      AND NOT EXISTS(SELECT 1 FROM user WHERE email=? COLLATE NOCASE)`;
    args.push(regKeyId, code, email, email);
    if (binding) {
      admission += ' AND EXISTS(SELECT 1 FROM oauth WHERE oauth_id=? AND platform=? AND oauth_user_id=? AND user_id=0)';
      args.push(binding.oauthId, binding.platform, binding.oauthUserId);
    }
  }
  const statements = [
    c.env.db.prepare(`INSERT INTO user(email,reg_key_id,password,salt,type,os,browser,device,active_ip,create_ip,active_time)
      SELECT ?,?,?,?,?,?,?,?,?,?,?${admission} RETURNING user_id`).bind(...args),
    c.env.db.prepare('INSERT INTO account(user_id,email,name) SELECT last_insert_rowid(),?,? WHERE changes()=1')
      .bind(email, emailUtils.getName(email)),
    c.env.db.prepare('UPDATE reg_key SET count=count-1 WHERE rege_key_id=? AND changes()=1').bind(regKeyId)
  ];
  if (binding) {
    statements.push(c.env.db.prepare('UPDATE oauth SET user_id=(SELECT user_id FROM user WHERE email=? COLLATE NOCASE) WHERE oauth_id=? AND user_id=0 AND changes()=1')
      .bind(email, binding.oauthId));
  }
  return statements;
}

export async function commitBulkRegistrations(c, rows) {
  if (!rows.length) return;
  try {
    await c.env.db.prepare('SELECT admitted FROM registration_admission_guard LIMIT 1').first();
  } catch {
    fail('REGISTRATION_NOT_READY');
  }
  // Group by the authoritative primary key returned by the NOCASE lookup, including case-varied codes.
  const invites = new Map();
  for (const row of rows) {
    const group = invites.get(row.regKeyId) || { code: row.code, uses: 0 };
    group.uses++;
    invites.set(row.regKeyId, group);
  }
  const statements = [];
  for (const [id, group] of invites) {
    // Valid admission inserts no guard row. A failed CHECK aborts the SAME D1 batch transaction.
    statements.push(c.env.db.prepare(`INSERT INTO registration_admission_guard(admitted)
      SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM reg_key WHERE rege_key_id=? AND code=? AND count>=? AND datetime(expire_time)>CURRENT_TIMESTAMP)`)
      .bind(id, group.code, group.uses));
  }
  for (const row of rows) statements.push(...registrationStatements(c, row, { admitted: true }));
  try {
    // D1 serializes this batch as one transaction: guards, all user/account rows and exact invite counts.
    // Unique email constraints and account insertion errors abort the entire list as well.
    await c.env.db.batch(statements);
  } catch {
    fail('CONFLICT');
  }
}
