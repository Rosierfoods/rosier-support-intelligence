/**
 * First-run admin bootstrap for hosts without a shell (e.g. free-tier Render):
 * when BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD are set AND the database has no users yet,
 * creates the organisation defaults and that Super Admin. Never touches an existing user.
 */
import bcrypt from 'bcryptjs';
import { withSystem } from '@/lib/db';
import { createOrganization, ensureOrgDefaults } from '@/lib/demo/bootstrap';

export async function bootstrapAdmin() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (!email || !password) return;
  if (password.length < 10) { console.warn('[bootstrap] BOOTSTRAP_ADMIN_PASSWORD must be at least 10 characters — skipped.'); return; }
  try {
    await withSystem(async (db) => {
      const existing = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      if ((existing?.n ?? 0) > 0) return;
      const orgId = await createOrganization(db, process.env.ORG_NAME ?? 'Rosier Foods', process.env.ORG_SLUG ?? 'rosier-foods');
      await ensureOrgDefaults(db, orgId);
      const hash = await bcrypt.hash(password, 12);
      await db.exec(`INSERT INTO users (org_id, email, name, password_hash, role) VALUES ($1,$2,$3,$4,'super_admin')`, [orgId, email, 'Admin', hash]);
      await db.exec(`INSERT INTO audit_logs (org_id, action, target_type, details) VALUES ($1,'user.created_bootstrap','user',$2)`, [orgId, JSON.stringify({ email })]);
      console.log(`[bootstrap] Created Super Admin ${email}. Remove BOOTSTRAP_ADMIN_PASSWORD from the environment now.`);
    });
  } catch (e) {
    console.warn(`[bootstrap] skipped: ${(e as Error).message}`);
  }
}

/** On every start: make sure each organisation has its alert rules, taxonomy and rubric (idempotent, never overwrites edits). */
export async function ensureAllOrgDefaults() {
  try {
    await withSystem(async (db) => {
      const orgs = await db.query<{ id: string }>(`SELECT id FROM organizations`);
      for (const o of orgs) await ensureOrgDefaults(db, o.id);
    });
  } catch (e) {
    console.warn(`[bootstrap] org defaults check skipped: ${(e as Error).message}`);
  }
}
