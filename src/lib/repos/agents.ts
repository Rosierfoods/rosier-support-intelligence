import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { isUuid } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeAgents } from '@/lib/repos/scope';
import { interactionConds, NON_COMPLAINT, whereOf, type AFilters } from '@/lib/repos/analytics';
import { previousRange } from '@/lib/filters';
import { DEFAULT_CRITERIA } from '@/lib/constants';

/**
 * Agent performance (spec §13). Agents are never ranked by speed or volume alone;
 * scores with fewer than MIN_SAMPLE evaluated interactions are suppressed in the UI.
 */
export const AGENT_METRIC_DEFS: Record<string, string> = {
  calls: 'Call interactions assigned to the agent in range.',
  chats: 'Chat and WhatsApp conversations assigned to the agent in range.',
  emails: 'Email threads assigned to the agent in range.',
  missed: 'Missed calls assigned to the agent + chat/WhatsApp/email threads still awaiting an agent reply longer than the channel first-response SLA (unresolved only). Only counted where assignment data exists.',
  frt: 'Mean first_response_seconds for chat, WhatsApp and email (first customer message → first agent reply).',
  resolution: 'Mean resolution_seconds of resolved interactions.',
  quality: 'Mean current quality score (0–100) of evaluated interactions. Hidden when fewer than 5 evaluations (n shown).',
  fcr: 'Resolved interactions not reopened and with no further contact from the same customer within the repeat-contact window ÷ resolved interactions.',
  reopened: 'Interactions marked reopened ÷ interactions that were resolved or reopened.',
  csat: 'Mean CSAT (1–5) from customer feedback on the agent’s interactions. Shown only when feedback exists.',
  policy: 'Mean of the Policy compliance group score as a % of its weight, from the current evaluation of each interaction (human evaluation preferred over AI). Policy-N/A interactions excluded.',
  confirmed: 'Quality flags on the agent’s in-range interactions that a reviewer confirmed (confirmed, coaching assigned or resolved).',
  fp_rate: 'Flags marked false positive ÷ all reviewed flags (confirmed + coaching assigned + resolved + false positive). High values point at the AI, not the agent.',
  coaching: 'Coaching actions created for the agent in range (excluding drafts and cancelled).',
  improvement: 'Mean quality score in range minus mean quality score in the previous period of equal length (same filters). Shown when both periods have ≥5 evaluations.',
  complexity: 'Case mix: share of interactions carrying a high/critical-severity label or a complaint label, and mean active issue labels per interaction.',
};

export interface AgentFilters extends AFilters { teamFilter?: string | null }

export interface AgentRow {
  agent_id: string | null; name?: string; team?: string | null; team_id?: string | null; is_active?: boolean; user_id?: string | null;
  total: number; calls: number; chats: number; emails: number; missed: number;
  frt: number | null; resolution: number | null; quality: number | null; evaluated: number;
  resolved: number; fcr: number | null; reopened_rate: number | null; csat: number | null; csat_n: number;
  policy: number | null; policy_n: number; confirmed: number; fp: number; reviewed_flags: number; fp_rate: number | null;
  coaching: number; prev_quality: number | null; prev_evaluated: number;
  high_share: number | null; complaint_share: number | null; labels_per: number | null; has_demo: boolean;
}

/** SLA minutes per channel from org settings → SQL CASE, parameterised. */
function slaCase(s: Session, b: SqlBuilder, a = 'base') {
  const m = s.org.settings.sla.firstResponseMinutes;
  return `CASE ${a}.channel WHEN 'chat' THEN ${b.p(m.chat)}::int WHEN 'whatsapp' THEN ${b.p(m.whatsapp)}::int WHEN 'email' THEN ${b.p(m.email)}::int ELSE NULL END`;
}

/**
 * Core metric query. groupByAgent=false aggregates everything into one row (team averages).
 * `extraConds` constrain the agent set (scope, team, ids) via the interactions' agent_id.
 */
