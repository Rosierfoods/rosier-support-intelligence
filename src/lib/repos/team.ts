import type { Db } from '@/lib/db';
import { isUuid } from '@/lib/db';
import { SqlBuilder, escapeLike } from '@/lib/sql';
import { whereOf } from '@/lib/repos/analytics';

/**
 * Team management, audit/security and settings queries (admin areas).
 * All run inside withOrg (RLS confines them to the caller's organisation); callers check permissions.
 */

export async function listUsers(db: Db) {
  return db.query(
    `SELECT u.id, u.email, u.name, u.role, u.team_id, t.name AS team, u.agent_id, a.name AS agent, u.is_active, u.mfa_enabled,
            u.locked_until > now() AS locked, u.failed_login_count, u.last_login_at, u.is_demo, u.created_at,
            (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS active_sessions
       FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN agents a ON a.id = u.agent_id
      ORDER BY u.is_active DESC, u.name`);
}

export async function listTeams(db: Db) {
  return db.query(
    `SELECT t.id, t.name, t.description, t.lead_user_id, lu.name AS lead, t.is_demo,
            (SELECT count(*) FROM users u WHERE u.team_id = t.id AND u.is_active)::int AS users,
            (SELECT count(*) FROM agents a WHERE a.team_id = t.id AND a.is_active)::int AS agents
       FROM teams t LEFT JOIN users lu ON lu.id = t.lead_user_id ORDER BY t.name`);
}

export async function listAgentsAdmin(db: Db) {
  return db.query(
    `SELECT a.id, a.name, a.email, a.team_id, t.name AS team, a.user_id, u.email AS user_email, a.external_ids, a.is_active, a.is_demo,
            (SELECT count(*) FROM interactions i WHERE i.agent_id = a.id)::int AS interactions
       FROM agents a LEFT JOIN teams t ON t.id = a.team_id LEFT JOIN users u ON u.id = a.user_id ORDER BY a.is_active DESC, a.name`);
}

export async function getRoleOverrides(db: Db) {
  return db.query<{ role: string; permission: string; allowed: boolean; updated_at: string; updated_by_name: string | null }>(
    `SELECT rp.role, rp.permission, rp.allowed, rp.updated_at, u.name AS updated_by_name FROM role_permissions rp LEFT JOIN users u ON u.id = rp.updated_by`);
}

// ───────────────────────── Audit & security ─────────────────────────
export interface AuditFilters { action?: string | null; userId?: string | null; target?: string | null; from: Date; to: Date; page: number; pageSize: number }

export async function listAuditLogs(db: Db, f: AuditFilters) {
  const b = new SqlBuilder();
  const conds = [`l.created_at >= ${b.p(f.from)}`, `l.created_at <= ${b.p(f.to)}`];
  if (f.action) conds.push(f.action.endsWith('.*') ? `l.action LIKE ${b.p(escapeLike(f.action.slice(0, -1)) + '%')}` : `l.action = ${b.p(f.action)}`);
  if (f.userId && isUuid(f.userId)) conds.push(`l.user_id = ${b.p(f.userId)}`);
  if (f.target) {
    const t = b.p('%' + escapeLike(f.target) + '%');
    conds.push(`(l.target_type ILIKE ${t} OR l.target_id ILIKE ${t})`);
  }
  const where = whereOf(conds);
  const total = await db.one<{ c: number }>(`SELECT count(*)::int AS c FROM audit_logs l ${where}`, b.params);
  const rows = await db.query(
    `SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.ip, l.user_agent, l.created_at, u.name AS user_name, u.email AS user_email
       FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id ${where}
      ORDER BY l.created_at DESC LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, b.params);
  return { rows, total: total?.c ?? 0 };
}

export async function auditActionOptions(db: Db) {
  const rows = await db.query<{ action: string; n: number }>(`SELECT action, count(*)::int AS n FROM audit_logs GROUP BY 1 ORDER BY 1`);
  return rows;
}

export async function listActiveSessions(db: Db) {
  return db.query(
    `SELECT s.id, s.user_id, u.name, u.email, u.role, s.ip, s.user_agent, s.mfa_verified, s.created_at, s.last_seen_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > now() ORDER BY s.last_seen_at DESC LIMIT 200`);
}

export async function securityPosture(db: Db) {
  const summary = await db.one(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active_users,
            count(*) FILTER (WHERE is_active AND mfa_enabled)::int AS mfa_users,
            count(*) FILTER (WHERE is_active AND NOT mfa_enabled AND role IN ('super_admin','crm_manager'))::int AS privileged_without_mfa,
            count(*) FILTER (WHERE locked_until > now())::int AS locked,
            (SELECT count(*) FROM audit_logs WHERE action = 'auth.login_failed' AND created_at > now() - interval '7 days')::int AS failed_7d,
            (SELECT count(*) FROM audit_logs WHERE action = 'auth.mfa_failed' AND created_at > now() - interval '7 days')::int AS mfa_failed_7d,
            (SELECT count(*) FROM audit_logs WHERE action LIKE 'export.%' AND created_at > now() - interval '30 days')::int AS exports_30d,
            (SELECT count(*) FROM sessions WHERE expires_at > now())::int AS active_sessions
       FROM users`);
  const withoutMfa = await db.query(
    `SELECT id, name, email, role, last_login_at FROM users WHERE is_active AND NOT mfa_enabled
      ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'crm_manager' THEN 1 WHEN 'team_leader' THEN 2 WHEN 'quality_analyst' THEN 3 ELSE 4 END, name`);
  const locked = await db.query(`SELECT id, name, email, locked_until, failed_login_count FROM users WHERE locked_until > now() ORDER BY locked_until DESC`);
  const failed = await db.query(
    `SELECT l.created_at, l.ip, l.user_agent, u.name, u.email, l.action FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.action IN ('auth.login_failed','auth.mfa_failed') AND l.created_at > now() - interval '7 days' ORDER BY l.created_at DESC LIMIT 20`);
  const exports = await db.query(
    `SELECT l.created_at, l.action, l.target_id, l.details, u.name FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.action LIKE 'export.%' AND l.created_at > now() - interval '30 days' ORDER BY l.created_at DESC LIMIT 20`);
  return { summary: summary as Record<string, number>, withoutMfa, locked, failed, exports };
}

// ───────────────────────── Settings ─────────────────────────
export async function getOrgRow(db: Db) {
  return db.one<{ id: string; name: string; settings: Record<string, any> }>(`SELECT id, name, settings FROM organizations LIMIT 1`);
}

export async function demoCounts(db: Db) {
  return (await db.one(
    `SELECT (SELECT count(*) FROM interactions WHERE is_demo)::int AS interactions,
            (SELECT count(*) FROM interactions WHERE is_demo AND channel = 'call')::int AS calls,
            (SELECT count(*) FROM interactions WHERE is_demo AND channel IN ('chat','whatsapp'))::int AS chats,
            (SELECT count(*) FROM interactions WHERE is_demo AND channel = 'email')::int AS emails,
            (SELECT count(*) FROM quality_flags WHERE is_demo)::int AS flags,
            (SELECT count(*) FROM coaching_actions WHERE is_demo)::int AS coaching,
            (SELECT count(*) FROM customers WHERE is_demo)::int AS customers,
            (SELECT count(*) FROM agents WHERE is_demo)::int AS agents,
            (SELECT count(*) FROM users WHERE is_demo)::int AS users,
            (SELECT count(*) FROM teams WHERE is_demo)::int AS teams,
            (SELECT count(*) FROM interactions WHERE NOT is_demo)::int AS real_interactions`)) as Record<string, number>;
}
