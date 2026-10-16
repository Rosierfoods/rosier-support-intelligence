import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { SqlBuilder } from '@/lib/sql';
import { scopeInteractions, scopeAgents } from '@/lib/repos/scope';
import type { Channel } from '@/lib/constants';

/**
 * Overview KPIs. Every number is computed from stored records using the formulas below
 * (also shown as tooltips in the UI and documented in docs/METRICS.md).
 * "In range" = interactions.occurred_at within the selected date range, after channel filter and role data scope.
 */
export const METRIC_DEFS: Record<string, string> = {
  calls_received: 'Count of inbound call interactions in range.',
  calls_answered: 'Inbound calls whose call_status = answered.',
  missed_calls: 'Inbound calls whose call_status = missed (provider-reported).',
  whatsapp: 'Count of WhatsApp conversations (threads) in range.',
  emails: 'Count of email threads in range.',
  total: 'All interactions in range across channels.',
  avg_first_response: 'Mean of first_response_seconds for chat, WhatsApp and email threads (time from the first customer message to the first agent reply). Calls use ring time and are shown separately.',
  avg_resolution: 'Mean of resolution_seconds for interactions with resolution_status = resolved.',
  csat: 'Mean CSAT (1–5) from customer_feedback linked to interactions in range. Shown only when feedback exists.',
  fcr: 'Resolved interactions with no further contact from the same customer within the repeat-contact window (default 7 days) and not reopened ÷ all resolved interactions.',
  reopened: 'Interactions flagged reopened ÷ interactions that reached resolved or were reopened.',
  quality_failure: 'Interactions whose current quality score is below the review threshold (default 70) ÷ interactions with a quality score.',
  pending_complaints: 'Interactions in open / pending / escalated / unresolved status that carry at least one complaint label (any category except Product Information and Other).',
  open_critical: 'Critical quality flags with status New, Under review or Confirmed (all dates).',
  quality_score: 'Mean current quality score (0–100) of evaluated interactions in range.',
  refunds: 'Interactions with at least one active Refund label.',
  replacements: 'Interactions with at least one active Replacement label.',
};

export interface DashboardFilters { from: Date; to: Date; channel: Channel | null; bucket: 'day' | 'week' | 'month' }

function base(s: Session, f: DashboardFilters, b: SqlBuilder) {
  b.and(`i.occurred_at >= ${b.p(f.from)}`).and(`i.occurred_at <= ${b.p(f.to)}`);
  if (f.channel) b.and(`i.channel = ${b.p(f.channel)}`);
  b.and(scopeInteractions(s, b, 'i'));
  return b;
}