async function metrics(db: Db, s: Session, f: AgentFilters, opts: { groupByAgent: boolean; agentConds: (b: SqlBuilder, expr: string) => string[]; applyScope: boolean }) {
  const b = new SqlBuilder();
  // Interaction filters (date, channel, category, product) — scope handled by the agent conditions so team averages can be computed.
  const fNoAgent: AFilters = { ...f, agentId: null, teamId: null };
  const sAll = opts.applyScope ? s : ({ ...s, scope: 'all' } as Session);
  const conds = [...interactionConds(sAll, fNoAgent, b, 'i'), 'i.agent_id IS NOT NULL', ...opts.agentConds(b, 'i.agent_id')];
  const prev = previousRange({ from: f.from, to: f.to } as any);
  const prevConds = [...interactionConds(sAll, { ...fNoAgent, from: prev.from, to: prev.to }, b, 'p'), 'p.agent_id IS NOT NULL', ...opts.agentConds(b, 'p.agent_id')];
  const win = b.p(s.org.settings.repeatContactWindowDays);
  const nc = b.p(NON_COMPLAINT);
  const sla = slaCase(s, b);
  const key = opts.groupByAgent ? 'base.agent_id' : 'NULL::uuid';
  const keyF = opts.groupByAgent ? 'base.agent_id' : 'NULL::uuid';
  const rangeFrom = b.p(f.from), rangeTo = b.p(f.to);
  return db.query<AgentRow>(
    `WITH base AS (SELECT i.* FROM interactions i ${whereOf(conds)}),
     ev AS (
       SELECT DISTINCT ON (e.interaction_id) e.interaction_id, e.group_scores
         FROM quality_evaluations e JOIN base ON base.id = e.interaction_id
        WHERE e.is_current ORDER BY e.interaction_id, (e.evaluator_type = 'human') DESC, e.created_at DESC),
     lab AS (
       SELECT l.interaction_id, count(*)::int AS n, bool_or(l.severity IN ('critical','high')) AS hi, bool_or(c.code <> ALL(${nc})) AS complaint
         FROM interaction_issue_labels l JOIN base ON base.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
        WHERE l.is_active GROUP BY 1),
     cf AS (SELECT x.interaction_id, avg(x.csat) AS csat FROM customer_feedback x JOIN base ON base.id = x.interaction_id WHERE x.csat IS NOT NULL GROUP BY 1),
     fl AS (
       SELECT ${keyF} AS k,
              count(*) FILTER (WHERE f.status IN ('confirmed','coaching_assigned','resolved'))::int AS confirmed,
              count(*) FILTER (WHERE f.status = 'false_positive')::int AS fp,
              count(*) FILTER (WHERE f.status IN ('confirmed','coaching_assigned','resolved','false_positive'))::int AS reviewed_flags
         FROM quality_flags f JOIN base ON base.id = f.interaction_id GROUP BY 1),
     co AS (
       SELECT ${opts.groupByAgent ? 'ca.agent_id' : 'NULL::uuid'} AS k, count(*)::int AS coaching
         FROM coaching_actions ca WHERE ca.created_at >= ${rangeFrom} AND ca.created_at <= ${rangeTo}
          AND ca.status NOT IN ('draft','cancelled') AND ca.agent_id IN (SELECT DISTINCT agent_id FROM base) GROUP BY 1),
     pv AS (
       SELECT ${opts.groupByAgent ? 'p.agent_id' : 'NULL::uuid'} AS k, avg(p.quality_score) AS prev_quality, count(p.quality_score)::int AS prev_evaluated
         FROM interactions p ${whereOf(prevConds)} GROUP BY 1),
     agg AS (
       SELECT ${key} AS k,
         count(*)::int AS total,
         count(*) FILTER (WHERE base.channel = 'call')::int AS calls,
         count(*) FILTER (WHERE base.channel IN ('chat','whatsapp'))::int AS chats,
         count(*) FILTER (WHERE base.channel = 'email')::int AS emails,
         (count(*) FILTER (WHERE c.call_status = 'missed')
           + count(*) FILTER (WHERE base.channel <> 'call' AND base.awaiting_agent_since IS NOT NULL AND base.resolution_status <> 'resolved'
                AND base.awaiting_agent_since < now() - make_interval(mins => ${sla})))::int AS missed,
         avg(base.first_response_seconds) FILTER (WHERE base.channel <> 'call') AS frt,
         avg(base.resolution_seconds) FILTER (WHERE base.resolution_status = 'resolved') AS resolution,
         avg(base.quality_score) AS quality,
         count(base.quality_score)::int AS evaluated,
         count(*) FILTER (WHERE base.resolution_status = 'resolved')::int AS resolved,
         count(*) FILTER (WHERE base.resolution_status = 'resolved' AND NOT base.reopened AND NOT EXISTS (
            SELECT 1 FROM interactions n WHERE n.customer_id = base.customer_id AND base.customer_id IS NOT NULL
               AND n.occurred_at > base.occurred_at AND n.occurred_at <= base.occurred_at + make_interval(days => ${win})))::float
           / NULLIF(count(*) FILTER (WHERE base.resolution_status = 'resolved'), 0) AS fcr,
         count(*) FILTER (WHERE base.reopened)::float / NULLIF(count(*) FILTER (WHERE base.resolution_status = 'resolved' OR base.reopened), 0) AS reopened_rate,
         avg(cf.csat) AS csat, count(cf.csat)::int AS csat_n,
         avg((ev.group_scores->'policy'->>'score')::numeric / NULLIF((ev.group_scores->'policy'->>'weight')::numeric, 0))
           FILTER (WHERE (ev.group_scores->'policy'->>'applicable')::boolean IS TRUE) AS policy,
         count(*) FILTER (WHERE (ev.group_scores->'policy'->>'applicable')::boolean IS TRUE)::int AS policy_n,
         count(*) FILTER (WHERE lab.hi)::float / NULLIF(count(*), 0) AS high_share,
         count(*) FILTER (WHERE lab.complaint)::float / NULLIF(count(*), 0) AS complaint_share,
         avg(coalesce(lab.n, 0)) AS labels_per,
         bool_or(base.is_demo) AS has_demo
       FROM base LEFT JOIN calls c ON c.interaction_id = base.id LEFT JOIN ev ON ev.interaction_id = base.id
       LEFT JOIN lab ON lab.interaction_id = base.id LEFT JOIN cf ON cf.interaction_id = base.id
       GROUP BY 1)
     SELECT agg.k AS agent_id, agg.*, coalesce(fl.confirmed, 0) AS confirmed, coalesce(fl.fp, 0) AS fp, coalesce(fl.reviewed_flags, 0) AS reviewed_flags,
            fl.fp::float / NULLIF(fl.reviewed_flags, 0) AS fp_rate, coalesce(co.coaching, 0) AS coaching, pv.prev_quality, coalesce(pv.prev_evaluated, 0) AS prev_evaluated
       FROM agg LEFT JOIN fl ON fl.k IS NOT DISTINCT FROM agg.k LEFT JOIN co ON co.k IS NOT DISTINCT FROM agg.k LEFT JOIN pv ON pv.k IS NOT DISTINCT FROM agg.k`,
    b.params,
  ).then((rows) => rows.map(numify));
}

