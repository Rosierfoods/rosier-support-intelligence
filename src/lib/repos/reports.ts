import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { SqlBuilder } from '@/lib/sql';
import { scopeAgents } from '@/lib/repos/scope';
import { interactionConds, NON_COMPLAINT, getTopReasons, whereOf, type AFilters } from '@/lib/repos/analytics';
import { getAgentTable } from '@/lib/repos/agents';
import { coachingScope } from '@/lib/repos/coaching';
import { maskPhone } from '@/lib/crypto';
import { SEVERITIES } from '@/lib/constants';
import { isUuid } from '@/lib/db';
import { parseChannel, parseRange, sp, type DateRange, type SP } from '@/lib/filters';

/**
 * Report catalogue (spec §20). Each report returns on-screen sections that are also exported as CSV
 * by /api/reports/[report]. Rows may carry `_href_<key>` drill-down links (never exported).
 */
export type ColKind = 'text' | 'num' | 'pct' | 'dur' | 'date' | 'datetime' | 'score' | 'inr' | 'dec';
export interface ReportColumn { key: string; label: string; kind?: ColKind; href?: string }
export interface ReportSection { title: string; description?: string; columns: ReportColumn[]; rows: Record<string, any>[]; truncated?: boolean }
export interface ReportResult { sections: ReportSection[]; sampleSize: number; sampleUnit: string; hasDemo: boolean; notes: string[] }
export type ReportFilterKey = 'channel' | 'team' | 'agent' | 'category' | 'product' | 'severity';
export interface ReportDef {
  key: string; title: string; description: string; cadence: string; defaultRange: string; filters: ReportFilterKey[];
  run: (db: Db, s: Session, f: AFilters) => Promise<ReportResult>;
}

const LIST_LIMIT = 500;
const flagSeverity = (f: AFilters, b: SqlBuilder, alias = 'fl') =>
  f.severity && (SEVERITIES as readonly string[]).includes(f.severity) ? [`${alias}.severity = ${b.p(f.severity)}`] : [];
const noSev = (f: AFilters): AFilters => ({ ...f, severity: null });

async function baseStats(db: Db, s: Session, f: AFilters) {
  const b = new SqlBuilder();
  const r = await db.one<{ n: number; demo: boolean }>(
    `SELECT count(*)::int AS n, coalesce(bool_or(i.is_demo), false) AS demo FROM interactions i ${whereOf(interactionConds(s, f, b))}`, b.params);
  return { n: r?.n ?? 0, demo: !!r?.demo };
}

function slaCase(s: Session, b: SqlBuilder, a = 'i') {
  const m = s.org.settings.sla.firstResponseMinutes;
  return `(CASE ${a}.channel WHEN 'chat' THEN ${b.p(m.chat)}::int WHEN 'whatsapp' THEN ${b.p(m.whatsapp)}::int WHEN 'email' THEN ${b.p(m.email)}::int ELSE NULL END)`;
}

// ───────────────────────── 1. Daily CRM summary ─────────────────────────
async function dailyCrm(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const nc = b.p(NON_COMPLAINT);
  const days = await db.query(
    `WITH base AS (SELECT i.* FROM interactions i ${whereOf(conds)})
     SELECT to_char(base.occurred_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
            count(*)::int AS total,
            count(*) FILTER (WHERE channel = 'call')::int AS calls,
            count(*) FILTER (WHERE c.call_status = 'missed')::int AS missed,
            count(*) FILTER (WHERE channel IN ('chat','whatsapp'))::int AS chats,
            count(*) FILTER (WHERE channel = 'email')::int AS emails,
            count(*) FILTER (WHERE resolution_status = 'resolved')::int AS resolved,
            count(*) FILTER (WHERE resolution_status <> 'resolved')::int AS open,
            avg(first_response_seconds) FILTER (WHERE channel <> 'call') AS frt,
            round(avg(quality_score), 1)::float AS quality,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM interaction_issue_labels l JOIN issue_categories ic ON ic.id = l.category_id
              WHERE l.interaction_id = base.id AND l.is_active AND ic.code <> ALL(${nc})))::int AS complaints,
            (SELECT count(*) FROM quality_flags fl WHERE fl.interaction_id = ANY(array_agg(base.id)))::int AS flags
       FROM base LEFT JOIN calls c ON c.interaction_id = base.id GROUP BY 1 ORDER BY 1 DESC`, b.params);
  const b2 = new SqlBuilder();
  const alerts = await db.query(
    `SELECT fl.id, fl.interaction_id, i.ref, fl.title, fl.severity, fl.status, a.name AS agent, fl.created_at
       FROM quality_flags fl JOIN interactions i ON i.id = fl.interaction_id LEFT JOIN agents a ON a.id = fl.agent_id
      ${whereOf([...interactionConds(s, noSev(f), b2), ...flagSeverity(f, b2), `fl.severity IN ('critical','high')`, `fl.status IN ('new','under_review','confirmed')`])}
      ORDER BY fl.severity = 'critical' DESC, fl.created_at DESC LIMIT ${LIST_LIMIT}`, b2.params);
  const st = await baseStats(db, s, f);
  return {
    sampleSize: st.n, sampleUnit: 'interactions', hasDemo: st.demo, notes: ['Days are calendar days in IST. First response excludes calls (ring time is reported in the call audit).'],
    sections: [
      { title: 'Daily summary', columns: [
        { key: 'day', label: 'Day', kind: 'date', href: '/inbox?from={day}&to={day}' }, { key: 'total', label: 'Interactions', kind: 'num' },
        { key: 'calls', label: 'Calls', kind: 'num' }, { key: 'missed', label: 'Missed calls', kind: 'num', href: '/calls?call_status=missed&from={day}&to={day}' },
        { key: 'chats', label: 'Chats/WhatsApp', kind: 'num' }, { key: 'emails', label: 'Emails', kind: 'num' },
        { key: 'resolved', label: 'Resolved', kind: 'num' }, { key: 'open', label: 'Not resolved', kind: 'num', href: '/inbox?from={day}&to={day}&resolution=open,pending,escalated,unresolved' },
        { key: 'frt', label: 'Avg first response', kind: 'dur' }, { key: 'quality', label: 'Avg quality', kind: 'score' },
        { key: 'complaints', label: 'Complaints', kind: 'num', href: '/inbox?from={day}&to={day}&complaints=1' }, { key: 'flags', label: 'AI alerts', kind: 'num' },
      ], rows: days },
      { title: 'Open critical & high alerts', description: 'Alerts on interactions in range still awaiting review or action.', truncated: alerts.length >= LIST_LIMIT, columns: [
        { key: 'ref', label: 'Interaction', href: '/inbox/{interaction_id}?flag={id}' }, { key: 'title', label: 'Alert' }, { key: 'severity', label: 'Severity' },
        { key: 'status', label: 'Status' }, { key: 'agent', label: 'Agent' }, { key: 'created_at', label: 'Raised', kind: 'datetime' },
      ], rows: alerts },
    ],
  };
}

