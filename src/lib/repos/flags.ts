import 'server-only';
import type { Db } from '@/lib/db';
import { isUuid } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { auditAction, type Session } from '@/lib/auth/session';
import { resolvePermissions } from '@/lib/auth/rbac';
import { notifyUsers, usersWithRoles } from '@/lib/notify';
import { scopeInteractions } from './scope';
import { parseRange, sp, type DateRange, type SP } from '@/lib/filters';
import { CHANNELS, FLAG_STATUSES, OPEN_FLAG_STATUSES, SEVERITIES, type Role } from '@/lib/constants';
import { recordReviewerDecision, ReviewError } from './interactions';

// ───────────────────────── Queue filters ─────────────────────────

export interface FlagFilters {
  range: DateRange; severity?: string; status?: string; agentId?: string; rule?: string; channel?: string;
  assignee?: string; // uuid | 'me' | 'unassigned'
  escalated?: boolean;
}

export function parseFlagFilters(searchParams: SP): FlagFilters {
  const status = sp(searchParams, 'status');
  const assignee = sp(searchParams, 'assignee');
  return {
    range: parseRange(searchParams, 'all'),
    severity: (SEVERITIES as readonly string[]).includes(sp(searchParams, 'severity') ?? '') ? sp(searchParams, 'severity') : undefined,
    status: status === 'open' || (FLAG_STATUSES as readonly string[]).includes(status ?? '') ? status : undefined,
    agentId: isUuid(sp(searchParams, 'agent')) ? sp(searchParams, 'agent') : undefined,
    rule: sp(searchParams, 'rule')?.slice(0, 80),
    channel: (CHANNELS as readonly string[]).includes(sp(searchParams, 'channel') ?? '') ? sp(searchParams, 'channel') : undefined,
    assignee: assignee === 'me' || assignee === 'unassigned' || isUuid(assignee) ? assignee : undefined,
    escalated: sp(searchParams, 'escalated') === '1' || undefined,
  };
}

function applyFlagFilters(s: Session, f: FlagFilters, b: SqlBuilder, opts: { skipRange?: boolean; skipStatus?: boolean } = {}) {
  b.and(scopeInteractions(s, b, 'i'));
  if (!opts.skipRange) b.and(`f.created_at >= ${b.p(f.range.from)} AND f.created_at <= ${b.p(f.range.to)}`);
  if (f.severity) b.and(`f.severity = ${b.p(f.severity)}`);
  if (!opts.skipStatus && f.status) {
    if (f.status === 'open') b.and(`f.status = ANY(${b.p(OPEN_FLAG_STATUSES)})`);
    else b.and(`f.status = ${b.p(f.status)}`);
  }
  if (f.agentId) b.and(`f.agent_id = ${b.p(f.agentId)}`);
  if (f.rule) b.and(`f.rule_code = ${b.p(f.rule)}`);
  if (f.channel) b.and(`i.channel = ${b.p(f.channel)}`);
  if (f.assignee === 'me') b.and(`f.assigned_to = ${b.p(s.user.id)}`);
  else if (f.assignee === 'unassigned') b.and('f.assigned_to IS NULL');
  else if (f.assignee) b.and(`f.assigned_to = ${b.p(f.assignee)}`);
  if (f.escalated) b.and('f.escalated');
}

const SEV_RANK = `CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export interface QueueFlag {
  id: string; interaction_id: string; ref: string; channel: string; source_platform: string; occurred_at: string; severity: string;
  rule_code: string; rule_name: string | null; title: string; reason: string; excerpt: string; evidence_ref: Record<string, any>;
  confidence: string | null; status: string; escalated: boolean; assigned_to: string | null; assignee_name: string | null;
  agent_id: string | null; agent_name: string | null; created_at: string; is_demo: boolean; primary_issue: string | null;
  criterion_name: string | null; recommended_correction: string | null;
}

export async function listFlags(db: Db, s: Session, f: FlagFilters, page: { pageSize: number; offset: number }) {
  const b = new SqlBuilder();
  applyFlagFilters(s, f, b);
  const from = `FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id`;
  const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n ${from} ${b.whereSql()}`, b.params);
  const rows = await db.query<QueueFlag>(
    `SELECT f.id, f.interaction_id, i.ref, i.channel, i.source_platform, i.occurred_at, f.severity, f.rule_code, ar.name AS rule_name,
            f.title, f.reason, f.excerpt, f.evidence_ref, f.confidence, f.status, f.escalated, f.assigned_to, u.name AS assignee_name,
            f.agent_id, a.name AS agent_name, f.created_at, f.is_demo, qc.name AS criterion_name, f.recommended_correction,
            (SELECT c.name || coalesce(' › ' || sc.name, '') FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
               LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
              WHERE l.interaction_id = i.id AND l.is_active ORDER BY l.is_primary DESC, l.created_at LIMIT 1) AS primary_issue
       ${from}
       LEFT JOIN alert_rules ar ON ar.code = f.rule_code
       LEFT JOIN quality_criteria qc ON qc.code = f.criterion_code
       LEFT JOIN users u ON u.id = f.assigned_to
       LEFT JOIN agents a ON a.id = f.agent_id
       ${b.whereSql()}
      ORDER BY (f.status = ANY(${b.p(OPEN_FLAG_STATUSES)})) DESC, ${SEV_RANK}, f.created_at DESC
      LIMIT ${Number(page.pageSize)} OFFSET ${Number(page.offset)}`,
    b.params,
  );
  return { total: total?.n ?? 0, rows };
}