export async function getKpis(db: Db, s: Session, f: DashboardFilters) {
  const b = base(s, f, new SqlBuilder());
  const threshold = b.p(s.org.settings.reviewThreshold);
  const windowDays = b.p(s.org.settings.repeatContactWindowDays);
  const row = await db.one(
    `WITH base AS (SELECT i.* FROM interactions i ${b.whereSql()}),
     resolved AS (
       SELECT r.*, NOT r.reopened AND NOT EXISTS (
         SELECT 1 FROM interactions n WHERE n.customer_id = r.customer_id AND r.customer_id IS NOT NULL
           AND n.occurred_at > r.occurred_at AND n.occurred_at <= r.occurred_at + make_interval(days => ${windowDays})) AS fcr
         FROM base r WHERE r.resolution_status = 'resolved')
     SELECT
       count(*) FILTER (WHERE channel = 'call' AND direction = 'inbound')::int AS calls_received,
       (SELECT count(*) FROM base x JOIN calls c ON c.interaction_id = x.id WHERE x.direction = 'inbound' AND c.call_status = 'answered')::int AS calls_answered,
       (SELECT count(*) FROM base x JOIN calls c ON c.interaction_id = x.id WHERE x.direction = 'inbound' AND c.call_status = 'missed')::int AS missed_calls,
       count(*) FILTER (WHERE channel = 'whatsapp')::int AS whatsapp,
       count(*) FILTER (WHERE channel = 'chat')::int AS chats,
       count(*) FILTER (WHERE channel = 'email')::int AS emails,
       count(*)::int AS total,
       avg(first_response_seconds) FILTER (WHERE channel <> 'call') AS avg_first_response,
       (SELECT avg(c.ring_seconds) FROM base x JOIN calls c ON c.interaction_id = x.id WHERE c.call_status = 'answered') AS avg_ring,
       avg(resolution_seconds) FILTER (WHERE resolution_status = 'resolved') AS avg_resolution,
       (SELECT avg(cf.csat) FROM customer_feedback cf JOIN base x ON x.id = cf.interaction_id) AS csat,
       (SELECT count(*) FROM customer_feedback cf JOIN base x ON x.id = cf.interaction_id)::int AS csat_n,
       (SELECT count(*) FILTER (WHERE fcr)::float / NULLIF(count(*), 0) FROM resolved) AS fcr,
       (SELECT count(*) FROM resolved)::int AS resolved_n,
       count(*) FILTER (WHERE reopened)::float / NULLIF(count(*) FILTER (WHERE resolution_status = 'resolved' OR reopened), 0) AS reopened_rate,
       count(*) FILTER (WHERE quality_score < ${threshold})::float / NULLIF(count(quality_score), 0) AS quality_failure,
       count(quality_score)::int AS evaluated_n,
       avg(quality_score) AS quality_score,
       count(*) FILTER (WHERE resolution_status IN ('open','pending','escalated','unresolved') AND EXISTS (
         SELECT 1 FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
          WHERE l.interaction_id = base.id AND l.is_active AND c.code NOT IN ('product_info','other')))::int AS pending_complaints,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
          WHERE l.interaction_id = base.id AND l.is_active AND c.code = 'refund'))::int AS refunds,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
          WHERE l.interaction_id = base.id AND l.is_active AND c.code = 'replacement'))::int AS replacements,
       bool_or(is_demo) AS has_demo
     FROM base`,
    b.params,
  );
  const fb = new SqlBuilder();
  const crit = await db.one<{ c: number }>(
    `SELECT count(*)::int AS c FROM quality_flags WHERE severity = 'critical' AND status IN ('new','under_review','confirmed') AND ${scopeAgents(s, fb, 'agent_id')}`,
    fb.params,
  );
  return { ...row, open_critical: crit?.c ?? 0 } as Record<string, any>;
}

export async function getVolumeSeries(db: Db, s: Session, f: DashboardFilters) {
  const b = base(s, f, new SqlBuilder());
  const bucket = b.p(f.bucket);
  return db.query(
    `SELECT to_char(date_trunc(${bucket}, i.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
            count(*) FILTER (WHERE channel = 'call')::int AS call,
            count(*) FILTER (WHERE channel = 'chat')::int AS chat,
            count(*) FILTER (WHERE channel = 'whatsapp')::int AS whatsapp,
            count(*) FILTER (WHERE channel = 'email')::int AS email
       FROM interactions i ${b.whereSql()} GROUP BY 1 ORDER BY 1`,
    b.params,
  );
}

export async function getSentimentSeries(db: Db, s: Session, f: DashboardFilters) {
  const b = base(s, f, new SqlBuilder());
  const bucket = b.p(f.bucket);
  return db.query(
    `SELECT to_char(date_trunc(${bucket}, i.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
            count(*) FILTER (WHERE sentiment = 'positive')::int AS positive,
            count(*) FILTER (WHERE sentiment IN ('neutral','mixed'))::int AS neutral,
            count(*) FILTER (WHERE sentiment = 'negative')::int AS negative
       FROM interactions i ${b.whereSql()} AND i.sentiment IS NOT NULL GROUP BY 1 ORDER BY 1`,
    b.params,
  );
}

export async function getIssueDistribution(db: Db, s: Session, f: DashboardFilters) {
  const b = base(s, f, new SqlBuilder());
  return db.query(
    `SELECT c.code, c.name, sc.code AS sub_code, sc.name AS sub_name, count(DISTINCT l.interaction_id)::int AS n
       FROM interaction_issue_labels l
       JOIN interactions i ON i.id = l.interaction_id
       JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
      ${b.whereSql()} AND l.is_active
      GROUP BY 1,2,3,4 ORDER BY n DESC`,
    b.params,
  );
}