function numify(r: any): AgentRow {
  const out: any = { ...r };
  for (const k of ['frt', 'resolution', 'quality', 'fcr', 'reopened_rate', 'csat', 'policy', 'fp_rate', 'prev_quality', 'high_share', 'complaint_share', 'labels_per']) {
    out[k] = r[k] === null || r[k] === undefined ? null : Number(r[k]);
  }
  return out;
}

/** Agent list (scoped). Agents with no activity in range are included with zeros so nobody is silently hidden. */
export async function getAgentTable(db: Db, s: Session, f: AgentFilters): Promise<AgentRow[]> {
  const rows = await metrics(db, s, f, {
    groupByAgent: true, applyScope: true,
    agentConds: (b, expr) => {
      const c = [scopeAgents(s, b, expr)];
      if (f.teamFilter && isUuid(f.teamFilter)) c.push(`${expr} IN (SELECT id FROM agents WHERE team_id = ${b.p(f.teamFilter)})`);
      return c;
    },
  });
  const b = new SqlBuilder();
  const conds = [scopeAgents(s, b, 'a.id')];
  if (f.teamFilter && isUuid(f.teamFilter)) conds.push(`a.team_id = ${b.p(f.teamFilter)}`);
  const agents = await db.query<{ id: string; name: string; team: string | null; team_id: string | null; is_active: boolean; user_id: string | null }>(
    `SELECT a.id, a.name, t.name AS team, a.team_id, a.is_active, a.user_id FROM agents a LEFT JOIN teams t ON t.id = a.team_id
      ${whereOf(conds)} ORDER BY a.name`, b.params);
  const byId = new Map(rows.map((r) => [r.agent_id, r]));
  return agents
    .filter((a) => a.is_active || byId.has(a.id))
    .map((a) => ({ ...(byId.get(a.id) ?? emptyRow(a.id)), name: a.name, team: a.team, team_id: a.team_id, is_active: a.is_active, user_id: a.user_id }));
}

