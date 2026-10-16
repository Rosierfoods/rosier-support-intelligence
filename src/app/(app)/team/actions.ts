'use server';
import { revalidatePath } from 'next/cache';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { assertPermission, auditAction, hashPassword, validatePasswordStrength, type Session } from '@/lib/auth/session';
import { withOrg, type Db } from '@/lib/db';
import { randomToken } from '@/lib/crypto';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, type Permission } from '@/lib/auth/rbac';
import { ROLES, type Role } from '@/lib/constants';
import type { ActionResult } from '@/components/analytics/ActionForm';

const uuid = z.string().uuid();
const optUuid = z.union([z.literal(''), uuid]).optional().transform((v) => v || null);
const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message ?? 'Check the form.' : (e as Error).message });

function tempPassword() {
  for (;;) {
    const p = `${randomToken(9).replace(/[-_]/g, 'x')}${randomInt(10, 99)}`;
    if (!validatePasswordStrength(p)) return p;
  }
}

async function guard(): Promise<Session> { return assertPermission('team.manage'); }

/** Only a super admin may create, edit or grant the super-admin role. */
function assertCanTouchRole(s: Session, role: string) {
  if (role === 'super_admin' && s.user.role !== 'super_admin') throw new Error('Only a Super Admin can manage Super Admin accounts.');
}

async function assertSuperAdminRemains(db: Db, exceptUserId: string) {
  const r = await db.one<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE role = 'super_admin' AND is_active AND id <> $1`, [exceptUserId]);
  if (!r?.c) throw new Error('At least one active Super Admin must remain.');
}

/** Keep users.agent_id and agents.user_id consistent (1:1). */
async function linkUserAgent(db: Db, userId: string, agentId: string | null) {
  await db.exec(`UPDATE agents SET user_id = NULL WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)`, [userId, agentId]);
  if (agentId) {
    await db.exec(`UPDATE users SET agent_id = NULL WHERE agent_id = $1 AND id <> $2`, [agentId, userId]);
    await db.exec(`UPDATE agents SET user_id = $2 WHERE id = $1`, [agentId, userId]);
  }
  await db.exec(`UPDATE users SET agent_id = $2 WHERE id = $1`, [userId, agentId]);
}

// ───────────────────────── Users ─────────────────────────
const userSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email.').max(200),
  name: z.string().trim().min(2, 'Enter the person’s name.').max(120),
  role: z.enum(ROLES),
  teamId: optUuid,
  agentId: optUuid,
});

export async function createUser(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = userSchema.parse(Object.fromEntries(fd));
    assertCanTouchRole(s, v.role);
    const pw = tempPassword();
    const hash = await hashPassword(pw);
    await withOrg(s.org.id, async (db) => {
      const exists = await db.one(`SELECT 1 FROM users WHERE email = $1`, [v.email]);
      if (exists) throw new Error('A user with this email already exists.');
      const u = await db.one<{ id: string }>(
        `INSERT INTO users (org_id, email, name, password_hash, role, team_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [s.org.id, v.email, v.name, hash, v.role, v.teamId]);
      if (v.agentId) await linkUserAgent(db, u!.id, v.agentId);
      await auditAction(db, s, 'user.create', 'user', u!.id, { email: v.email, role: v.role, team_id: v.teamId, agent_id: v.agentId });
    });
    revalidatePath('/team');
    return { ok: true, message: `${v.name} can now sign in with ${v.email}.`, secret: pw };
  } catch (e) { return fail(e); }
}

const updateUserSchema = userSchema.omit({ email: true }).extend({ id: uuid });

export async function updateUser(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = updateUserSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const cur = await db.one<{ role: Role; team_id: string | null; agent_id: string | null }>(`SELECT role, team_id, agent_id FROM users WHERE id = $1 FOR UPDATE`, [v.id]);
      if (!cur) throw new Error('User not found.');
      assertCanTouchRole(s, cur.role); assertCanTouchRole(s, v.role);
      if (v.id === s.user.id && v.role !== cur.role) throw new Error('You cannot change your own role.');
      if (cur.role === 'super_admin' && v.role !== 'super_admin') await assertSuperAdminRemains(db, v.id);
      await db.exec(`UPDATE users SET name = $2, role = $3, team_id = $4 WHERE id = $1`, [v.id, v.name, v.role, v.teamId]);
      if (v.agentId !== cur.agent_id) await linkUserAgent(db, v.id, v.agentId);
      if (v.role !== cur.role) await db.exec(`DELETE FROM sessions WHERE user_id = $1 AND user_id <> $2`, [v.id, s.user.id]);
      await auditAction(db, s, 'user.update', 'user', v.id, {
        before: { role: cur.role, team_id: cur.team_id, agent_id: cur.agent_id }, after: { role: v.role, team_id: v.teamId, agent_id: v.agentId },
      });
    });
    revalidatePath('/team');
    return { ok: true, message: 'User updated.' };
  } catch (e) { return fail(e); }
}

const idOnly = z.object({ id: uuid });