// ───────────────────────── 2. Weekly team performance ─────────────────────────
async function weeklyTeam(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const win = b.p(s.org.settings.repeatContactWindowDays);
  const weeks = await db.query(
    `WITH base AS (SELECT i.* FROM interactions i ${whereOf(conds)})
     SELECT to_char(date_trunc('week', base.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS week, base.team_id, coalesce(t.name, 'No team') AS team,
            count(*)::int AS total, count(base.quality_score)::int AS evaluated, round(avg(base.quality_score), 1)::float AS quality,
            count(*) FILTER (WHERE resolution_status = 'resolved' AND NOT reopened AND NOT EXISTS (SELECT 1 FROM interactions n WHERE n.customer_id = base.customer_id
               AND base.customer_id IS NOT NULL AND n.occurred_at > base.occurred_at AND n.occurred_at <= base.occurred_at + make_interval(days => ${win})))::float
              / NULLIF(count(*) FILTER (WHERE resolution_status = 'resolved'), 0) AS fcr,
            avg(first_response_seconds) FILTER (WHERE channel <> 'call') AS frt,
            avg(resolution_seconds) FILTER (WHERE resolution_status = 'resolved') AS resolution,
            (SELECT count(*) FROM quality_flags fl WHERE fl.interaction_id = ANY(array_agg(base.id)) AND fl.status IN ('confirmed','coaching_assigned','resolved'))::int AS confirmed
       FROM base LEFT JOIN teams t ON t.id = base.team_id GROUP BY 1, 2, 3 ORDER BY 1 DESC, 3`, b.params);
  for (const w of weeks) {
    const d = new Date(w.week + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 6); w.week_end = d.toISOString().slice(0, 10);
    if (w.evaluated < 5) w.quality = null;
  }
  const agents = await getAgentTable(db, s, { ...f, teamFilter: f.teamId ?? null, teamId: null });
  const st = await baseStats(db, s, f);
  return {
    sampleSize: st.n, sampleUnit: 'interactions', hasDemo: st.demo,
    notes: ['Weeks start Monday (IST). Quality is blank where fewer than 5 interactions were evaluated.', 'Agents are listed alphabetically — this report does not rank people.'],
    sections: [
      { title: 'Team performance by week', columns: [
        { key: 'week', label: 'Week of', kind: 'date', href: '/inbox?from={week}&to={week_end}&team={team_id}' }, { key: 'team', label: 'Team' },
        { key: 'total', label: 'Interactions', kind: 'num' }, { key: 'evaluated', label: 'Evaluated', kind: 'num' }, { key: 'quality', label: 'Avg quality', kind: 'score' },
        { key: 'fcr', label: 'FCR', kind: 'pct' }, { key: 'frt', label: 'Avg first response', kind: 'dur' }, { key: 'resolution', label: 'Avg resolution', kind: 'dur' },
        { key: 'confirmed', label: 'Confirmed issues', kind: 'num' },
      ], rows: weeks },
      { title: 'Agents in range', columns: [
        { key: 'name', label: 'Agent', href: '/agents/{agent_id}' }, { key: 'team', label: 'Team' }, { key: 'total', label: 'Interactions', kind: 'num' },
        { key: 'evaluated', label: 'Evaluated', kind: 'num' }, { key: 'quality_g', label: 'Avg quality', kind: 'score' }, { key: 'fcr_g', label: 'FCR', kind: 'pct' },
        { key: 'policy_g', label: 'Policy compliance', kind: 'pct' }, { key: 'confirmed', label: 'Confirmed issues', kind: 'num' }, { key: 'coaching', label: 'Coaching actions', kind: 'num' },
        { key: 'complaint_share', label: 'Complaint share', kind: 'pct' },
      ], rows: agents.map((a) => ({
        ...a, quality_g: a.evaluated >= 5 ? a.quality : null, fcr_g: a.resolved >= 5 ? a.fcr : null, policy_g: a.policy_n >= 5 ? a.policy : null,
      })) },
    ],
  };
}

// ───────────────────────── 3. Monthly customer issue analysis ─────────────────────────
async function monthlyIssues(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const months = await db.query(
    `SELECT to_char(date_trunc('month', i.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS month, c.code AS cat_code, c.name AS category,
            count(DISTINCT i.id)::int AS n
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
      ${whereOf([...conds, 'l.is_active'])} GROUP BY 1, 2, 3 ORDER BY 1 DESC, n DESC`, b.params);
  for (const m of months) { const d = new Date(m.month + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); m.month_end = d.toISOString().slice(0, 10); }
  const b2 = new SqlBuilder();
  const subs = await db.query(
    `SELECT c.code AS cat_code, c.name AS category, sc.code AS sub_code, coalesce(sc.name, c.name) AS subcategory, count(DISTINCT i.id)::int AS n,
            count(DISTINCT i.id) FILTER (WHERE i.resolution_status = 'resolved')::int AS resolved,
            avg(i.resolution_seconds) FILTER (WHERE i.resolution_status = 'resolved') AS resolution,
            count(DISTINCT i.id) FILTER (WHERE i.is_repeat_contact)::int AS repeat
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
      ${whereOf([...interactionConds(s, f, b2), 'l.is_active'])} GROUP BY 1, 2, 3, 4 ORDER BY n DESC`, b2.params);
  const total = subs.reduce((a, r) => a + r.n, 0);
  subs.forEach((r) => { r.share = total ? r.n / total : null; r.resolved_rate = r.n ? r.resolved / r.n : null; });
  const reasons = await getTopReasons(db, s, f, 25);
  const st = await baseStats(db, s, f);
  return {
    sampleSize: st.n, sampleUnit: 'interactions', hasDemo: st.demo,
    notes: ['Counts are distinct interactions with an active label; one interaction can appear under several categories.', 'Months are calendar months in IST; partial months at the range edges are included as-is.'],
    sections: [
      { title: 'Issues by month and category', columns: [
        { key: 'month', label: 'Month', kind: 'date' }, { key: 'category', label: 'Category', href: '/inbox?from={month}&to={month_end}&category={cat_code}' }, { key: 'n', label: 'Interactions', kind: 'num' },
      ], rows: months },
      { title: 'Subcategory breakdown', columns: [
        { key: 'subcategory', label: 'Subcategory', href: '/inbox?category={cat_code}&subcategory={sub_code}' }, { key: 'category', label: 'Category' },
        { key: 'n', label: 'Interactions', kind: 'num' }, { key: 'share', label: 'Share of labels', kind: 'pct' }, { key: 'resolved_rate', label: 'Resolved', kind: 'pct' },
        { key: 'resolution', label: 'Avg resolution', kind: 'dur' }, { key: 'repeat', label: 'Repeat contacts', kind: 'num' },
      ], rows: subs },
      { title: 'Top customer-reported reasons', columns: [
        { key: 'reason', label: 'Customer’s stated reason', href: '/inbox?category={cat_code}&subcategory={sub_code}' }, { key: 'sub_name', label: 'Most common subcategory' }, { key: 'n', label: 'Interactions', kind: 'num' },
      ], rows: reasons },
    ],
  };
}