export async function getLeaderboard(db: Db, s: Session, f: DashboardFilters, limit = 10) {
  const b = base(s, f, new SqlBuilder());
  return db.query(
    `SELECT a.id, a.name, t.name AS team,
            count(i.id)::int AS handled,
            avg(i.quality_score) AS quality,
            count(i.quality_score)::int AS evaluated,
            avg(i.first_response_seconds) FILTER (WHERE i.channel <> 'call') AS frt,
            count(*) FILTER (WHERE i.resolution_status = 'resolved')::float / NULLIF(count(i.id), 0) AS resolution_rate,
            (SELECT count(*) FROM coaching_actions ca WHERE ca.agent_id = a.id AND ca.status IN ('assigned','acknowledged','in_progress'))::int AS open_coaching
       FROM interactions i JOIN agents a ON a.id = i.agent_id LEFT JOIN teams t ON t.id = a.team_id
      ${b.whereSql()}
      GROUP BY a.id, a.name, t.name
      ORDER BY avg(i.quality_score) DESC NULLS LAST
      LIMIT ${limit}`,
    b.params,
  );
}

export async function getRecentFlags(db: Db, s: Session, f: DashboardFilters, limit = 8) {
  const b = new SqlBuilder();
  b.and(`i.occurred_at >= ${b.p(f.from)}`).and(`i.occurred_at <= ${b.p(f.to)}`);
  if (f.channel) b.and(`i.channel = ${b.p(f.channel)}`);
  b.and(scopeInteractions(s, b, 'i'));
  return db.query(
    `SELECT fl.id, fl.severity, fl.title, fl.status, fl.created_at, fl.interaction_id, fl.is_demo, i.ref, i.channel, a.name AS agent
       FROM quality_flags fl JOIN interactions i ON i.id = fl.interaction_id LEFT JOIN agents a ON a.id = fl.agent_id
      ${b.whereSql()}
      ORDER BY CASE fl.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               (fl.status IN ('new','under_review')) DESC, fl.created_at DESC
      LIMIT ${limit}`,
    b.params,
  );
}

export async function getProductComplaints(db: Db, s: Session, f: DashboardFilters) {
  const b = base(s, f, new SqlBuilder());
  return db.query(
    `SELECT coalesce(l.product, i.product, 'Unknown') AS product, count(DISTINCT l.interaction_id)::int AS n,
            count(DISTINCT l.interaction_id) FILTER (WHERE c.code = 'quality')::int AS quality_n
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
      ${b.whereSql()} AND l.is_active AND c.code IN ('quality','replacement','refund')
      GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    b.params,
  );
}

export async function getOperational(db: Db, s: Session, f: DashboardFilters) {
  const b1 = base(s, f, new SqlBuilder());
  const peakHours = await db.query(
    `SELECT extract(hour FROM i.occurred_at AT TIME ZONE 'Asia/Kolkata')::int AS hour, count(*)::int AS n,
            count(*) FILTER (WHERE c.call_status = 'missed')::int AS missed
       FROM interactions i JOIN calls c ON c.interaction_id = i.id ${b1.whereSql()} GROUP BY 1 ORDER BY 1`, b1.params);
  const b2 = base(s, f, new SqlBuilder());
  const bucket = b2.p(f.bucket);
  const missedTrend = await db.query(
    `SELECT to_char(date_trunc(${bucket}, i.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
            count(*) FILTER (WHERE c.call_status = 'missed')::int AS missed, count(*)::int AS calls
       FROM interactions i JOIN calls c ON c.interaction_id = i.id ${b2.whereSql()} GROUP BY 1 ORDER BY 1`, b2.params);
  const b3 = base(s, f, new SqlBuilder());
  const repeat = await db.one(
    `SELECT count(*) FILTER (WHERE is_repeat_contact)::float / NULLIF(count(*) FILTER (WHERE customer_id IS NOT NULL), 0) AS rate,
            count(*) FILTER (WHERE is_repeat_contact)::int AS n
       FROM interactions i ${b3.whereSql()}`, b3.params);
  const b4 = base(s, f, new SqlBuilder());
  const bottlenecks = await db.query(
    `SELECT c.code, c.name,
            count(DISTINCT i.id) FILTER (WHERE i.resolution_status IN ('open','pending','escalated','unresolved'))::int AS open_n,
            avg(i.resolution_seconds) FILTER (WHERE i.resolution_status = 'resolved') AS avg_resolution,
            count(DISTINCT i.id)::int AS total
       FROM interactions i JOIN interaction_issue_labels l ON l.interaction_id = i.id AND l.is_active AND l.is_primary
       JOIN issue_categories c ON c.id = l.category_id
      ${b4.whereSql()} GROUP BY 1,2 ORDER BY open_n DESC`, b4.params);
  return { peakHours, missedTrend, repeat, bottlenecks };
}