function emptyRow(id: string): AgentRow {
  return {
    agent_id: id, total: 0, calls: 0, chats: 0, emails: 0, missed: 0, frt: null, resolution: null, quality: null, evaluated: 0, resolved: 0,
    fcr: null, reopened_rate: null, csat: null, csat_n: 0, policy: null, policy_n: 0, confirmed: 0, fp: 0, reviewed_flags: 0, fp_rate: null,
    coaching: 0, prev_quality: null, prev_evaluated: 0, high_share: null, complaint_share: null, labels_per: null, has_demo: false,
  };
}

/** Aggregate of a whole team (used as the comparison baseline on agent pages; aggregate only, no individual data). */
export async function getTeamAggregate(db: Db, s: Session, f: AgentFilters, teamId: string | null): Promise<AgentRow | null> {
  if (!teamId) return null;
  const rows = await metrics(db, s, f, {
    groupByAgent: false, applyScope: false,
    agentConds: (b, expr) => [`${expr} IN (SELECT id FROM agents WHERE team_id = ${b.p(teamId)})`],
  });
  return rows[0] ?? null;
}

/** Load one agent if the caller's scope allows it (null otherwise → 404). */
export async function getScopedAgent(db: Db, s: Session, id: string) {
  if (!isUuid(id)) return null;
  const b = new SqlBuilder();
  return db.one<{ id: string; name: string; email: string | null; team_id: string | null; team: string | null; is_active: boolean; is_demo: boolean; user_id: string | null; external_ids: Record<string, string> }>(
    `SELECT a.id, a.name, a.email, a.team_id, t.name AS team, a.is_active, a.is_demo, a.user_id, a.external_ids
       FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE a.id = ${b.p(id)} AND ${scopeAgents(s, b, 'a.id')}`, b.params);
}

export async function getAgentMetrics(db: Db, s: Session, f: AgentFilters, agentId: string): Promise<AgentRow> {
  const rows = await metrics(db, s, f, { groupByAgent: true, applyScope: true, agentConds: (b, expr) => [`${expr} = ${b.p(agentId)}`, scopeAgents(s, b, expr)] });
  return rows[0] ?? emptyRow(agentId);
}

/** Weekly/daily quality trend for the agent and their team (mean quality_score). */
export async function getQualityTrend(db: Db, s: Session, f: AgentFilters, agentId: string, teamId: string | null, bucket: 'day' | 'week' | 'month') {
  const b = new SqlBuilder();
  const conds = interactionConds({ ...s, scope: 'all' } as Session, { ...f, agentId: null, teamId: null }, b, 'i');
  const bk = b.p(bucket);
  const aid = b.p(agentId);
  const tid = b.p(teamId);
  return db.query<{ bucket: string; agent: number | null; team: number | null; n: number }>(
    `SELECT to_char(date_trunc(${bk}, i.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
            round(avg(i.quality_score) FILTER (WHERE i.agent_id = ${aid}), 1)::float AS agent,
            round(avg(i.quality_score) FILTER (WHERE i.agent_id IN (SELECT id FROM agents WHERE team_id = ${tid})), 1)::float AS team,
            count(i.quality_score) FILTER (WHERE i.agent_id = ${aid})::int AS n
       FROM interactions i ${whereOf([...conds, 'i.quality_score IS NOT NULL', `(i.agent_id = ${aid} OR i.agent_id IN (SELECT id FROM agents WHERE team_id = ${tid}))`])}
      GROUP BY 1 ORDER BY 1`, b.params);
}