// ───────────────────────── 4. Call quality audit ─────────────────────────
async function callQuality(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const fc: AFilters = { ...f, channel: 'call' };
  const b = new SqlBuilder();
  const conds = interactionConds(s, fc, b);
  const byAgent = await db.query(
    `SELECT i.agent_id, coalesce(a.name, 'Unassigned') AS agent, count(*)::int AS calls,
            count(*) FILTER (WHERE c.call_status = 'answered')::int AS answered, count(*) FILTER (WHERE c.call_status = 'missed')::int AS missed,
            avg(c.duration_seconds) FILTER (WHERE c.call_status = 'answered') AS duration, avg(c.ring_seconds) AS ring,
            count(i.quality_score)::int AS evaluated, round(avg(i.quality_score), 1)::float AS quality,
            count(*) FILTER (WHERE i.quality_score < ${b.p(s.org.settings.reviewThreshold)})::int AS below,
            (SELECT count(*) FROM quality_flags fl WHERE fl.interaction_id = ANY(array_agg(i.id)) AND fl.status IN ('confirmed','coaching_assigned','resolved'))::int AS confirmed
       FROM interactions i JOIN calls c ON c.interaction_id = i.id LEFT JOIN agents a ON a.id = i.agent_id
      ${whereOf(conds)} GROUP BY 1, 2 ORDER BY 2`, b.params);
  byAgent.forEach((r) => { if (r.evaluated < 5) r.quality = null; });
  const b2 = new SqlBuilder();
  const list = await db.query(
    `SELECT i.id, i.ref, i.occurred_at, coalesce(a.name, 'Unassigned') AS agent, c.call_status, c.duration_seconds, i.quality_score, i.quality_band,
            i.review_status, i.sentiment, i.resolution_status,
            (SELECT count(*) FROM quality_flags fl WHERE fl.interaction_id = i.id)::int AS flags
       FROM interactions i JOIN calls c ON c.interaction_id = i.id LEFT JOIN agents a ON a.id = i.agent_id
      ${whereOf(interactionConds(s, fc, b2))} ORDER BY i.quality_score NULLS LAST, i.occurred_at DESC LIMIT ${LIST_LIMIT}`, b2.params);
  const st = await baseStats(db, s, fc);
  return {
    sampleSize: st.n, sampleUnit: 'calls', hasDemo: st.demo,
    notes: [`“Below threshold” = quality score under the review threshold (${s.org.settings.reviewThreshold}). Agent averages are blank with fewer than 5 evaluated calls.`],
    sections: [
      { title: 'Call quality by agent', columns: [
        { key: 'agent', label: 'Agent', href: '/inbox?channel=call&agent={agent_id}' }, { key: 'calls', label: 'Calls', kind: 'num' }, { key: 'answered', label: 'Answered', kind: 'num' },
        { key: 'missed', label: 'Missed', kind: 'num' }, { key: 'duration', label: 'Avg talk time', kind: 'dur' }, { key: 'ring', label: 'Avg ring time', kind: 'dur' },
        { key: 'evaluated', label: 'Evaluated', kind: 'num' }, { key: 'quality', label: 'Avg quality', kind: 'score' }, { key: 'below', label: 'Below threshold', kind: 'num' },
        { key: 'confirmed', label: 'Confirmed issues', kind: 'num' },
      ], rows: byAgent },
      { title: 'Calls audited (lowest score first)', truncated: list.length >= LIST_LIMIT, columns: [
        { key: 'ref', label: 'Call', href: '/inbox/{id}' }, { key: 'occurred_at', label: 'Date', kind: 'datetime' }, { key: 'agent', label: 'Agent' },
        { key: 'call_status', label: 'Status' }, { key: 'duration_seconds', label: 'Duration', kind: 'dur' }, { key: 'quality_score', label: 'Score', kind: 'score' },
        { key: 'quality_band', label: 'Band' }, { key: 'review_status', label: 'Review' }, { key: 'flags', label: 'Alerts', kind: 'num' }, { key: 'sentiment', label: 'Sentiment' },
      ], rows: list },
    ],
  };
}

