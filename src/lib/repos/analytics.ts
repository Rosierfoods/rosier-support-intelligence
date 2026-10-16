import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { isUuid } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeAgents, scopeInteractions } from '@/lib/repos/scope';
import { CHANNELS, SEVERITIES, type Channel } from '@/lib/constants';

/**
 * Shared analytics filters + Customer Issues & Root Causes queries (spec §11–12).
 * Every query applies the role data scope (scopeInteractions / scopeAgents) and runs inside withOrg (RLS).
 * "Issue" = an active interaction_issue_labels row. Counts are DISTINCT interactions unless stated otherwise,
 * because one interaction can carry several labels.
 */

export interface AFilters {
  from: Date; to: Date;
  channel?: Channel | null;
  product?: string | null;
  agentId?: string | null;
  teamId?: string | null;
  category?: string | null;   // top-level category code
  severity?: string | null;
}

/** Complaint categories: everything except Product Information and Other (matches the dashboard definition). */
export const NON_COMPLAINT = ['product_info', 'other'];
export const DAMAGED_SUBS = ['replacement.damaged', 'quality.packaging_damage', 'quality.ghee_broken'];

export const ISSUE_METRIC_DEFS: Record<string, string> = {
  refunds: 'Distinct interactions in range with at least one active Refund label.',
  replacements: 'Distinct interactions in range with at least one active Replacement label.',
  ghee_leak: 'Distinct interactions with an active "Ghee jar leaking" label (quality.ghee_leak).',
  damaged: 'Distinct interactions with an active Damaged product (replacement.damaged), Packaging damage (quality.packaging_damage) or Broken/cracked ghee jar (quality.ghee_broken) label.',
  delivery: 'Distinct interactions with at least one active Delivery label.',
  fcr: 'Resolved complaint interactions that were not reopened and had no further contact from the same customer within the repeat-contact window ÷ all resolved complaint interactions. Complaint = any category except Product Information and Other.',
  avg_resolution: 'Mean resolution_seconds of resolved complaint interactions in range.',
  repeat: 'Customers (matched by stored customer record) with two or more complaint interactions in range. Interactions without a customer record are excluded, so this is a lower bound.',
  refund_value: 'Sum of refund_amount on active labels whose refund_amount_source is set (i.e. backed by a financial record). Never estimated.',
  pareto: 'Subcategories ranked by distinct complaint interactions; cumulative % = running total ÷ sum of all subcategory counts (an interaction with two subcategories counts in both).',
  comparison: 'Distinct interactions with the label in the current window vs the immediately preceding window of equal length, same filters. A statement is generated only when the current window has ≥10 and the previous window ≥5 interactions.',
};

/** Returns SQL conditions (does not push) so the same filters can be applied to several windows/aliases. */
export function interactionConds(s: Session, f: AFilters, b: SqlBuilder, a = 'i', opts: { skipDates?: boolean } = {}): string[] {
  const c: string[] = [];
  if (!opts.skipDates) {
    c.push(`${a}.occurred_at >= ${b.p(f.from)}`, `${a}.occurred_at <= ${b.p(f.to)}`);
  }
  if (f.channel && (CHANNELS as readonly string[]).includes(f.channel)) c.push(`${a}.channel = ${b.p(f.channel)}`);
  if (f.agentId && isUuid(f.agentId)) c.push(`${a}.agent_id = ${b.p(f.agentId)}`);
  if (f.teamId && isUuid(f.teamId)) c.push(`${a}.team_id = ${b.p(f.teamId)}`);
  if (f.product) {
    const p = b.p(f.product);
    c.push(`(${a}.product = ${p} OR EXISTS (SELECT 1 FROM interaction_issue_labels pl WHERE pl.interaction_id = ${a}.id AND pl.is_active AND pl.product = ${p}))`);
  }
  if (f.category) {
    c.push(`EXISTS (SELECT 1 FROM interaction_issue_labels cl JOIN issue_categories cc ON cc.id = cl.category_id
              WHERE cl.interaction_id = ${a}.id AND cl.is_active AND cc.code = ${b.p(f.category)})`);
  }
  if (f.severity && (SEVERITIES as readonly string[]).includes(f.severity)) {
    c.push(`EXISTS (SELECT 1 FROM interaction_issue_labels sl WHERE sl.interaction_id = ${a}.id AND sl.is_active AND sl.severity = ${b.p(f.severity)})`);
  }
  c.push(scopeInteractions(s, b, a));
  return c;
}

