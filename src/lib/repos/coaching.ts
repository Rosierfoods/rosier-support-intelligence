import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { isUuid } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeAgents } from '@/lib/repos/scope';
import { whereOf } from '@/lib/repos/analytics';
import { DEFAULT_CRITERIA } from '@/lib/constants';

/** Coaching workflow (spec §14): assigned → acknowledged → in_progress → completed → reviewed (or cancelled). */
export const COACHING_FLOW = ['assigned', 'acknowledged', 'in_progress', 'completed', 'reviewed'] as const;
export const COACHING_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', assigned: 'Assigned', acknowledged: 'Acknowledged', in_progress: 'In progress', completed: 'Completed', reviewed: 'Reviewed', cancelled: 'Cancelled',
};
export const OPEN_COACHING = ['assigned', 'acknowledged', 'in_progress'];

export const COACHING_METRIC_DEFS: Record<string, string> = {
  completion: 'Coaching actions completed or reviewed ÷ all non-cancelled, non-draft actions in your scope.',
  improved: 'Reviewed actions with outcome "improved" ÷ reviewed actions with an outcome.',
  delta: 'Mean (measured value at review − baseline) for reviewed actions where both are recorded. Both on a 0–100 scale.',
  overdue: 'Open actions (or completed but not yet reviewed) whose review date is in the past.',
  measured: 'Mean of the target metric on the agent’s interactions that occurred after the coaching was assigned. quality_score = overall score (0–100); a criterion code = that criterion’s mean score converted to 0–100 (score ÷ 5 × 100). Current evaluations only (human preferred over AI).',
};

/** Caller can see everyone's coaching in their scope, or only their own. */
export function coachingScope(s: Session, b: SqlBuilder, expr = 'ca.agent_id') {
  if (s.permissions.has('coaching.view_all') || s.permissions.has('coaching.assign')) return scopeAgents(s, b, expr);
  return s.user.agentId ? `${expr} = ${b.p(s.user.agentId)}` : 'FALSE';
}

export interface CoachingListFilters { status?: string | null; agentId?: string | null; source?: string | null; overdue?: boolean; page: number; pageSize: number }

export async function listCoaching(db: Db, s: Session, f: CoachingListFilters) {
  const b = new SqlBuilder();
  const conds = [coachingScope(s, b)];
  if (f.status === 'open') conds.push(`ca.status = ANY(${b.p(OPEN_COACHING)})`);
  else if (f.status) conds.push(`ca.status = ${b.p(f.status)}`);
  if (f.agentId && isUuid(f.agentId)) conds.push(`ca.agent_id = ${b.p(f.agentId)}`);
  if (f.source === 'ai' || f.source === 'manual') conds.push(`ca.source = ${b.p(f.source)}`);
  if (f.overdue) conds.push(`ca.review_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND ca.status IN ('assigned','acknowledged','in_progress','completed')`);
  const where = whereOf(conds);
  const total = await db.one<{ c: number }>(`SELECT count(*)::int AS c FROM coaching_actions ca ${where}`, b.params);
  const rows = await db.query(
    `SELECT ca.id, ca.title, ca.status, ca.source, ca.review_date, ca.target_metric, ca.target_value, ca.baseline_value, ca.created_at, ca.is_demo,
            ca.flag_id, ca.interaction_id, a.id AS agent_id, a.name AS agent, t.name AS team,
            asg.assigned_at, asg.acknowledged_at, asg.completed_at, asg.reviewed_at, asg.outcome, asg.outcome_value,
            (ca.review_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND ca.status IN ('assigned','acknowledged','in_progress','completed')) AS overdue,
            fl.severity AS flag_severity
       FROM coaching_actions ca JOIN agents a ON a.id = ca.agent_id LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN LATERAL (SELECT * FROM coaching_assignments x WHERE x.coaching_action_id = ca.id ORDER BY x.assigned_at DESC LIMIT 1) asg ON true
       LEFT JOIN quality_flags fl ON fl.id = ca.flag_id
      ${where}
      ORDER BY overdue DESC, CASE ca.status WHEN 'assigned' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'completed' THEN 3 WHEN 'reviewed' THEN 4 ELSE 5 END,
               ca.review_date NULLS LAST, ca.created_at DESC
      LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`, b.params);
  return { rows, total: total?.c ?? 0 };
}