// ───────────────────────── 5. WhatsApp & email quality ─────────────────────────
async function textQuality(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = [...interactionConds(s, f, b), `i.channel IN ('chat','whatsapp','email')`];
  const sla = slaCase(s, b);
  const summary = await db.query(
    `SELECT i.channel, i.agent_id, coalesce(a.name, 'Unassigned') AS agent, count(*)::int AS threads,
            avg(i.first_response_seconds) AS frt,
            count(*) FILTER (WHERE i.first_response_seconds > ${sla} * 60)::int AS frt_breaches,
            count(i.quality_score)::int AS evaluated, round(avg(i.quality_score), 1)::float AS quality,
            count(*) FILTER (WHERE i.resolution_status = 'resolved')::float / NULLIF(count(*), 0) AS resolved_rate,
            count(*) FILTER (WHERE i.sentiment = 'negative')::int AS negative
       FROM interactions i LEFT JOIN agents a ON a.id = i.agent_id ${whereOf(conds)} GROUP BY 1, 2, 3 ORDER BY 1, 3`, b.params);
  summary.forEach((r) => { if (r.evaluated < 5) r.quality = null; });
  const b2 = new SqlBuilder();
  const sla2 = slaCase(s, b2);
  const list = await db.query(
    `SELECT i.id, i.ref, i.channel, i.occurred_at, coalesce(a.name, 'Unassigned') AS agent, i.first_response_seconds, ${sla2} * 60 AS sla_seconds,
            i.quality_score, i.review_status, i.resolution_status, i.sentiment, (SELECT count(*) FROM quality_flags fl WHERE fl.interaction_id = i.id)::int AS flags
       FROM interactions i LEFT JOIN agents a ON a.id = i.agent_id
      ${whereOf([...interactionConds(s, f, b2), `i.channel IN ('chat','whatsapp','email')`])} ORDER BY i.quality_score NULLS LAST, i.occurred_at DESC LIMIT ${LIST_LIMIT}`, b2.params);
  const st = await baseStats(db, s, f);
  return {
    sampleSize: summary.reduce((a, r) => a + r.threads, 0), sampleUnit: 'chat, WhatsApp and email threads', hasDemo: st.demo,
    notes: ['First-response SLA per channel comes from System Settings (chat/WhatsApp/email minutes). Agent averages are blank with fewer than 5 evaluated threads.'],
    sections: [
      { title: 'Quality by channel and agent', columns: [
        { key: 'channel', label: 'Channel' }, { key: 'agent', label: 'Agent', href: '/inbox?channel={channel}&agent={agent_id}' }, { key: 'threads', label: 'Threads', kind: 'num' },
        { key: 'frt', label: 'Avg first response', kind: 'dur' }, { key: 'frt_breaches', label: 'First-response SLA breaches', kind: 'num' },
        { key: 'evaluated', label: 'Evaluated', kind: 'num' }, { key: 'quality', label: 'Avg quality', kind: 'score' }, { key: 'resolved_rate', label: 'Resolved', kind: 'pct' },
        { key: 'negative', label: 'Negative sentiment', kind: 'num' },
      ], rows: summary },
      { title: 'Threads audited (lowest score first)', truncated: list.length >= LIST_LIMIT, columns: [
        { key: 'ref', label: 'Thread', href: '/inbox/{id}' }, { key: 'channel', label: 'Channel' }, { key: 'occurred_at', label: 'Date', kind: 'datetime' }, { key: 'agent', label: 'Agent' },
        { key: 'first_response_seconds', label: 'First response', kind: 'dur' }, { key: 'sla_seconds', label: 'SLA', kind: 'dur' }, { key: 'quality_score', label: 'Score', kind: 'score' },
        { key: 'review_status', label: 'Review' }, { key: 'resolution_status', label: 'Status' }, { key: 'flags', label: 'Alerts', kind: 'num' },
      ], rows: list },
    ],
  };
}

// ───────────────────────── 6. Refund & replacement analysis ─────────────────────────
async function refundReplacement(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = [...interactionConds(s, f, b), 'l.is_active', `c.code IN ('refund','replacement')`];
  const summary = await db.query(
    `SELECT c.code AS cat_code, c.name AS category, sc.code AS sub_code, coalesce(sc.name, c.name) AS subcategory, count(DISTINCT i.id)::int AS n,
            count(DISTINCT i.id) FILTER (WHERE i.resolution_status = 'resolved')::int AS resolved,
            count(DISTINCT i.id) FILTER (WHERE l.escalated OR i.resolution_status = 'escalated')::int AS escalated,
            avg(i.resolution_seconds) FILTER (WHERE i.resolution_status = 'resolved') AS resolution,
            string_agg(DISTINCT l.replacement_status, ', ') FILTER (WHERE l.replacement_status IS NOT NULL) AS replacement_statuses,
            sum(l.refund_amount) FILTER (WHERE l.refund_amount IS NOT NULL AND l.refund_amount_source IS NOT NULL) AS recorded_value,
            count(*) FILTER (WHERE l.refund_amount IS NOT NULL AND l.refund_amount_source IS NOT NULL)::int AS recorded_n
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id ${whereOf(conds)} GROUP BY 1, 2, 3, 4 ORDER BY 2, n DESC`, b.params);
  const b2 = new SqlBuilder();
  const list = await db.query(
    `SELECT i.id, i.ref, i.occurred_at, cu.name AS customer_name, cu.phone AS customer_phone, coalesce(l.product, i.product) AS product,
            c.name AS category, coalesce(sc.name, c.name) AS subcategory, l.resolution_requested, l.resolution_provided, l.replacement_status,
            i.resolution_status, CASE WHEN l.refund_amount_source IS NOT NULL THEN l.refund_amount END AS amount, l.refund_amount_source AS amount_source,
            coalesce(a.name, 'Unassigned') AS agent
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id LEFT JOIN customers cu ON cu.id = i.customer_id LEFT JOIN agents a ON a.id = i.agent_id
      ${whereOf([...interactionConds(s, f, b2), 'l.is_active', `c.code IN ('refund','replacement')`])} ORDER BY i.occurred_at DESC LIMIT ${LIST_LIMIT}`, b2.params);
  const pii = s.permissions.has('customer_pii.view');
  for (const r of list) {
    r.customer = pii ? [r.customer_name, r.customer_phone].filter(Boolean).join(' · ') || '—' : maskPhone(r.customer_phone);
    delete r.customer_name; delete r.customer_phone;
  }
  const anyValue = summary.some((r) => r.recorded_n > 0);
  const st = await baseStats(db, s, { ...f, category: f.category ?? null });
  return {
    sampleSize: new Set(list.map((r) => r.id)).size, sampleUnit: 'refund/replacement interactions', hasDemo: st.demo,
    notes: [
      anyValue ? 'Values come only from labels whose refund amount is backed by a financial record (refund_amount_source).' : 'No financial records connected — refund/replacement values are not shown and never estimated.',
      pii ? 'Customer details are shown because you have permission to view customer PII.' : 'Customer phone numbers are masked (no customer-PII permission).',
    ],
    sections: [
      { title: 'Volumes by subcategory', columns: [
        { key: 'category', label: 'Category' }, { key: 'subcategory', label: 'Subcategory', href: '/inbox?category={cat_code}&subcategory={sub_code}' },
        { key: 'n', label: 'Interactions', kind: 'num' }, { key: 'resolved', label: 'Resolved', kind: 'num' }, { key: 'escalated', label: 'Escalated', kind: 'num' },
        { key: 'resolution', label: 'Avg resolution', kind: 'dur' }, { key: 'replacement_statuses', label: 'Replacement statuses seen' },
        ...(anyValue ? [{ key: 'recorded_value', label: 'Recorded value', kind: 'inr' as ColKind }, { key: 'recorded_n', label: 'Records', kind: 'num' as ColKind }] : []),
      ], rows: summary },
      { title: 'Cases', truncated: list.length >= LIST_LIMIT, columns: [
        { key: 'ref', label: 'Interaction', href: '/inbox/{id}' }, { key: 'occurred_at', label: 'Date', kind: 'datetime' }, { key: 'customer', label: 'Customer' },
        { key: 'product', label: 'Product' }, { key: 'subcategory', label: 'Issue' }, { key: 'resolution_requested', label: 'Requested' },
        { key: 'resolution_provided', label: 'Provided' }, { key: 'replacement_status', label: 'Replacement status' }, { key: 'resolution_status', label: 'Status' },
        ...(anyValue ? [{ key: 'amount', label: 'Recorded amount', kind: 'inr' as ColKind }] : []), { key: 'agent', label: 'Agent' },
      ], rows: list },
    ],
  };
}