/** Mean score (0–5) per rubric criterion from current evaluations (human preferred), N/A excluded. */
export async function getCriterionBreakdown(db: Db, s: Session, f: AgentFilters, agentId: string) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, { ...f, agentId }, b, 'i');
  const rows = await db.query<{ code: string; avg: number; n: number; name: string | null }>(
    `WITH ev AS (
       SELECT DISTINCT ON (e.interaction_id) e.criterion_scores FROM quality_evaluations e JOIN interactions i ON i.id = e.interaction_id
        ${whereOf([...conds, 'e.is_current'])} ORDER BY e.interaction_id, (e.evaluator_type = 'human') DESC, e.created_at DESC)
     SELECT cs->>'code' AS code, round(avg((cs->>'score')::numeric), 2)::float AS avg, count(*)::int AS n, max(qc.name) AS name
       FROM ev, jsonb_array_elements(ev.criterion_scores) cs
       LEFT JOIN quality_criteria qc ON qc.code = cs->>'code'
      WHERE coalesce((cs->>'na')::boolean, false) = false AND jsonb_typeof(cs->'score') = 'number'
      GROUP BY 1 ORDER BY avg DESC`, b.params);
  const names = new Map(DEFAULT_CRITERIA.map((c) => [c.code, c.name]));
  return rows.map((r) => ({ ...r, name: r.name ?? names.get(r.code) ?? r.code }));
}

export async function getChannelMix(db: Db, s: Session, f: AgentFilters, agentId: string) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, { ...f, agentId }, b, 'i');
  return db.query<{ channel: string; n: number; quality: number | null }>(
    `SELECT i.channel, count(*)::int AS n, round(avg(i.quality_score), 1)::float AS quality FROM interactions i ${whereOf(conds)} GROUP BY 1 ORDER BY n DESC`, b.params);
}

export async function getRecentReviewed(db: Db, s: Session, f: AgentFilters, agentId: string, limit = 10) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, { ...f, agentId }, b, 'i');
  return db.query(
    `SELECT i.id, i.ref, i.channel, i.occurred_at, i.quality_score, i.quality_band, i.review_status, i.resolution_status, i.subject, i.is_demo,
            (SELECT c.name FROM interaction_issue_labels l JOIN issue_categories c ON c.id = coalesce(l.subcategory_id, l.category_id)
              WHERE l.interaction_id = i.id AND l.is_active ORDER BY l.is_primary DESC LIMIT 1) AS issue
       FROM interactions i ${whereOf([...conds, 'i.quality_score IS NOT NULL'])}
      ORDER BY (i.review_status IN ('reviewed','corrected')) DESC, i.occurred_at DESC LIMIT ${limit}`, b.params);
}

export async function getAgentFlags(db: Db, s: Session, f: AgentFilters, agentId: string, limit = 12) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, { ...f, agentId: null }, b, 'i');
  return db.query(
    `SELECT fl.id, fl.interaction_id, fl.severity, fl.status, fl.title, fl.rule_code, fl.created_at, fl.is_demo, i.ref, i.channel
       FROM quality_flags fl JOIN interactions i ON i.id = fl.interaction_id
      ${whereOf([...conds, `fl.agent_id = ${b.p(agentId)}`])}
      ORDER BY CASE fl.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, fl.created_at DESC LIMIT ${limit}`, b.params);
}

/** Confirmed flag rules (weakness evidence), all time within range. */
export async function getConfirmedRules(db: Db, s: Session, f: AgentFilters, agentId: string) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, { ...f, agentId: null }, b, 'i');
  return db.query<{ rule_code: string; name: string | null; n: number }>(
    `SELECT fl.rule_code, max(r.name) AS name, count(*)::int AS n
       FROM quality_flags fl JOIN interactions i ON i.id = fl.interaction_id LEFT JOIN alert_rules r ON r.code = fl.rule_code
      ${whereOf([...conds, `fl.agent_id = ${b.p(agentId)}`, `fl.status IN ('confirmed','coaching_assigned','resolved')`])}
      GROUP BY 1 ORDER BY n DESC LIMIT 5`, b.params);
}