export function whereOf(conds: string[]) {
  return conds.length ? 'WHERE ' + conds.join(' AND ') : '';
}

/** Filter dropdown options limited to what the caller may see. */
export async function getFilterOptions(db: Db, s: Session) {
  const b = new SqlBuilder();
  const agents = await db.query<{ id: string; name: string; team_id: string | null }>(
    `SELECT a.id, a.name, a.team_id FROM agents a WHERE ${scopeAgents(s, b, 'a.id')} ORDER BY a.is_active DESC, a.name`, b.params);
  const b2 = new SqlBuilder();
  const products = await db.query<{ product: string }>(
    `SELECT DISTINCT p AS product FROM (
        SELECT i.product AS p FROM interactions i WHERE i.product IS NOT NULL AND ${scopeInteractions(s, b2, 'i')}
        UNION SELECT l.product FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id
         WHERE l.product IS NOT NULL AND l.is_active AND ${scopeInteractions(s, b2, 'i')}) x ORDER BY 1`, b2.params);
  const categories = await db.query<{ code: string; name: string }>(
    `SELECT code, name FROM issue_categories WHERE parent_id IS NULL AND is_active ORDER BY sort, name`);
  const b3 = new SqlBuilder();
  const teams = await db.query<{ id: string; name: string }>(
    s.scope === 'all' ? `SELECT id, name FROM teams ORDER BY name`
      : `SELECT id, name FROM teams WHERE id = ${b3.p(s.user.teamId ?? '00000000-0000-0000-0000-000000000000')} ORDER BY name`, b3.params);
  return { agents, products: products.map((p) => p.product), categories, teams };
}

// ───────────────────────── Customer issue KPIs ─────────────────────────
export async function getIssueKpis(db: Db, s: Session, f: AFilters) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const win = b.p(s.org.settings.repeatContactWindowDays);
  const nc = b.p(NON_COMPLAINT);
  const dmg = b.p(DAMAGED_SUBS);
  return (await db.one(
    `WITH base AS (SELECT i.* FROM interactions i ${whereOf(conds)}),
     lab AS (
       SELECT l.*, c.code AS cat, sc.code AS sub FROM interaction_issue_labels l
         JOIN base ON base.id = l.interaction_id
         JOIN issue_categories c ON c.id = l.category_id
         LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
        WHERE l.is_active),
     comp AS (SELECT * FROM base WHERE EXISTS (SELECT 1 FROM lab WHERE lab.interaction_id = base.id AND lab.cat <> ALL(${nc}))),
     res AS (
       SELECT r.id, NOT r.reopened AND NOT EXISTS (
         SELECT 1 FROM interactions n WHERE n.customer_id = r.customer_id AND r.customer_id IS NOT NULL
            AND n.occurred_at > r.occurred_at AND n.occurred_at <= r.occurred_at + make_interval(days => ${win})) AS fcr
         FROM comp r WHERE r.resolution_status = 'resolved')
     SELECT
       (SELECT count(*) FROM base)::int AS interactions,
       (SELECT count(*) FROM comp)::int AS complaints,
       (SELECT count(DISTINCT interaction_id) FROM lab WHERE cat = 'refund')::int AS refunds,
       (SELECT count(DISTINCT interaction_id) FROM lab WHERE cat = 'replacement')::int AS replacements,
       (SELECT count(DISTINCT interaction_id) FROM lab WHERE sub = 'quality.ghee_leak')::int AS ghee_leak,
       (SELECT count(DISTINCT interaction_id) FROM lab WHERE sub = ANY(${dmg}))::int AS damaged,
       (SELECT count(DISTINCT interaction_id) FROM lab WHERE cat = 'delivery')::int AS delivery,
       (SELECT count(*) FILTER (WHERE fcr)::float / NULLIF(count(*), 0) FROM res) AS fcr,
       (SELECT count(*) FROM res)::int AS resolved_n,
       (SELECT avg(resolution_seconds) FROM comp WHERE resolution_status = 'resolved') AS avg_resolution,
       (SELECT count(*) FROM (SELECT customer_id FROM comp WHERE customer_id IS NOT NULL GROUP BY 1 HAVING count(*) >= 2) x)::int AS repeat_customers,
       (SELECT count(*) FROM comp WHERE is_repeat_contact)::int AS repeat_contacts,
       (SELECT sum(refund_amount) FROM lab WHERE cat = 'refund' AND refund_amount IS NOT NULL AND refund_amount_source IS NOT NULL) AS refund_value,
       (SELECT count(*) FROM lab WHERE cat = 'refund' AND refund_amount IS NOT NULL AND refund_amount_source IS NOT NULL)::int AS refund_value_n,
       (SELECT sum(refund_amount) FROM lab WHERE cat = 'replacement' AND refund_amount IS NOT NULL AND refund_amount_source IS NOT NULL) AS replacement_value,
       (SELECT count(*) FROM lab WHERE cat = 'replacement' AND refund_amount IS NOT NULL AND refund_amount_source IS NOT NULL)::int AS replacement_value_n,
       coalesce((SELECT bool_or(is_demo) FROM base), false) AS has_demo`,
    b.params)) as Record<string, any>;
}