// ───────────────────────── 7. Product complaint report ─────────────────────────
async function productComplaints(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = [...interactionConds(s, f, b), 'l.is_active', `c.code <> ALL(${b.p(NON_COMPLAINT)})`];
  const byProduct = await db.query(
    `SELECT coalesce(l.product, i.product, 'Unknown') AS product, count(DISTINCT i.id)::int AS n,
            count(DISTINCT i.id) FILTER (WHERE c.code = 'quality')::int AS quality_n,
            count(DISTINCT i.id) FILTER (WHERE c.code IN ('refund','replacement'))::int AS refund_repl_n,
            count(DISTINCT i.id) FILTER (WHERE c.code = 'delivery')::int AS delivery_n,
            count(DISTINCT i.id) FILTER (WHERE l.severity IN ('critical','high'))::int AS high_n,
            count(DISTINCT rc.id) FILTER (WHERE rc.status = 'confirmed')::int AS confirmed_causes,
            count(DISTINCT rc.id) FILTER (WHERE rc.status = 'suspected')::int AS suspected_causes,
            mode() WITHIN GROUP (ORDER BY coalesce(sc.name, c.name)) AS top_issue
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id LEFT JOIN issue_root_causes rc ON rc.label_id = l.id
      ${whereOf(conds)} GROUP BY 1 ORDER BY n DESC`, b.params);
  const b2 = new SqlBuilder();
  const matrix = await db.query(
    `SELECT coalesce(l.product, i.product, 'Unknown') AS product, c.code AS cat_code, sc.code AS sub_code, coalesce(sc.name, c.name) AS issue,
            count(DISTINCT i.id)::int AS n, string_agg(DISTINCT rc.cause, ' | ') FILTER (WHERE rc.status = 'confirmed') AS confirmed_cause
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id LEFT JOIN issue_root_causes rc ON rc.label_id = l.id
      ${whereOf([...interactionConds(s, f, b2), 'l.is_active', `c.code <> ALL(${b2.p(NON_COMPLAINT)})`])} GROUP BY 1, 2, 3, 4 ORDER BY 1, n DESC`, b2.params);
  const st = await baseStats(db, s, f);
  return {
    sampleSize: byProduct.reduce((a, r) => a + r.n, 0), sampleUnit: 'complaint interactions (summed across products)', hasDemo: st.demo,
    notes: ['Suspected root causes are AI inferences and are not treated as established. Only confirmed causes are listed by name.'],
    sections: [
      { title: 'Complaints by product', columns: [
        { key: 'product', label: 'Product', href: '/inbox?product={product}&complaints=1' }, { key: 'n', label: 'Complaints', kind: 'num' }, { key: 'quality_n', label: 'Quality', kind: 'num' },
        { key: 'refund_repl_n', label: 'Refund/replacement', kind: 'num' }, { key: 'delivery_n', label: 'Delivery', kind: 'num' }, { key: 'high_n', label: 'High/critical', kind: 'num' },
        { key: 'top_issue', label: 'Most common issue' }, { key: 'confirmed_causes', label: 'Confirmed causes', kind: 'num' }, { key: 'suspected_causes', label: 'Suspected (AI)', kind: 'num' },
      ], rows: byProduct },
      { title: 'Product × issue', columns: [
        { key: 'product', label: 'Product' }, { key: 'issue', label: 'Issue', href: '/inbox?product={product}&category={cat_code}&subcategory={sub_code}' },
        { key: 'n', label: 'Interactions', kind: 'num' }, { key: 'confirmed_cause', label: 'Confirmed root cause' },
      ], rows: matrix },
    ],
  };
}