export async function setUserActive(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = idOnly.extend({ active: z.enum(['true', 'false']) }).parse(Object.fromEntries(fd));
    const active = v.active === 'true';
    await withOrg(s.org.id, async (db) => {
      const cur = await db.one<{ role: Role }>(`SELECT role FROM users WHERE id = $1 FOR UPDATE`, [v.id]);
      if (!cur) throw new Error('User not found.');
      assertCanTouchRole(s, cur.role);
      if (!active && v.id === s.user.id) throw new Error('You cannot deactivate your own account.');
      if (!active && cur.role === 'super_admin') await assertSuperAdminRemains(db, v.id);
      await db.exec(`UPDATE users SET is_active = $2 WHERE id = $1`, [v.id, active]);
      if (!active) await db.exec(`DELETE FROM sessions WHERE user_id = $1`, [v.id]);
      await auditAction(db, s, active ? 'user.activate' : 'user.deactivate', 'user', v.id, {});
    });
    revalidatePath('/team');
    return { ok: true, message: active ? 'User activated.' : 'User deactivated and signed out everywhere.' };
  } catch (e) { return fail(e); }
}

export async function resetUserPassword(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = idOnly.parse(Object.fromEntries(fd));
    const pw = tempPassword();
    const hash = await hashPassword(pw);
    await withOrg(s.org.id, async (db) => {
      const cur = await db.one<{ role: Role }>(`SELECT role FROM users WHERE id = $1`, [v.id]);
      if (!cur) throw new Error('User not found.');
      assertCanTouchRole(s, cur.role);
      if (v.id === s.user.id) throw new Error('Change your own password from your Profile page.');
      await db.exec(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [v.id, hash]);
      await db.exec(`DELETE FROM sessions WHERE user_id = $1`, [v.id]);
      await auditAction(db, s, 'user.password_reset', 'user', v.id, {});
    });
    revalidatePath('/team');
    return { ok: true, secret: pw, secretLabel: 'New temporary password', message: 'Password reset; the user was signed out and the account unlocked.' };
  } catch (e) { return fail(e); }
}

export async function resetUserMfa(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = idOnly.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const cur = await db.one<{ role: Role; mfa_enabled: boolean }>(`SELECT role, mfa_enabled FROM users WHERE id = $1`, [v.id]);
      if (!cur) throw new Error('User not found.');
      assertCanTouchRole(s, cur.role);
      await db.exec(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1`, [v.id]);
      await db.exec(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [v.id, s.id]);
      await auditAction(db, s, 'user.mfa_reset', 'user', v.id, { was_enabled: cur.mfa_enabled });
    });
    revalidatePath('/team');
    return { ok: true, message: 'Two-factor authentication removed. The user can enrol again from their profile.' };
  } catch (e) { return fail(e); }
}

export async function unlockUser(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = idOnly.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      await db.exec(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [v.id]);
      await auditAction(db, s, 'user.unlock', 'user', v.id, {});
    });
    revalidatePath('/team'); revalidatePath('/audit');
    return { ok: true, message: 'Account unlocked.' };
  } catch (e) { return fail(e); }
}

// ───────────────────────── Teams ─────────────────────────
const teamSchema = z.object({
  id: optUuid,
  name: z.string().trim().min(2, 'Team name is required.').max(80),
  description: z.string().trim().max(300).optional().transform((v) => v || null),
  leadUserId: optUuid,
});

export async function saveTeam(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = teamSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      const dup = await db.one(`SELECT 1 FROM teams WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`, [v.name, v.id]);
      if (dup) throw new Error('Another team already has this name.');
      let teamId = v.id;
      if (teamId) {
        const n = await db.exec(`UPDATE teams SET name = $2, description = $3, lead_user_id = $4 WHERE id = $1`, [teamId, v.name, v.description, v.leadUserId]);
        if (!n) throw new Error('Team not found.');
        await auditAction(db, s, 'team.update', 'team', teamId, { name: v.name, lead_user_id: v.leadUserId });
      } else {
        const t = await db.one<{ id: string }>(`INSERT INTO teams (org_id, name, description, lead_user_id) VALUES ($1,$2,$3,$4) RETURNING id`, [s.org.id, v.name, v.description, v.leadUserId]);
        teamId = t!.id;
        await auditAction(db, s, 'team.create', 'team', teamId, { name: v.name, lead_user_id: v.leadUserId });
      }
      // A team leader's data scope comes from users.team_id — give the lead this team if they have none.
      if (v.leadUserId) await db.exec(`UPDATE users SET team_id = coalesce(team_id, $2) WHERE id = $1`, [v.leadUserId, teamId]);
    });
    revalidatePath('/team');
    return { ok: true, message: v.id ? 'Team saved.' : 'Team created.' };
  } catch (e) { return fail(e); }
}

// ───────────────────────── Agents ─────────────────────────
const extIds = z.string().trim().max(2000).optional().transform((v, ctx) => {
  if (!v) return {} as Record<string, string>;
  try {
    const o = JSON.parse(v);
    const parsed = z.record(z.string().regex(/^[a-z0-9_]{2,40}$/, 'Provider keys must be lowercase, e.g. "myoperator"'), z.string().trim().min(1).max(200)).parse(o);
    return parsed;
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: e instanceof z.ZodError ? e.issues[0].message : 'External IDs must be JSON, e.g. {"myoperator":"1234","limechat":"ag_55"}' });
    return z.NEVER;
  }
});
const agentSchema = z.object({
  id: optUuid,
  name: z.string().trim().min(2, 'Agent name is required.').max(120),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email or leave blank.')]).optional().transform((v) => v || null),
  teamId: optUuid,
  userId: optUuid,
  externalIds: extIds,
  active: z.enum(['true', 'false']).optional().default('true'),
});

export async function saveAgent(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const v = agentSchema.parse(Object.fromEntries(fd));
    await withOrg(s.org.id, async (db) => {
      // External IDs must map to exactly one agent per provider, or imports would be ambiguous.
      for (const [provider, ext] of Object.entries(v.externalIds)) {
        const clash = await db.one<{ name: string }>(`SELECT name FROM agents WHERE external_ids->>$1 = $2 AND ($3::uuid IS NULL OR id <> $3)`, [provider, ext, v.id]);
        if (clash) throw new Error(`${provider} ID "${ext}" is already mapped to ${clash.name}.`);
      }
      let id = v.id;
      if (id) {
        const n = await db.exec(`UPDATE agents SET name = $2, email = $3, team_id = $4, external_ids = $5, is_active = $6 WHERE id = $1`,
          [id, v.name, v.email, v.teamId, JSON.stringify(v.externalIds), v.active === 'true']);
        if (!n) throw new Error('Agent not found.');
      } else {
        const a = await db.one<{ id: string }>(`INSERT INTO agents (org_id, name, email, team_id, external_ids, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [s.org.id, v.name, v.email, v.teamId, JSON.stringify(v.externalIds), v.active === 'true']);
        id = a!.id;
      }
      const cur = await db.one<{ user_id: string | null }>(`SELECT user_id FROM agents WHERE id = $1`, [id]);
      if ((cur?.user_id ?? null) !== v.userId) {
        if (cur?.user_id) await db.exec(`UPDATE users SET agent_id = NULL WHERE id = $1`, [cur.user_id]);
        await db.exec(`UPDATE agents SET user_id = NULL WHERE id = $1`, [id]);
        if (v.userId) await linkUserAgent(db, v.userId, id);
      }
      await auditAction(db, s, v.id ? 'agent.update' : 'agent.create', 'agent', id, {
        name: v.name, team_id: v.teamId, user_id: v.userId, providers: Object.keys(v.externalIds), active: v.active === 'true',
      });
    });
    revalidatePath('/team');
    return { ok: true, message: v.id ? 'Agent saved.' : 'Agent created.' };
  } catch (e) { return fail(e); }
}