/** Subcategory counts (distinct interactions), complaint categories only, sorted desc. Cumulative share computed in JS. */
export async function getPareto(db: Db, s: Session, f: AFilters) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const rows = await db.query<{ cat_code: string; cat_name: string; sub_code: string | null; sub_name: string | null; n: number }>(
    `SELECT c.code AS cat_code, c.name AS cat_name, sc.code AS sub_code, sc.name AS sub_name, count(DISTINCT l.interaction_id)::int AS n
       FROM interaction_issue_labels l
       JOIN interactions i ON i.id = l.interaction_id
       JOIN issue_categories c ON c.id = l.category_id
       LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
      ${whereOf([...conds, 'l.is_active', `c.code <> ALL(${b.p(NON_COMPLAINT)})`])}
      GROUP BY 1,2,3,4 ORDER BY n DESC, sub_name`, b.params);
  const total = rows.reduce((a, r) => a + r.n, 0);
  let run = 0;
  return {
    total,
    rows: rows.map((r) => { run += r.n; return { ...r, share: total ? r.n / total : 0, cumulative: total ? run / total : 0 }; }),
  };
}

/** Distinct interactions per bucket for the top-N categories (by volume in range). */
export async function getCategoryTrend(db: Db, s: Session, f: AFilters, bucket: 'day' | 'week' | 'month', topN = 5) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const bk = b.p(bucket);
  const rows = await db.query<{ bucket: string; code: string; name: string; n: number }>(
    `SELECT to_char(date_trunc(${bk}, i.occurred_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket,
            c.code, c.name, count(DISTINCT i.id)::int AS n
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id JOIN issue_categories c ON c.id = l.category_id
      ${whereOf([...conds, 'l.is_active'])}
      GROUP BY 1,2,3 ORDER BY 1`, b.params);
  const totals = new Map<string, { name: string; n: number }>();
  for (const r of rows) { const t = totals.get(r.code) ?? { name: r.name, n: 0 }; t.n += r.n; totals.set(r.code, t); }
  const top = Array.from(totals.entries()).sort((a, z) => z[1].n - a[1].n).slice(0, topN).map(([code, v]) => ({ code, name: v.name, n: v.n }));
  const buckets = Array.from(new Set(rows.map((r) => r.bucket))).sort();
  const series = buckets.map((bk2) => {
    const o: Record<string, any> = { bucket: bk2 };
    for (const t of top) o[t.code] = rows.find((r) => r.bucket === bk2 && r.code === t.code)?.n ?? 0;
    return o;
  });
  return { top, series };
}

