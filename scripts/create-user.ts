/**
 * Create (or reset) a real user account.
 *   npm run user:create -- --email you@rosierfoods.com --name "Your Name" --role super_admin
 * Prompts for nothing; a strong random password is printed once unless --password is given.
 */
import './_env';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { getPool, withSystem } from '../src/lib/db';
import { createOrganization, ensureOrgDefaults } from '../src/lib/demo/bootstrap';
import { ROLES } from '../src/lib/constants';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.toLowerCase();
  const name = arg('name') ?? email;
  const role = (arg('role') ?? 'super_admin') as (typeof ROLES)[number];
  if (!email || !ROLES.includes(role)) {
    console.error('Usage: npm run user:create -- --email you@company.com --name "Name" --role super_admin|crm_manager|team_leader|quality_analyst|support_agent [--password ...]');
    process.exit(1);
  }
  const password = arg('password') ?? randomBytes(12).toString('base64url') + '9a';
  if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
  const hash = await bcrypt.hash(password, 12);
  await withSystem(async (db) => {
    const orgId = await createOrganization(db, process.env.ORG_NAME ?? 'Rosier Foods', process.env.ORG_SLUG ?? 'rosier-foods');
    await ensureOrgDefaults(db, orgId);
    await db.exec(
      `INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, name = EXCLUDED.name,
         is_active = true, failed_login_count = 0, locked_until = NULL`,
      [orgId, email, name, hash, role]);
    await db.exec(`INSERT INTO audit_logs (org_id, action, target_type, details) VALUES ($1,'user.created_cli','user',$2)`,
      [orgId, JSON.stringify({ email, role })]);
  });
  console.log(`User ${email} (${role}) ready.`);
  if (!arg('password')) console.log(`Temporary password: ${password}\nChange it after signing in (Profile → Security).`);
  await getPool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