export async function getCoachingSummary(db: Db, s: Session, opts: { agentId?: string | null; from?: Date; to?: Date } = {}) {
  const b = new SqlBuilder();
  const conds = [coachingScope(s, b), `ca.status NOT IN ('draft','cancelled')`];
  if (opts.agentId && isUuid(opts.agentId)) conds.push(`ca.agent_id = ${b.p(opts.agentId)}`);
  if (opts.from) conds.push(`ca.created_at >= ${b.p(opts.from)}`);
  if (opts.to) conds.push(`ca.created_at <= ${b.p(opts.to)}`);
  return (await db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ca.status = ANY(${b.p(OPEN_COACHING)}))::int AS open,
            count(*) FILTER (WHERE ca.status IN ('completed','reviewed'))::int AS completed,
            count(*) FILTER (WHERE ca.status = 'reviewed')::int AS reviewed,
            count(*) FILTER (WHERE asg.outcome = 'improved')::int AS improved,
            count(*) FILTER (WHERE asg.outcome IS NOT NULL)::int AS with_outcome,
            avg(asg.outcome_value - ca.baseline_value) FILTER (WHERE asg.outcome_value IS NOT NULL AND ca.baseline_value IS NOT NULL) AS avg_delta,
            count(*) FILTER (WHERE asg.outcome_value IS NOT NULL AND ca.baseline_value IS NOT NULL)::int AS delta_n,
            count(*) FILTER (WHERE ca.review_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND ca.status IN ('assigned','acknowledged','in_progress','completed'))::int AS overdue,
            coalesce(bool_or(ca.is_demo), false) AS has_demo
       FROM coaching_actions ca
       LEFT JOIN LATERAL (SELECT * FROM coaching_assignments x WHERE x.coaching_action_id = ca.id ORDER BY x.assigned_at DESC LIMIT 1) asg ON true
      ${whereOf(conds)}`, b.params)) as Record<string, any>;
}

export async function getCoaching(db: Db, s: Session, id: string) {
  if (!isUuid(id)) return null;
  const b = new SqlBuilder();
  return db.one(
    `SELECT ca.*, to_char(ca.review_date, 'YYYY-MM-DD') AS review_date_str, a.name AS agent, a.user_id AS agent_user_id, a.team_id, t.name AS team, cu.name AS created_by_name,
            asg.id AS assignment_id, asg.goal, asg.assigned_at, asg.acknowledged_at, asg.agent_comment, asg.completed_at, asg.reviewed_at,
            asg.outcome, asg.outcome_value, asg.outcome_notes, asg.assigned_by, au.name AS assigned_by_name, ru.name AS reviewed_by_name,
            fl.title AS flag_title, fl.severity AS flag_severity, fl.status AS flag_status, fl.rule_code AS flag_rule,
            i.ref AS interaction_ref, i.channel AS interaction_channel, i.occurred_at AS interaction_at,
            kv.version AS kb_version, ka.title AS kb_title, ka.id AS kb_article_id
       FROM coaching_actions ca JOIN agents a ON a.id = ca.agent_id LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN users cu ON cu.id = ca.created_by
       LEFT JOIN LATERAL (SELECT * FROM coaching_assignments x WHERE x.coaching_action_id = ca.id ORDER BY x.assigned_at DESC LIMIT 1) asg ON true
       LEFT JOIN users au ON au.id = asg.assigned_by LEFT JOIN users ru ON ru.id = asg.reviewed_by
       LEFT JOIN quality_flags fl ON fl.id = ca.flag_id
       LEFT JOIN interactions i ON i.id = ca.interaction_id
       LEFT JOIN knowledge_base_versions kv ON kv.id = ca.policy_version_id LEFT JOIN knowledge_base_articles ka ON ka.id = kv.article_id
      WHERE ca.id = ${b.p(id)} AND ${coachingScope(s, b)}`, b.params);
}

export function metricLabel(code: string | null | undefined) {
  if (!code || code === 'quality_score') return 'Overall quality score';
  return DEFAULT_CRITERIA.find((c) => c.code === code)?.name ?? code;
}

/**
 * Measure the agent's target metric on interactions in a window (0–100 scale).
 * quality_score → mean interactions.quality_score; criterion code → mean criterion score × 20.
 */
export async function measureMetric(db: Db, agentId: string, metric: string | null, from: Date, to: Date = new Date()) {
  if (!metric || metric === 'quality_score') {
    const r = await db.one<{ v: number | null; n: number }>(
      `SELECT round(avg(quality_score), 1)::float AS v, count(quality_score)::int AS n FROM interactions
        WHERE agent_id = $1 AND occurred_at > $2 AND occurred_at <= $3`, [agentId, from, to]);
    return { value: r?.v ?? null, n: r?.n ?? 0 };
  }
  const r = await db.one<{ v: number | null; n: number }>(
    `WITH ev AS (
       SELECT DISTINCT ON (e.interaction_id) e.criterion_scores FROM quality_evaluations e JOIN interactions i ON i.id = e.interaction_id
        WHERE i.agent_id = $1 AND i.occurred_at > $2 AND i.occurred_at <= $3 AND e.is_current
        ORDER BY e.interaction_id, (e.evaluator_type = 'human') DESC, e.created_at DESC)
     SELECT round(avg((cs->>'score')::numeric) * 20, 1)::float AS v, count(*)::int AS n
       FROM ev, jsonb_array_elements(ev.criterion_scores) cs
      WHERE cs->>'code' = $4 AND coalesce((cs->>'na')::boolean, false) = false AND jsonb_typeof(cs->'score') = 'number'`, [agentId, from, to, metric]);
  return { value: r?.v ?? null, n: r?.n ?? 0 };
}

export async function getFlagForCoaching(db: Db, s: Session, flagId: string) {
  if (!isUuid(flagId)) return null;
  const b = new SqlBuilder();
  return db.one(
    `SELECT fl.id, fl.status, fl.severity, fl.title, fl.rule_code, fl.criterion_code, fl.agent_id, fl.interaction_id, fl.is_demo, fl.excerpt,
            a.name AS agent, a.user_id AS agent_user_id, i.ref, i.channel, i.occurred_at,
            (SELECT ca.id FROM coaching_actions ca WHERE ca.flag_id = fl.id AND ca.status <> 'cancelled' LIMIT 1) AS existing_coaching_id
       FROM quality_flags fl JOIN interactions i ON i.id = fl.interaction_id LEFT JOIN agents a ON a.id = fl.agent_id
      WHERE fl.id = ${b.p(flagId)} AND ${scopeAgents(s, b, 'fl.agent_id')}`, b.params);
}

/** Users to notify for an agent: the linked user (agents.user_id or users.agent_id). */
export async function agentUserIds(db: Db, agentId: string) {
  const rows = await db.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.is_active AND (u.agent_id = $1 OR u.id = (SELECT user_id FROM agents WHERE id = $1))`, [agentId]);
  return rows.map((r) => r.id);
}

export async function coachingAgentOptions(db: Db, s: Session) {
  const b = new SqlBuilder();
  return db.query<{ id: string; name: string }>(`SELECT a.id, a.name FROM agents a WHERE ${coachingScope(s, b, 'a.id')} ORDER BY a.name`, b.params);
}

export async function criterionOptions(db: Db) {
  const rows = await db.query<{ code: string; name: string }>(`SELECT code, name FROM quality_criteria WHERE is_active ORDER BY sort, name`);
  return rows.length ? rows : DEFAULT_CRITERIA.map((c) => ({ code: c.code, name: c.name }));
}