// ───────────────────────── 8. SLA breach report ─────────────────────────
async function slaBreach(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const sla = slaCase(s, b);
  const resH = b.p(s.org.settings.sla.resolutionHours);
  const rows = await db.query(
    `WITH x AS (
       SELECT i.id, i.ref, i.channel, i.occurred_at, i.resolution_status, i.first_response_seconds, i.awaiting_agent_since, i.agent_id, i.team_id,
              coalesce(a.name, 'Unassigned') AS agent, t.name AS team, ${sla} * 60 AS sla_seconds,
              (i.channel <> 'call' AND i.first_response_seconds > ${sla} * 60) AS frt_breach,
              (i.resolution_status <> 'resolved' AND i.occurred_at < now() - make_interval(hours => ${resH}::int)) AS resolution_breach,
              (i.channel <> 'call' AND i.awaiting_agent_since IS NOT NULL AND i.resolution_status <> 'resolved'
                 AND i.awaiting_agent_since < now() - make_interval(mins => ${sla})) AS awaiting_breach,
              extract(epoch FROM now() - i.occurred_at)::int AS age_seconds
         FROM interactions i LEFT JOIN agents a ON a.id = i.agent_id LEFT JOIN teams t ON t.id = i.team_id
        ${whereOf(interactionConds(s, f, b))})
     SELECT *, concat_ws(', ', CASE WHEN frt_breach THEN 'First response' END, CASE WHEN awaiting_breach THEN 'Customer awaiting reply' END,
                       CASE WHEN resolution_breach THEN 'Unresolved past SLA' END) AS breach
       FROM x WHERE frt_breach OR resolution_breach OR awaiting_breach ORDER BY resolution_breach DESC, occurred_at LIMIT ${LIST_LIMIT}`, b.params);
  const byChannel = new Map<string, { channel: string; n: number; frt: number; awaiting: number; resolution: number }>();
  for (const r of rows) {
    const c = byChannel.get(r.channel) ?? { channel: r.channel, n: 0, frt: 0, awaiting: 0, resolution: 0 };
    c.n++; if (r.frt_breach) c.frt++; if (r.awaiting_breach) c.awaiting++; if (r.resolution_breach) c.resolution++;
    byChannel.set(r.channel, c);
  }
  const st = await baseStats(db, s, f);
  const m = s.org.settings.sla.firstResponseMinutes;
  return {
    sampleSize: st.n, sampleUnit: 'interactions checked', hasDemo: st.demo,
    notes: [
      `SLA settings: first response chat ${m.chat} min · WhatsApp ${m.whatsapp} min · email ${m.email} min; resolution ${s.org.settings.sla.resolutionHours} h.`,
      'Elapsed time is wall-clock; business-hours exclusion is applied by the SLA alert job, not this report.',
    ],
    sections: [
      { title: 'Breaches by channel', columns: [
        { key: 'channel', label: 'Channel', href: '/inbox?channel={channel}' }, { key: 'n', label: 'Interactions breaching', kind: 'num' },
        { key: 'frt', label: 'First response', kind: 'num' }, { key: 'awaiting', label: 'Awaiting reply', kind: 'num' }, { key: 'resolution', label: 'Unresolved past SLA', kind: 'num' },
      ], rows: Array.from(byChannel.values()) },
      { title: 'Breaching interactions', truncated: rows.length >= LIST_LIMIT, columns: [
        { key: 'ref', label: 'Interaction', href: '/inbox/{id}' }, { key: 'channel', label: 'Channel' }, { key: 'occurred_at', label: 'Opened', kind: 'datetime' },
        { key: 'agent', label: 'Agent' }, { key: 'team', label: 'Team' }, { key: 'breach', label: 'Breach' }, { key: 'first_response_seconds', label: 'First response', kind: 'dur' },
        { key: 'sla_seconds', label: 'First-response SLA', kind: 'dur' }, { key: 'resolution_status', label: 'Status' }, { key: 'age_seconds', label: 'Age', kind: 'dur' },
      ], rows },
    ],
  };
}

// ───────────────────────── 9. Coaching effectiveness ─────────────────────────
async function coachingEffectiveness(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = [coachingScope(s, b), `ca.status NOT IN ('draft')`, `ca.created_at >= ${b.p(f.from)}`, `ca.created_at <= ${b.p(f.to)}`];
  if (f.agentId) conds.push(`ca.agent_id = ${b.p(f.agentId)}`);
  if (f.teamId) conds.push(`a.team_id = ${b.p(f.teamId)}`);
  const lateral = `LEFT JOIN LATERAL (SELECT * FROM coaching_assignments x WHERE x.coaching_action_id = ca.id ORDER BY x.assigned_at DESC LIMIT 1) asg ON true`;
  const overdue = `(ca.review_date < (now() AT TIME ZONE 'Asia/Kolkata')::date AND ca.status IN ('assigned','acknowledged','in_progress','completed'))`;
  const byAgent = await db.query(
    `SELECT a.id AS agent_id, a.name AS agent, t.name AS team, count(*) FILTER (WHERE ca.status <> 'cancelled')::int AS assigned,
            count(*) FILTER (WHERE asg.acknowledged_at IS NOT NULL)::int AS acknowledged,
            count(*) FILTER (WHERE ca.status IN ('completed','reviewed'))::int AS completed,
            count(*) FILTER (WHERE ca.status = 'reviewed')::int AS reviewed,
            count(*) FILTER (WHERE asg.outcome = 'improved')::int AS improved,
            round(avg(asg.outcome_value - ca.baseline_value) FILTER (WHERE asg.outcome_value IS NOT NULL AND ca.baseline_value IS NOT NULL), 1)::float AS avg_delta,
            count(*) FILTER (WHERE ${overdue})::int AS overdue,
            avg(extract(epoch FROM asg.acknowledged_at - asg.assigned_at)) AS time_to_ack,
            coalesce(bool_or(ca.is_demo), false) AS demo
       FROM coaching_actions ca JOIN agents a ON a.id = ca.agent_id LEFT JOIN teams t ON t.id = a.team_id ${lateral}
      ${whereOf(conds)} GROUP BY 1, 2, 3 ORDER BY 2`, b.params);
  byAgent.forEach((r) => { r.completion = r.assigned ? r.completed / r.assigned : null; r.improved_rate = r.reviewed ? r.improved / r.reviewed : null; });
  const list = await db.query(
    `SELECT ca.id, ca.title, a.name AS agent, ca.status, ca.source, asg.assigned_at, ca.review_date, ${overdue} AS overdue,
            ca.target_metric, ca.baseline_value, ca.target_value, asg.outcome_value, asg.outcome, ca.is_demo
       FROM coaching_actions ca JOIN agents a ON a.id = ca.agent_id ${lateral}
      ${whereOf(conds)} ORDER BY asg.assigned_at DESC NULLS LAST LIMIT ${LIST_LIMIT}`, b.params);
  list.forEach((r) => { r.overdue = r.overdue ? 'Yes' : ''; });
  return {
    sampleSize: list.length, sampleUnit: 'coaching actions created in range', hasDemo: byAgent.some((r) => r.demo),
    notes: ['Measured value = target metric on the agent’s interactions after assignment, recorded at review (0–100 scale).', 'Date range applies to when the coaching was created.'],
    sections: [
      { title: 'Effectiveness by agent', columns: [
        { key: 'agent', label: 'Agent', href: '/coaching?agent={agent_id}' }, { key: 'team', label: 'Team' }, { key: 'assigned', label: 'Assigned', kind: 'num' },
        { key: 'acknowledged', label: 'Acknowledged', kind: 'num' }, { key: 'time_to_ack', label: 'Avg time to acknowledge', kind: 'dur' }, { key: 'completed', label: 'Completed', kind: 'num' },
        { key: 'completion', label: 'Completion', kind: 'pct' }, { key: 'reviewed', label: 'Reviewed', kind: 'num' }, { key: 'improved_rate', label: 'Improved', kind: 'pct' },
        { key: 'avg_delta', label: 'Avg change vs baseline', kind: 'dec' }, { key: 'overdue', label: 'Overdue reviews', kind: 'num' },
      ], rows: byAgent },
      { title: 'Coaching actions', truncated: list.length >= LIST_LIMIT, columns: [
        { key: 'title', label: 'Coaching', href: '/coaching/{id}' }, { key: 'agent', label: 'Agent' }, { key: 'status', label: 'Status' }, { key: 'source', label: 'Source' },
        { key: 'assigned_at', label: 'Assigned', kind: 'date' }, { key: 'review_date', label: 'Review date', kind: 'date' }, { key: 'overdue', label: 'Overdue' },
        { key: 'target_metric', label: 'Metric' }, { key: 'baseline_value', label: 'Baseline', kind: 'dec' }, { key: 'target_value', label: 'Target', kind: 'dec' },
        { key: 'outcome_value', label: 'Measured', kind: 'dec' }, { key: 'outcome', label: 'Outcome' },
      ], rows: list },
    ],
  };
}