export const FLAG_KPI_DEFS = {
  open: 'Alerts currently New, Under review or Confirmed (any creation date), within your data scope and the other filters.',
  newInRange: 'Alerts created in the selected date range.',
  confirmedRate: 'Of alerts created in range that a reviewer has decided (Confirmed, Coaching assigned, Resolved or False positive): share not marked False positive.',
  fpRate: 'Of alerts created in range that a reviewer has decided: share marked False positive.',
};

export async function flagKpis(db: Db, s: Session, f: FlagFilters) {
  const ob = new SqlBuilder();
  applyFlagFilters(s, { ...f, status: undefined }, ob, { skipRange: true });
  ob.and(`f.status = ANY(${ob.p(OPEN_FLAG_STATUSES)})`);
  const open = await db.query<{ severity: string; n: number }>(
    `SELECT f.severity, count(*)::int AS n FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id ${ob.whereSql()} GROUP BY 1`, ob.params);
  const rb = new SqlBuilder();
  applyFlagFilters(s, f, rb, { skipStatus: true });
  const r = await db.one<{ created: number; decided: number; fp: number; escalated: number }>(
    `SELECT count(*)::int AS created,
            count(*) FILTER (WHERE f.status IN ('confirmed','coaching_assigned','resolved','false_positive'))::int AS decided,
            count(*) FILTER (WHERE f.status = 'false_positive')::int AS fp,
            count(*) FILTER (WHERE f.escalated AND f.status = ANY(${rb.p(OPEN_FLAG_STATUSES)}))::int AS escalated
       FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id ${rb.whereSql()}`, rb.params);
  const bySev = Object.fromEntries(SEVERITIES.map((sv) => [sv, open.find((o) => o.severity === sv)?.n ?? 0])) as Record<string, number>;
  const decided = r?.decided ?? 0;
  return {
    open: bySev, openTotal: Object.values(bySev).reduce((a, b) => a + b, 0),
    newInRange: r?.created ?? 0, decided,
    confirmedRate: decided ? (decided - (r?.fp ?? 0)) / decided : null,
    fpRate: decided ? (r?.fp ?? 0) / decided : null,
    escalatedOpen: r?.escalated ?? 0,
  };
}

export async function flagFilterOptions(db: Db, s: Session) {
  const rules = await db.query<{ code: string; name: string; severity: string }>(`SELECT code, name, severity FROM alert_rules ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, name`);
  const b = new SqlBuilder();
  b.and(scopeInteractions(s, b, 'i'));
  const agents = await db.query<{ id: string; name: string }>(
    `SELECT DISTINCT a.id, a.name FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id JOIN agents a ON a.id = f.agent_id
      ${b.whereSql()} ORDER BY a.name`, b.params);
  return { rules, agents, reviewers: await listReviewers(db) };
}

/** Active users whose role (incl. org overrides) grants flags.review — candidates for reviewer assignment. */
export async function listReviewers(db: Db): Promise<{ id: string; name: string; role: Role }[]> {
  const users = await db.query<{ id: string; name: string; role: Role }>(`SELECT id, name, role FROM users WHERE is_active ORDER BY name`);
  const overrides = await db.query<{ role: string; permission: string; allowed: boolean }>(`SELECT role, permission, allowed FROM role_permissions`);
  const cache = new Map<string, boolean>();
  return users.filter((u) => {
    if (!cache.has(u.role)) cache.set(u.role, resolvePermissions(u.role, overrides.filter((o) => o.role === u.role)).has('flags.review'));
    return cache.get(u.role);
  });
}

// ───────────────────────── Mutations ─────────────────────────

export type FlagAction = 'start_review' | 'confirm' | 'false_positive' | 'resolve' | 'reopen' | 'assign' | 'escalate' | 'unassign';

/** Which permission each action needs. */
export const FLAG_ACTION_PERMISSION: Record<FlagAction, 'flags.review' | 'flags.assign'> = {
  start_review: 'flags.review', confirm: 'flags.review', false_positive: 'flags.review', reopen: 'flags.review',
  resolve: 'flags.assign', assign: 'flags.assign', unassign: 'flags.assign', escalate: 'flags.assign',
};

interface FlagState { id: string; interaction_id: string; ref: string; title: string; severity: string; status: string; assigned_to: string | null; escalated: boolean; agent_id: string | null }

async function getScopedFlag(db: Db, s: Session, flagId: string): Promise<FlagState> {
  if (!isUuid(flagId)) throw new ReviewError('Invalid alert id.');
  const b = new SqlBuilder();
  b.and(`f.id = ${b.p(flagId)}`);
  b.and(scopeInteractions(s, b, 'i'));
  const row = await db.one<FlagState>(
    `SELECT f.id, f.interaction_id, i.ref, f.title, f.severity, f.status, f.assigned_to, f.escalated, f.agent_id
       FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id ${b.whereSql()} FOR UPDATE OF f`, b.params);
  if (!row) throw new ReviewError('Alert not found or outside your data scope.');
  return row;
}