/** Generic "issue frequency by <dimension>" — distinct complaint interactions grouped by an expression. */
async function issueBy(db: Db, s: Session, f: AFilters, keyExpr: string, opts: { join?: string; label?: string; limit?: number } = {}) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const label = opts.label ?? keyExpr;
  return db.query(
    `SELECT ${keyExpr} AS key, ${label} AS label, count(DISTINCT i.id)::int AS n,
            count(DISTINCT i.id) FILTER (WHERE c.code = 'quality')::int AS quality_n,
            count(DISTINCT i.id) FILTER (WHERE c.code IN ('refund','replacement'))::int AS refund_repl_n
       FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id
       JOIN issue_categories c ON c.id = l.category_id ${opts.join ?? ''}
      ${whereOf([...conds, 'l.is_active', `c.code <> ALL(${b.p(NON_COMPLAINT)})`])}
      GROUP BY 1, 2 ORDER BY n DESC LIMIT ${opts.limit ?? 12}`, b.params);
}

export const getIssuesByProduct = (db: Db, s: Session, f: AFilters) => issueBy(db, s, f, `coalesce(l.product, i.product, 'Unknown')`);
export const getIssuesByVariant = (db: Db, s: Session, f: AFilters) =>
  issueBy(db, s, f, `l.variant`, { label: `coalesce(l.product, i.product, 'Unknown') || ' · ' || l.variant` }).then((r) => r.filter((x: any) => x.key));
export const getIssuesByChannel = (db: Db, s: Session, f: AFilters) => issueBy(db, s, f, `i.channel`);
export const getIssuesBySource = (db: Db, s: Session, f: AFilters) => issueBy(db, s, f, `i.source_platform`);
export const getIssuesByAgent = (db: Db, s: Session, f: AFilters) =>
  issueBy(db, s, f, `i.agent_id`, { join: 'LEFT JOIN agents ag ON ag.id = i.agent_id', label: `coalesce(ag.name, 'Unassigned')` });

/** Customer-stated reasons, normalised (lower/trim), with the most common subcategory for drill-down. */
export async function getTopReasons(db: Db, s: Session, f: AFilters, limit = 10) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  return db.query(
    `WITH r AS (
       SELECT lower(btrim(l.customer_reason)) AS reason_key, l.customer_reason, i.id AS interaction_id, c.code AS cat_code, sc.code AS sub_code, sc.name AS sub_name
         FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id
         JOIN issue_categories c ON c.id = l.category_id LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
        ${whereOf([...conds, 'l.is_active', "coalesce(btrim(l.customer_reason), '') <> ''"])})
     SELECT reason_key, min(customer_reason) AS reason, count(DISTINCT interaction_id)::int AS n,
            mode() WITHIN GROUP (ORDER BY cat_code) AS cat_code,
            mode() WITHIN GROUP (ORDER BY sub_code) AS sub_code,
            mode() WITHIN GROUP (ORDER BY sub_name) AS sub_name
       FROM r GROUP BY reason_key ORDER BY n DESC LIMIT ${limit}`, b.params);
}

