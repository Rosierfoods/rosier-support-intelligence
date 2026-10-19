/**
 * Agent daily activity (calls made / received, chats & messages replied, emails) and agent review (call quality, accuracy,
 * alerts, ticket outcomes). Days are IST calendar days. Only interactions the viewer may see are counted (role scope).
 */
import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { isUuid } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeInteractions } from '@/lib/repos/scope';
import { parseRange, sp, type SP } from '@/lib/filters';

export interface ActivityFilters { from: Date; to: Date; agentId: string | null; teamId: string | null; rangeLabel?: string }

export function parseActivityFilters(searchParams: SP, defaultPreset = '7d'): ActivityFilters {
  const r = parseRange(searchParams, defaultPreset);
  const agent = sp(searchParams, 'agent');
  const team = sp(searchParams, 'team');
  return { from: r.from, to: r.to, rangeLabel: r.label, agentId: agent && isUuid(agent) ? agent : null, teamId: team && isUuid(team) ? team : null };
}

export interface DailyRow {
  day: string; agent_id: string | null; agent_name: string | null;
  calls_in: number; calls_out: number; answered: number; missed: number; talk_seconds: number;
  chats: number; chat_replies: number; emails: number; email_replies: number; total: number;
}

const IST_DAY = (col: string) => `to_char((${col} AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;

function baseConds(s: Session, f: ActivityFilters, b: SqlBuilder, a = 'i') {
  const c = [`${a}.occurred_at >= ${b.p(f.from)}`, `${a}.occurred_at <= ${b.p(f.to)}`];
  if (f.agentId && isUuid(f.agentId)) c.push(`${a}.agent_id = ${b.p(f.agentId)}`);
  if (f.teamId && isUuid(f.teamId)) c.push(`${a}.team_id = ${b.p(f.teamId)}`);
  c.push(scopeInteractions(s, b, a));
  return c.join(' AND ');
}

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** One row per agent per IST day. Agent replies are counted on the day the message was sent. */
export async function getDailyActivity(db: Db, s: Session, f: ActivityFilters): Promise<DailyRow[]> {
  const b = new SqlBuilder();
  const where = baseConds(s, f, b);
  const from = b.p(f.from), to = b.p(f.to);
  const rows = await db.query<any>(
    `WITH base AS (SELECT i.id, i.agent_id, i.channel, i.direction, i.occurred_at FROM interactions i WHERE ${where}),
     ix AS (
       SELECT ${IST_DAY('base.occurred_at')} AS day, base.agent_id,
         count(*) FILTER (WHERE base.channel = 'call' AND base.direction = 'inbound')::int AS calls_in,
         count(*) FILTER (WHERE base.channel = 'call' AND base.direction = 'outbound')::int AS calls_out,
         count(*) FILTER (WHERE c.call_status = 'answered')::int AS answered,
         count(*) FILTER (WHERE base.channel = 'call' AND c.call_status <> 'answered')::int AS missed,
         coalesce(sum(c.duration_seconds) FILTER (WHERE c.call_status = 'answered'), 0)::int AS talk_seconds,
         count(*) FILTER (WHERE base.channel IN ('chat','whatsapp'))::int AS chats,
         count(*) FILTER (WHERE base.channel = 'email')::int AS emails,
         count(*)::int AS total
       FROM base LEFT JOIN calls c ON c.interaction_id = base.id GROUP BY 1, 2),
     cm AS (
       SELECT ${IST_DAY('m.sent_at')} AS day, base.agent_id, count(*)::int AS chat_replies
         FROM conversation_messages m JOIN base ON base.id = m.interaction_id
        WHERE m.sender_type = 'agent' AND m.sent_at >= ${from} AND m.sent_at <= ${to} GROUP BY 1, 2),
     em AS (
       SELECT ${IST_DAY('coalesce(e.sent_at, base.occurred_at)')} AS day, base.agent_id, count(*)::int AS email_replies
         FROM email_messages e JOIN base ON base.id = e.interaction_id
        WHERE e.sender_type = 'agent' GROUP BY 1, 2),
     keys AS (SELECT day, agent_id FROM ix UNION SELECT day, agent_id FROM cm UNION SELECT day, agent_id FROM em)
     SELECT k.day, k.agent_id, a.name AS agent_name,
            coalesce(ix.calls_in, 0) AS calls_in, coalesce(ix.calls_out, 0) AS calls_out, coalesce(ix.answered, 0) AS answered,
            coalesce(ix.missed, 0) AS missed, coalesce(ix.talk_seconds, 0) AS talk_seconds, coalesce(ix.chats, 0) AS chats,
            coalesce(cm.chat_replies, 0) AS chat_replies, coalesce(ix.emails, 0) AS emails, coalesce(em.email_replies, 0) AS email_replies,
            coalesce(ix.total, 0) AS total
       FROM keys k
       LEFT JOIN ix ON ix.day = k.day AND ix.agent_id IS NOT DISTINCT FROM k.agent_id
       LEFT JOIN cm ON cm.day = k.day AND cm.agent_id IS NOT DISTINCT FROM k.agent_id
       LEFT JOIN em ON em.day = k.day AND em.agent_id IS NOT DISTINCT FROM k.agent_id
       LEFT JOIN agents a ON a.id = k.agent_id
      ORDER BY k.day DESC, a.name NULLS LAST`, b.params);
  return rows.map((r: any) => ({
    day: r.day, agent_id: r.agent_id, agent_name: r.agent_name,
    calls_in: n(r.calls_in), calls_out: n(r.calls_out), answered: n(r.answered), missed: n(r.missed), talk_seconds: n(r.talk_seconds),
    chats: n(r.chats), chat_replies: n(r.chat_replies), emails: n(r.emails), email_replies: n(r.email_replies), total: n(r.total),
  }));
}

/** Totals per agent over the whole range (sum of the daily rows). Pure; unit-tested. */
export function totalsByAgent(rows: DailyRow[]) {
  const m = new Map<string, DailyRow & { days: number }>();
  for (const r of rows) {
    const k = r.agent_id ?? 'none';
    const cur = m.get(k) ?? { ...r, day: '', days: 0, calls_in: 0, calls_out: 0, answered: 0, missed: 0, talk_seconds: 0, chats: 0, chat_replies: 0, emails: 0, email_replies: 0, total: 0 };
    cur.days += 1;
    for (const f of ['calls_in', 'calls_out', 'answered', 'missed', 'talk_seconds', 'chats', 'chat_replies', 'emails', 'email_replies', 'total'] as const) cur[f] += r[f];
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

export interface ReviewRow {
  agent_id: string | null; agent_name: string | null; team: string | null;
  interactions: number; calls: number; evaluated: number; quality: number | null; call_quality: number | null; call_evaluated: number;
  accuracy: number | null; incorrect_statements: number; policy_violations: number;
  critical_alerts: number; high_alerts: number; open_alerts: number; confirmed_alerts: number; false_positives: number;
  tickets: number; resolved_tickets: number; refunds: number; replacements: number; escalations: number;
  negative_sentiment: number; excellent: number; poor: number;
}

/**
 * Accuracy = share of evaluated interactions whose current evaluation lists no incorrect statements (wrong information given).
 * Call quality = mean quality score of evaluated calls only.
 */
export async function getAgentReview(db: Db, s: Session, f: ActivityFilters): Promise<ReviewRow[]> {
  const b = new SqlBuilder();
  const where = baseConds(s, f, b);
  const rows = await db.query<any>(
    `WITH base AS (SELECT i.* FROM interactions i WHERE ${where}),
     ev AS (
       SELECT DISTINCT ON (e.interaction_id) e.interaction_id, e.overall_score,
              jsonb_array_length(coalesce(e.incorrect_statements, '[]'::jsonb)) AS wrong,
              jsonb_array_length(coalesce(e.policy_violations, '[]'::jsonb)) AS viol
         FROM quality_evaluations e JOIN base ON base.id = e.interaction_id
        WHERE e.is_current ORDER BY e.interaction_id, (e.evaluator_type = 'human') DESC, e.created_at DESC),
     fl AS (
       SELECT base.agent_id,
              count(*) FILTER (WHERE q.severity = 'critical' AND q.status <> 'false_positive')::int AS critical_alerts,
              count(*) FILTER (WHERE q.severity = 'high' AND q.status <> 'false_positive')::int AS high_alerts,
              count(*) FILTER (WHERE q.status IN ('new','under_review'))::int AS open_alerts,
              count(*) FILTER (WHERE q.status IN ('confirmed','coaching_assigned','resolved'))::int AS confirmed_alerts,
              count(*) FILTER (WHERE q.status = 'false_positive')::int AS false_positives
         FROM quality_flags q JOIN base ON base.id = q.interaction_id GROUP BY 1),
     tk AS (
       SELECT base.agent_id, count(*)::int AS tickets,
              count(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved_tickets,
              count(*) FILTER (WHERE t.resolution_type = 'refund')::int AS refunds,
              count(*) FILTER (WHERE t.resolution_type = 'replacement')::int AS replacements,
              count(*) FILTER (WHERE t.resolution_type = 'escalated' OR t.status = 'escalated')::int AS escalations
         FROM support_tickets t JOIN base ON base.id = t.interaction_id GROUP BY 1),
     agg AS (
       SELECT base.agent_id, count(*)::int AS interactions,
              count(*) FILTER (WHERE base.channel = 'call')::int AS calls,
              count(base.quality_score)::int AS evaluated,
              avg(base.quality_score) AS quality,
              avg(base.quality_score) FILTER (WHERE base.channel = 'call') AS call_quality,
              count(base.quality_score) FILTER (WHERE base.channel = 'call')::int AS call_evaluated,
              count(ev.interaction_id) FILTER (WHERE ev.wrong = 0)::float / NULLIF(count(ev.interaction_id), 0) AS accuracy,
              coalesce(sum(ev.wrong), 0)::int AS incorrect_statements,
              coalesce(sum(ev.viol), 0)::int AS policy_violations,
              count(*) FILTER (WHERE base.sentiment = 'negative')::int AS negative_sentiment,
              count(*) FILTER (WHERE base.quality_score >= 85)::int AS excellent,
              count(*) FILTER (WHERE base.quality_score < 60)::int AS poor
         FROM base LEFT JOIN ev ON ev.interaction_id = base.id GROUP BY 1)
     SELECT agg.*, a.name AS agent_name, tm.name AS team,
            coalesce(fl.critical_alerts, 0) AS critical_alerts, coalesce(fl.high_alerts, 0) AS high_alerts, coalesce(fl.open_alerts, 0) AS open_alerts,
            coalesce(fl.confirmed_alerts, 0) AS confirmed_alerts, coalesce(fl.false_positives, 0) AS false_positives,
            coalesce(tk.tickets, 0) AS tickets, coalesce(tk.resolved_tickets, 0) AS resolved_tickets, coalesce(tk.refunds, 0) AS refunds,
            coalesce(tk.replacements, 0) AS replacements, coalesce(tk.escalations, 0) AS escalations
       FROM agg LEFT JOIN agents a ON a.id = agg.agent_id LEFT JOIN teams tm ON tm.id = a.team_id
       LEFT JOIN fl ON fl.agent_id IS NOT DISTINCT FROM agg.agent_id LEFT JOIN tk ON tk.agent_id IS NOT DISTINCT FROM agg.agent_id
      ORDER BY a.name NULLS LAST`, b.params);
  return rows.map((r: any) => ({
    agent_id: r.agent_id, agent_name: r.agent_name, team: r.team,
    interactions: n(r.interactions), calls: n(r.calls), evaluated: n(r.evaluated),
    quality: r.quality === null ? null : Number(r.quality), call_quality: r.call_quality === null ? null : Number(r.call_quality), call_evaluated: n(r.call_evaluated),
    accuracy: r.accuracy === null ? null : Number(r.accuracy), incorrect_statements: n(r.incorrect_statements), policy_violations: n(r.policy_violations),
    critical_alerts: n(r.critical_alerts), high_alerts: n(r.high_alerts), open_alerts: n(r.open_alerts), confirmed_alerts: n(r.confirmed_alerts),
    false_positives: n(r.false_positives), tickets: n(r.tickets), resolved_tickets: n(r.resolved_tickets), refunds: n(r.refunds),
    replacements: n(r.replacements), escalations: n(r.escalations), negative_sentiment: n(r.negative_sentiment), excellent: n(r.excellent), poor: n(r.poor),
  }));
}

/** Latest critical alerts in range (for the review page), newest first. */
export async function getCriticalAlerts(db: Db, s: Session, f: ActivityFilters, limit = 25) {
  const b = new SqlBuilder();
  const where = baseConds(s, f, b);
  return db.query<{ id: string; title: string; status: string; created_at: string; interaction_id: string; ref: string; order_ref: string | null; agent_name: string | null; channel: string }>(
    `SELECT q.id, q.title, q.status, q.created_at, i.id AS interaction_id, i.ref, i.order_ref, a.name AS agent_name, i.channel
       FROM quality_flags q JOIN interactions i ON i.id = q.interaction_id LEFT JOIN agents a ON a.id = i.agent_id
      WHERE q.severity = 'critical' AND q.status <> 'false_positive' AND ${where}
      ORDER BY (q.status IN ('new','under_review')) DESC, q.created_at DESC LIMIT ${limit}`, b.params);
}