const NEXT_STATUS: Partial<Record<FlagAction, string>> = {
  start_review: 'under_review', confirm: 'confirmed', false_positive: 'false_positive', resolve: 'resolved', reopen: 'under_review',
};
const ALLOWED_FROM: Partial<Record<FlagAction, string[]>> = {
  start_review: ['new'],
  confirm: ['new', 'under_review'],
  false_positive: ['new', 'under_review', 'confirmed'],
  resolve: ['new', 'under_review', 'confirmed', 'coaching_assigned'],
  reopen: ['false_positive', 'resolved'],
};

export async function applyFlagAction(db: Db, s: Session, flagId: string, action: FlagAction, opts: { note?: string | null; assigneeId?: string | null } = {}) {
  const f = await getScopedFlag(db, s, flagId);
  const before = { status: f.status, assigned_to: f.assigned_to, escalated: f.escalated };
  const after = { ...before };
  const link = `/inbox/${f.interaction_id}?flag=${f.id}#evidence`;

  if (action in NEXT_STATUS) {
    const allowed = ALLOWED_FROM[action]!;
    if (!allowed.includes(f.status)) throw new ReviewError(`Cannot ${action.replace('_', ' ')} an alert that is ${f.status.replace('_', ' ')}.`);
    if (action === 'false_positive' && !opts.note?.trim()) throw new ReviewError('A note is required when marking a false positive.');
    after.status = NEXT_STATUS[action]!;
    await db.exec(
      `UPDATE quality_flags SET status = $2,
          acknowledged_at = coalesce(acknowledged_at, now()),
          resolved_at = CASE WHEN $2 IN ('resolved','false_positive') THEN now() WHEN $2 = 'under_review' THEN NULL ELSE resolved_at END,
          assigned_to = CASE WHEN $3 AND assigned_to IS NULL THEN $4::uuid ELSE assigned_to END
        WHERE id = $1`,
      [f.id, after.status, action === 'start_review', s.user.id]);
    if (action === 'start_review' && !f.assigned_to) after.assigned_to = s.user.id;
  } else if (action === 'assign' || action === 'unassign') {
    let assignee: { id: string; name: string } | null = null;
    if (action === 'assign') {
      if (!isUuid(opts.assigneeId)) throw new ReviewError('Choose a reviewer.');
      const reviewers = await listReviewers(db);
      assignee = reviewers.find((r) => r.id === opts.assigneeId) ?? null;
      if (!assignee) throw new ReviewError('That user cannot review alerts.');
    }
    after.assigned_to = assignee?.id ?? null;
    await db.exec(`UPDATE quality_flags SET assigned_to = $2, acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = $1`, [f.id, after.assigned_to]);
    if (assignee && assignee.id !== s.user.id) {
      await notifyUsers(db, s.org.id, [assignee.id], {
        type: 'flag.assigned', severity: f.severity, title: `Alert assigned to you: ${f.title}`,
        body: `${s.user.name} assigned a ${f.severity} alert on ${f.ref} for review.${opts.note ? ` Note: ${opts.note}` : ''}`, link,
      });
    }
  } else if (action === 'escalate') {
    if (f.escalated) throw new ReviewError('This alert is already escalated.');
    after.escalated = true;
    await db.exec(`UPDATE quality_flags SET escalated = true, acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = $1`, [f.id]);
    const managers = (await usersWithRoles(db, ['crm_manager', 'super_admin'])).filter((u) => u !== s.user.id);
    await notifyUsers(db, s.org.id, f.assigned_to && f.assigned_to !== s.user.id ? [...managers, f.assigned_to] : managers, {
      type: 'flag.escalated', severity: f.severity, title: `Escalated ${f.severity} alert: ${f.title}`,
      body: `${s.user.name} escalated an alert on ${f.ref}. AI flags are potential concerns — verify the evidence before acting.${opts.note ? ` Note: ${opts.note}` : ''}`,
      link,
    });
  }

  // tell the assignee when someone else changes the status of an alert they own
  if (action in NEXT_STATUS && f.assigned_to && f.assigned_to !== s.user.id) {
    await notifyUsers(db, s.org.id, [f.assigned_to], {
      type: 'flag.status_changed', severity: f.severity, title: `Alert ${after.status.replace('_', ' ')}: ${f.title}`,
      body: `${s.user.name} changed the status of an alert on ${f.ref}.`, link,
    });
  }

  await recordReviewerDecision(db, s, { targetType: 'flag', targetId: f.id, interactionId: f.interaction_id, decision: action, before, after, notes: opts.note ?? null });
  await auditAction(db, s, `flag.${action}`, 'quality_flag', f.id, { ref: f.ref, rule: f.title, severity: f.severity, before, after, note: opts.note ?? undefined });
  return { interactionId: f.interaction_id, after };
}