/** Root causes linked to labels on in-range interactions. Suspected causes are AI inferences until confirmed by a person. */
export async function getRootCauses(db: Db, s: Session, f: AFilters) {
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b);
  const where = whereOf([...conds, 'l.is_active']);
  const params = b.params;
  const counts = await db.query<{ status: string; n: number; interactions: number }>(
    `SELECT rc.status, count(*)::int AS n, count(DISTINCT rc.interaction_id)::int AS interactions
       FROM issue_root_causes rc JOIN interaction_issue_labels l ON l.id = rc.label_id JOIN interactions i ON i.id = rc.interaction_id
      ${where} GROUP BY 1`, params);
  const list = await db.query(
    `SELECT rc.cause, rc.status, bool_or(rc.is_ai_inference) AS ai, count(DISTINCT rc.interaction_id)::int AS n,
            max(i.occurred_at) AS last_at, (array_agg(rc.interaction_id ORDER BY i.occurred_at DESC))[1] AS example_id,
            mode() WITHIN GROUP (ORDER BY c.code) AS cat_code, mode() WITHIN GROUP (ORDER BY sc.code) AS sub_code,
            mode() WITHIN GROUP (ORDER BY sc.name) AS sub_name, max(rc.confirmed_at) AS confirmed_at
       FROM issue_root_causes rc JOIN interaction_issue_labels l ON l.id = rc.label_id JOIN interactions i ON i.id = rc.interaction_id
       JOIN issue_categories c ON c.id = l.category_id LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
      ${where} GROUP BY rc.cause, rc.status
      ORDER BY CASE rc.status WHEN 'confirmed' THEN 0 WHEN 'suspected' THEN 1 ELSE 2 END, n DESC LIMIT 25`, params);
  return { counts, list };
}

// ───────────────────────── Period-over-period statements ─────────────────────────
export const COMPARE_MIN_CURRENT = 10;
export const COMPARE_MIN_PREVIOUS = 5;

export interface Comparison {
  kind: 'category' | 'subcategory'; code: string; name: string; cat_code: string;
  current: number; previous: number; change: number | null; sufficient: boolean;
}

/**
 * Compare label counts in [end − days, end] vs [end − 2·days, end − days] using all non-date filters.
 * Only labels where current ≥ 10 AND previous ≥ 5 produce a statement; the rest are reported as insufficient.
 */
export async function getPeriodComparisons(db: Db, s: Session, f: AFilters, days: number, end: Date) {
  const curFrom = new Date(end.getTime() - days * 86400_000);
  const prevFrom = new Date(end.getTime() - 2 * days * 86400_000);
  const b = new SqlBuilder();
  const conds = interactionConds(s, f, b, 'i', { skipDates: true });
  const pPrev = b.p(prevFrom), pCur = b.p(curFrom), pEnd = b.p(end);
  const rows = await db.query<{ kind: 'category' | 'subcategory'; code: string; name: string; cat_code: string; current: number; previous: number }>(
    `WITH x AS (
       SELECT i.id, i.occurred_at >= ${pCur} AS is_cur, c.code AS cat_code, c.name AS cat_name, sc.code AS sub_code, sc.name AS sub_name
         FROM interaction_issue_labels l JOIN interactions i ON i.id = l.interaction_id
         JOIN issue_categories c ON c.id = l.category_id LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
        ${whereOf([...conds, 'l.is_active', `i.occurred_at >= ${pPrev}`, `i.occurred_at <= ${pEnd}`])})
     SELECT 'category' AS kind, cat_code AS code, cat_name AS name, cat_code,
            count(DISTINCT id) FILTER (WHERE is_cur)::int AS current, count(DISTINCT id) FILTER (WHERE NOT is_cur)::int AS previous
       FROM x GROUP BY cat_code, cat_name
     UNION ALL
     SELECT 'subcategory', sub_code, sub_name, cat_code,
            count(DISTINCT id) FILTER (WHERE is_cur)::int, count(DISTINCT id) FILTER (WHERE NOT is_cur)::int
       FROM x WHERE sub_code IS NOT NULL GROUP BY sub_code, sub_name, cat_code`, b.params);
  const items: Comparison[] = rows.map((r) => {
    const sufficient = r.current >= COMPARE_MIN_CURRENT && r.previous >= COMPARE_MIN_PREVIOUS;
    return { ...r, sufficient, change: r.previous > 0 ? (r.current - r.previous) / r.previous : null };
  }).sort((a, z) => Number(z.sufficient) - Number(a.sufficient) || z.current - a.current);
  return { items, current: { from: curFrom, to: end }, previous: { from: prevFrom, to: curFrom } };
}