// ───────────────────────── 10. AI false-positive & correction report ─────────────────────────
async function aiCorrections(db: Db, s: Session, f: AFilters): Promise<ReportResult> {
  const b = new SqlBuilder();
  const conds = [...interactionConds(s, noSev(f), b), ...flagSeverity(f, b)];
  const byRule = await db.query(
    `SELECT fl.rule_code, max(r.name) AS rule, max(fl.severity) AS severity, count(*)::int AS total,
            count(*) FILTER (WHERE fl.status IN ('confirmed','coaching_assigned','resolved','false_positive'))::int AS reviewed,
            count(*) FILTER (WHERE fl.status IN ('confirmed','coaching_assigned','resolved'))::int AS confirmed,
            count(*) FILTER (WHERE fl.status = 'false_positive')::int AS false_positive,
            count(*) FILTER (WHERE fl.status IN ('new','under_review'))::int AS pending,
            round(avg(fl.confidence), 2)::float AS avg_confidence
       FROM quality_flags fl JOIN interactions i ON i.id = fl.interaction_id LEFT JOIN alert_rules r ON r.code = fl.rule_code
      ${whereOf(conds)} GROUP BY 1 ORDER BY total DESC`, b.params);
  byRule.forEach((r) => { r.fp_rate = r.reviewed ? r.false_positive / r.reviewed : null; });
  const b2 = new SqlBuilder();
  const pairs = await db.query(
    `WITH ai AS (SELECT DISTINCT ON (e.interaction_id) e.interaction_id, e.overall_score FROM quality_evaluations e WHERE e.evaluator_type = 'ai' ORDER BY e.interaction_id, e.created_at DESC),
          hu AS (SELECT DISTINCT ON (e.interaction_id) e.interaction_id, e.overall_score, e.created_at, u.name AS reviewer FROM quality_evaluations e
                   LEFT JOIN users u ON u.id = e.evaluator_user_id WHERE e.evaluator_type = 'human' ORDER BY e.interaction_id, e.created_at DESC)
     SELECT i.id, i.ref, i.channel, coalesce(a.name, 'Unassigned') AS agent, ai.overall_score AS ai_score, hu.overall_score AS human_score,
            round(hu.overall_score - ai.overall_score, 1)::float AS delta, hu.reviewer, hu.created_at AS reviewed_at
       FROM interactions i JOIN ai ON ai.interaction_id = i.id JOIN hu ON hu.interaction_id = i.id LEFT JOIN agents a ON a.id = i.agent_id
      ${whereOf(interactionConds(s, noSev(f), b2))} ORDER BY abs(hu.overall_score - ai.overall_score) DESC NULLS LAST LIMIT ${LIST_LIMIT}`, b2.params);
  const b3 = new SqlBuilder();
  const decisions = await db.query(
    `SELECT rd.target_type, rd.decision, count(*)::int AS n, count(DISTINCT rd.reviewer_id)::int AS reviewers
       FROM reviewer_decisions rd JOIN interactions i ON i.id = rd.interaction_id
      ${whereOf([...interactionConds(s, noSev(f), b3), `rd.created_at >= ${b3.p(f.from)}`, `rd.created_at <= ${b3.p(f.to)}`])}
      GROUP BY 1, 2 ORDER BY 1, n DESC`, b3.params);
  const total = byRule.reduce((a, r) => a + r.total, 0);
  const reviewed = byRule.reduce((a, r) => a + r.reviewed, 0);
  const fp = byRule.reduce((a, r) => a + r.false_positive, 0);
  const meanAbs = pairs.length ? pairs.reduce((a, p) => a + Math.abs(Number(p.delta ?? 0)), 0) / pairs.length : null;
  const st = await baseStats(db, s, noSev(f));
  return {
    sampleSize: total, sampleUnit: 'AI alerts on interactions in range', hasDemo: st.demo,
    notes: [
      `Overall false-positive rate: ${reviewed ? ((fp / reviewed) * 100).toFixed(1) + '%' : '—'} (${fp} of ${reviewed} reviewed alerts).`,
      pairs.length ? `Human vs AI score: ${pairs.length} interactions with both evaluations; mean absolute difference ${meanAbs!.toFixed(1)} points.` : 'No interactions have both an AI and a human evaluation yet.',
      'Reviewer decisions are counted by when the decision was made (within the date range).',
    ],
    sections: [
      { title: 'Alert accuracy by rule', columns: [
        { key: 'rule', label: 'Rule', href: '/quality?rule={rule_code}' }, { key: 'severity', label: 'Severity' }, { key: 'total', label: 'Alerts', kind: 'num' },
        { key: 'reviewed', label: 'Reviewed', kind: 'num' }, { key: 'confirmed', label: 'Confirmed', kind: 'num' }, { key: 'false_positive', label: 'False positive', kind: 'num' },
        { key: 'fp_rate', label: 'False-positive rate', kind: 'pct' }, { key: 'pending', label: 'Pending', kind: 'num' }, { key: 'avg_confidence', label: 'Avg AI confidence', kind: 'dec' },
      ], rows: byRule.map((r) => ({ ...r, rule: r.rule ?? r.rule_code })) },
      { title: 'Human vs AI quality scores', description: 'Latest AI evaluation vs latest human evaluation of the same interaction, largest disagreement first.', truncated: pairs.length >= LIST_LIMIT, columns: [
        { key: 'ref', label: 'Interaction', href: '/inbox/{id}' }, { key: 'channel', label: 'Channel' }, { key: 'agent', label: 'Agent' },
        { key: 'ai_score', label: 'AI score', kind: 'score' }, { key: 'human_score', label: 'Human score', kind: 'score' }, { key: 'delta', label: 'Human − AI', kind: 'dec' },
        { key: 'reviewer', label: 'Reviewer' }, { key: 'reviewed_at', label: 'Reviewed', kind: 'datetime' },
      ], rows: pairs },
      { title: 'Reviewer decisions', columns: [
        { key: 'target_type', label: 'Target' }, { key: 'decision', label: 'Decision' }, { key: 'n', label: 'Decisions', kind: 'num' }, { key: 'reviewers', label: 'Reviewers', kind: 'num' },
      ], rows: decisions },
    ],
  };
}