// ───────────────────────── Role permission overrides ─────────────────────────
export async function saveRolePermissions(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await guard();
    const changes: { role: Role; permission: Permission; value: 'default' | 'allow' | 'deny' }[] = [];
    for (const [k, raw] of Array.from(fd.entries())) {
      if (!k.startsWith('perm:')) continue;
      const [, role, permission] = k.split(':');
      const value = String(raw);
      if (!(ROLES as readonly string[]).includes(role) || role === 'super_admin') continue;
      if (!(PERMISSIONS as readonly string[]).includes(permission)) continue;
      if (!['default', 'allow', 'deny'].includes(value)) continue;
      changes.push({ role: role as Role, permission: permission as Permission, value: value as any });
    }
    let changed = 0;
    await withOrg(s.org.id, async (db) => {
      const current = await db.query<{ role: string; permission: string; allowed: boolean }>(`SELECT role, permission, allowed FROM role_permissions`);
      const curMap = new Map(current.map((c) => [`${c.role}:${c.permission}`, c.allowed]));
      const diff: Record<string, string> = {};
      for (const c of changes) {
        const key = `${c.role}:${c.permission}`;
        const before = curMap.has(key) ? (curMap.get(key) ? 'allow' : 'deny') : 'default';
        // An override equal to the role default is stored as "default".
        const defaultAllowed = DEFAULT_ROLE_PERMISSIONS[c.role].has(c.permission);
        const target = c.value === 'default' || (c.value === 'allow') === defaultAllowed ? 'default' : c.value;
        if (target === before) continue;
        if (c.role === s.user.role && c.permission === 'team.manage' && target === 'deny') throw new Error('You cannot remove Team Management from your own role.');
        if (target === 'default') await db.exec(`DELETE FROM role_permissions WHERE role = $1 AND permission = $2`, [c.role, c.permission]);
        else await db.exec(
          `INSERT INTO role_permissions (org_id, role, permission, allowed, updated_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, role, permission) DO UPDATE SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by`,
          [s.org.id, c.role, c.permission, target === 'allow', s.user.id]);
        diff[key] = `${before} → ${target}`;
        changed++;
      }
      if (changed) await auditAction(db, s, 'permissions.update', 'role_permissions', null, { changes: diff });
    });
    revalidatePath('/', 'layout');
    return { ok: true, message: changed ? `${changed} permission change${changed > 1 ? 's' : ''} saved. They apply on each user’s next request.` : 'No changes.' };
  } catch (e) { return fail(e); }
}
