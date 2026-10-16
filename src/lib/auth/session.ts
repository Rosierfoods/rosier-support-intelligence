import 'server-only';
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import { withSystem, withOrg, type Db } from '@/lib/db';
import { randomToken, sha256Hex } from '@/lib/crypto';
import { dataScopeFor, resolvePermissions, type DataScope, type Permission } from './rbac';
import { audit } from '@/lib/audit';
import { DEFAULT_ORG_SETTINGS, type OrgSettings, type Role } from '@/lib/constants';

export const SESSION_COOKIE = 'rsi_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS ?? 12);
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface SessionUser {
  id: string; email: string; name: string; role: Role; teamId: string | null; agentId: string | null; mfaEnabled: boolean;
}
export interface Session {
  id: string;
  user: SessionUser;
  org: { id: string; name: string; settings: OrgSettings };
  permissions: Set<Permission>;
  scope: DataScope;
  mfaVerified: boolean;
}

export async function requestMeta() {
  const h = await headers();
  return {
    ip: (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'local',
    userAgent: (h.get('user-agent') ?? '').slice(0, 300),
  };
}

export function mergeSettings(s: Partial<OrgSettings> | null | undefined): OrgSettings {
  const d = DEFAULT_ORG_SETTINGS;
  const v = (s ?? {}) as any;
  return {
    ...d, ...v,
    businessHours: { ...d.businessHours, ...(v.businessHours ?? {}) },
    sla: { ...d.sla, ...(v.sla ?? {}), firstResponseMinutes: { ...d.sla.firstResponseMinutes, ...(v.sla?.firstResponseMinutes ?? {}) } },
    rubric: { default: { ...d.rubric.default, ...(v.rubric?.default ?? {}) }, overrides: v.rubric?.overrides ?? {} },
    retention: { ...d.retention, ...(v.retention ?? {}) },
    ai: { ...d.ai, ...(v.ai ?? {}) },
    notifications: { ...d.notifications, ...(v.notifications ?? {}) },
    scoreBands: Array.isArray(v.scoreBands) && v.scoreBands.length ? v.scoreBands : d.scoreBands,
  };
}

/** Loads the current session (once per request). Returns null when signed out. */
export const getSession = cache(async (): Promise<Session | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const row = await withSystem((db) =>
    db.one(
      `SELECT s.id AS session_id, s.mfa_verified, s.expires_at, u.id, u.email, u.name, u.role, u.team_id, u.agent_id,
              u.mfa_enabled, u.is_active, o.id AS org_id, o.name AS org_name, o.settings
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = s.org_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash],
    ),
  );
  if (!row || !row.is_active) return null;
  const overrides = await withOrg(row.org_id, (db) =>
    db.query('SELECT permission, allowed FROM role_permissions WHERE role = $1', [row.role]),
  );
  // sliding expiry, at most once every 10 minutes
  void withSystem((db) =>
    db.exec(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' hours')::interval
        WHERE id = $1 AND last_seen_at < now() - interval '10 minutes'`,
      [row.session_id, String(SESSION_HOURS)],
    ),
  ).catch(() => {});
  return {
    id: row.session_id,
    mfaVerified: row.mfa_verified,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, teamId: row.team_id, agentId: row.agent_id, mfaEnabled: row.mfa_enabled },
    org: { id: row.org_id, name: row.org_name, settings: mergeSettings(row.settings) },
    permissions: resolvePermissions(row.role, overrides),
    scope: dataScopeFor(row.role),
  };
});

/** For pages: redirects to /login when signed out or when MFA is pending. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  if (s.user.mfaEnabled && !s.mfaVerified) redirect('/login/mfa');
  return s;
}

export async function requirePermission(p: Permission): Promise<Session> {
  const s = await requireSession();
  if (!s.permissions.has(p)) redirect('/forbidden');
  return s;
}

export function can(s: Session, p: Permission) {
  return s.permissions.has(p);
}

/** Throwing variant for server actions / route handlers. */
export async function assertPermission(p: Permission): Promise<Session> {
  const s = await getSession();
  if (!s || (s.user.mfaEnabled && !s.mfaVerified)) throw new Error('Not signed in');
  if (!s.permissions.has(p)) throw new Error('You do not have permission to do this.');
  return s;
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must include letters and numbers.';
  return null;
}

let dummyHash: string | undefined;

export type LoginResult = { ok: true; mfaRequired: boolean } | { ok: false; error: string };

export async function loginWithPassword(email: string, password: string): Promise<LoginResult> {
  const meta = await requestMeta();
  const user = await withSystem((db) =>
    db.one('SELECT id, org_id, password_hash, is_active, mfa_enabled, failed_login_count, locked_until FROM users WHERE email = $1', [email.trim().toLowerCase()]),
  );
  const generic = { ok: false as const, error: 'Incorrect email or password.' };
  if (!user || !user.is_active) {
    dummyHash ??= bcrypt.hashSync('timing-equaliser', 12);
    await bcrypt.compare(password, dummyHash); // keep response time similar for unknown accounts
    return generic;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false, error: 'Account temporarily locked after repeated failed sign-ins. Try again in a few minutes.' };
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await withSystem(async (db) => {
      await db.exec(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
           locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1`,
        [user.id, MAX_FAILED, String(LOCK_MINUTES)],
      );
      await audit(db, user.org_id, user.id, 'auth.login_failed', 'user', user.id, {}, meta);
    });
    return generic;
  }
  const token = randomToken(32);
  await withSystem(async (db) => {
    await db.exec('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await db.exec(
      `INSERT INTO sessions (org_id, user_id, token_hash, mfa_verified, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)`,
      [user.org_id, user.id, sha256Hex(token), !user.mfa_enabled, meta.ip, meta.userAgent, String(SESSION_HOURS)],
    );
    await db.exec('DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()', [user.id]);
    await audit(db, user.org_id, user.id, 'auth.login', 'user', user.id, { mfa_pending: user.mfa_enabled }, meta);
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' && !process.env.ALLOW_INSECURE_COOKIES,
    path: '/', maxAge: SESSION_HOURS * 3600,
  });
  return { ok: true, mfaRequired: user.mfa_enabled };
}

export async function markMfaVerified(sessionId: string) {
  await withSystem((db) => db.exec('UPDATE sessions SET mfa_verified = true WHERE id = $1', [sessionId]));
}

export async function logout() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    const s = await getSession();
    const meta = await requestMeta();
    await withSystem(async (db) => {
      await db.exec('DELETE FROM sessions WHERE token_hash = $1', [sha256Hex(token)]);
      if (s) await audit(db, s.org.id, s.user.id, 'auth.logout', 'user', s.user.id, {}, meta);
    });
  }
  (await cookies()).delete(SESSION_COOKIE);
}

/** Convenience: audit from a server action using the current session. */
export async function auditAction(db: Db, s: Session, action: string, targetType: string | null, targetId: string | null, details: Record<string, unknown> = {}) {
  let meta: { ip?: string; userAgent?: string } = {};
  try { meta = await requestMeta(); } catch { /* outside a request */ }
  await audit(db, s.org.id, s.user.id, action, targetType, targetId, details, meta);
}

export { audit };