export const REPORTS: ReportDef[] = [
  { key: 'daily-crm', title: 'Daily CRM summary', cadence: 'Daily', defaultRange: '7d', filters: ['channel', 'team', 'agent', 'category', 'severity'],
    description: 'Volumes, missed calls, resolution, response times, quality and open critical alerts per day.', run: dailyCrm },
  { key: 'weekly-team', title: 'Weekly team performance', cadence: 'Weekly', defaultRange: '30d', filters: ['channel', 'team', 'category'],
    description: 'Team-level quality, first-contact resolution and response times by week, plus each agent’s outcomes.', run: weeklyTeam },
  { key: 'monthly-issues', title: 'Monthly customer issue analysis', cadence: 'Monthly', defaultRange: '90d', filters: ['channel', 'team', 'agent', 'category', 'product', 'severity'],
    description: 'Issue categories by month, subcategory breakdown with resolution, and top customer-stated reasons.', run: monthlyIssues },
  { key: 'call-quality', title: 'Call quality audit', cadence: 'Weekly', defaultRange: '30d', filters: ['team', 'agent', 'category', 'product', 'severity'],
    description: 'Call handling and quality per agent, and every audited call with score, band and alerts.', run: callQuality },
  { key: 'text-quality', title: 'WhatsApp & email quality', cadence: 'Weekly', defaultRange: '30d', filters: ['channel', 'team', 'agent', 'category', 'product'],
    description: 'Chat, WhatsApp and email response times, SLA breaches and quality per channel and agent.', run: textQuality },
  { key: 'refund-replacement', title: 'Refund & replacement analysis', cadence: 'Monthly', defaultRange: '30d', filters: ['channel', 'team', 'agent', 'product', 'severity'],
    description: 'Refund and replacement volumes, outcomes and statuses; values only from connected financial records.', run: refundReplacement },
  { key: 'product-complaints', title: 'Product complaint report', cadence: 'Monthly', defaultRange: '90d', filters: ['channel', 'team', 'category', 'product', 'severity'],
    description: 'Complaints per product with issue mix, severity and confirmed vs suspected root causes.', run: productComplaints },
  { key: 'sla-breach', title: 'SLA breach report', cadence: 'Daily', defaultRange: '7d', filters: ['channel', 'team', 'agent', 'category'],
    description: 'Interactions whose first response exceeded the SLA, customers left waiting, or still unresolved past the resolution SLA.', run: slaBreach },
  { key: 'coaching-effectiveness', title: 'Coaching effectiveness', cadence: 'Monthly', defaultRange: '90d', filters: ['team', 'agent'],
    description: 'Coaching completion, acknowledgement time and measured improvement against baseline, per agent.', run: coachingEffectiveness },
  { key: 'ai-corrections', title: 'AI false-positive & correction report', cadence: 'Monthly', defaultRange: '90d', filters: ['channel', 'team', 'agent', 'severity'],
    description: 'Alert accuracy by rule, human vs AI score differences and reviewer decisions — how well the AI is doing.', run: aiCorrections },
];

export function getReport(key: string) { return REPORTS.find((r) => r.key === key) ?? null; }

/** Restrict agent/team filters to the caller's scope before running a report. */
export async function sanitiseReportFilters(db: Db, s: Session, f: AFilters): Promise<AFilters> {
  const out = { ...f };
  if (out.agentId) {
    const b = new SqlBuilder();
    const ok = await db.one(`SELECT 1 FROM agents WHERE id = ${b.p(out.agentId)} AND ${scopeAgents(s, b, 'id')}`, b.params);
    if (!ok) out.agentId = '00000000-0000-0000-0000-000000000000';
  }
  return out;
}

/** Parse report filters from URL params (shared by the report page and the CSV route). */
export function parseReportFilters(def: ReportDef, searchParams: SP): { range: DateRange; f: AFilters } {
  const range = parseRange(searchParams, def.defaultRange);
  const has = (k: ReportFilterKey) => def.filters.includes(k);
  const uuidParam = (k: string) => { const v = sp(searchParams, k); return v && isUuid(v) ? v : null; };
  const sev = sp(searchParams, 'severity');
  return {
    range,
    f: {
      from: range.from, to: range.to,
      channel: has('channel') ? parseChannel(searchParams) : null,
      teamId: has('team') ? uuidParam('team') : null,
      agentId: has('agent') ? uuidParam('agent') : null,
      category: has('category') ? sp(searchParams, 'category') ?? null : null,
      product: has('product') ? sp(searchParams, 'product') ?? null : null,
      severity: has('severity') && sev && (SEVERITIES as readonly string[]).includes(sev) ? sev : null,
    },
  };
}
