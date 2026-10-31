/**
 * Founder listen list: which calls (and chats/emails) a founder should personally listen to / read, and why.
 * Every analysed conversation gets a priority score from its alerts, quality, wrong information, customer mood,
 * product-issue severity, money involved (refund/replacement), repeat contacts and call length.
 */
import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { isUuid } from '@/lib/db';
import { SqlBuilder } from '@/lib/sql';
import { scopeInteractions } from '@/lib/repos/scope';
import { parseRange, sp, type SP } from '@/lib/filters';
import { maskPhone } from '@/lib/crypto';

export interface ListenFeatures {
  critical: number; high: number; critical_titles: string[]; quality: number | null; wrong_info: number; policy_violations: number;
  frustration: number; sentiment: string | null; resolution_status: string; product_severity: string | null; issue: string | null;
  action: string | null; repeat_contacts: number; duration_seconds: number | null; channel: string;
}

export type ListenLevel = 'must' | 'should' | 'none';
export interface ListenScore { score: number; level: ListenLevel; reasons: string[] }

export const MUST_LISTEN = 60;
export const SHOULD_LISTEN = 35;

/** Pure scoring; unit-tested. Reasons are written for a founder skimming the list. */
export function scoreForFounder(f: ListenFeatures): ListenScore {
  let score = 0;
  const reasons: string[] = [];
  const add = (pts: number, why: string) => { score += pts; reasons.push(why); };
  if (f.critical > 0) add(Math.min(80, 60 + (f.critical - 1) * 10), `${f.critical} critical alert${f.critical > 1 ? 's' : ''}${f.critical_titles.length ? `: ${f.critical_titles.slice(0, 2).join(', ')}` : ''}`);
  if (f.high > 0) add(Math.min(30, f.high * 15), `${f.high} high-severity alert${f.high > 1 ? 's' : ''}`);
  if (f.product_severity === 'critical') add(30, `Serious product complaint${f.issue ? ` (${f.issue})` : ''}`);
  else if (f.product_severity === 'high') add(12, `Major product complaint${f.issue ? ` (${f.issue})` : ''}`);
  if (f.wrong_info > 0) add(25, `Agent gave wrong information (${f.wrong_info}×)`);
  if (f.policy_violations > 0) add(15, 'Policy not followed');
  if (f.quality !== null && f.quality < 50) add(25, `Very poor handling (quality ${Math.round(f.quality)}/100)`);
  else if (f.quality !== null && f.quality < 65) add(12, `Weak handling (quality ${Math.round(f.quality)}/100)`);
  if (f.sentiment === 'negative') add(f.frustration >= 2 ? 20 : 10, f.frustration >= 2 ? 'Customer very upset' : 'Unhappy customer');
  if (f.resolution_status === 'escalated') add(15, 'Escalated');
  else if (f.resolution_status === 'unresolved') add(10, 'Left unresolved');
  if (f.action === 'refund') add(10, 'Refund given / promised');
  else if (f.action === 'replacement') add(8, 'Replacement given / promised');
  if (f.repeat_contacts >= 2) add(15, `Customer contacted us ${f.repeat_contacts + 1} times in a week`);
  else if (f.repeat_contacts === 1) add(6, 'Customer contacted us again within a week');
  if (f.channel === 'call' && (f.duration_seconds ?? 0) >= 600) add(8, `Long call (${Math.round((f.duration_seconds ?? 0) / 60)} min)`);
  const level: ListenLevel = score >= MUST_LISTEN ? 'must' : score >= SHOULD_LISTEN ? 'should' : 'none';
  return { score, level, reasons };
}

export interface ListenFilters { from: Date; to: Date; rangeLabel: string; channel: 'call' | 'chat' | 'email' | null; agentId: string | null; show: 'todo' | 'done' | 'all' }

export function parseListenFilters(searchParams: SP): ListenFilters {
  const r = parseRange(searchParams, '7d');
  const ch = sp(searchParams, 'channel');
  const agent = sp(searchParams, 'agent');
  const show = sp(searchParams, 'show');
  return {
    from: r.from, to: r.to, rangeLabel: r.label,
    channel: ch === 'call' || ch === 'chat' || ch === 'email' ? ch : null,
    agentId: agent && isUuid(agent) ? agent : null,
    show: show === 'done' || show === 'all' ? show : 'todo',
  };
}

export interface ListenRow extends ListenScore {
  id: string; order_ref: string | null; order_verified: boolean; occurred_at: string; channel: string; direction: 'inbound' | 'outbound';
  agent_name: string | null; customer_name: string | null; customer_phone: string | null; call_status: string | null;
  duration_seconds: number | null; recording_available: boolean; summary: string | null; issue: string | null; quality: number | null;
  founder_reviewed_at: string | null; reviewed_by: string | null; founder_note: string | null; is_demo: boolean;
}

const FEATURES_SQL = (where: string) => `
  WITH base AS (SELECT i.* FROM interactions i WHERE ${where}),
  ev AS (
    SELECT DISTINCT ON (e.interaction_id) e.interaction_id,
           jsonb_array_length(coalesce(e.incorrect_statements, '[]'::jsonb)) AS wrong,
           jsonb_array_length(coalesce(e.policy_violations, '[]'::jsonb)) AS viol,
           jsonb_array_length(coalesce(e.frustration_indicators, '[]'::jsonb)) AS frus
      FROM quality_evaluations e JOIN base ON base.id = e.interaction_id
     WHERE e.is_current ORDER BY e.interaction_id, (e.evaluator_type = 'human') DESC, e.created_at DESC)
  SELECT base.id, base.order_ref, base.order_verified, base.occurred_at, base.channel, base.direction, base.quality_score AS quality,
         base.sentiment, base.resolution_status, base.ai_summary AS summary, base.founder_reviewed_at, base.founder_note, base.is_demo,
         ru.name AS reviewed_by, a.name AS agent_name, cu.name AS customer_name, cu.phone AS customer_phone,
         c.call_status, c.duration_seconds, coalesce(c.recording_available, false) AS recording_available,
         coalesce(ev.wrong, 0) AS wrong_info, coalesce(ev.viol, 0) AS policy_violations, coalesce(ev.frus, 0) AS frustration,
         (SELECT count(*)::int FROM quality_flags q WHERE q.interaction_id = base.id AND q.severity = 'critical' AND q.status <> 'false_positive') AS critical,
         (SELECT count(*)::int FROM quality_flags q WHERE q.interaction_id = base.id AND q.severity = 'high' AND q.status <> 'false_positive') AS high,
         (SELECT coalesce(array_agg(DISTINCT q.title), '{}') FROM quality_flags q WHERE q.interaction_id = base.id AND q.severity = 'critical' AND q.status <> 'false_positive') AS critical_titles,
         (SELECT l.severity FROM interaction_issue_labels l WHERE l.interaction_id = base.id AND l.is_active
           ORDER BY CASE l.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 1) AS product_severity,
         (SELECT coalesce(sc.name, pc.name) FROM interaction_issue_labels l JOIN issue_categories pc ON pc.id = l.category_id
            LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
           WHERE l.interaction_id = base.id AND l.is_active ORDER BY l.is_primary DESC LIMIT 1) AS issue,
         (SELECT t.resolution_type FROM support_tickets t WHERE t.interaction_id = base.id LIMIT 1) AS action,
         CASE WHEN base.customer_id IS NULL THEN 0 ELSE (SELECT count(*)::int FROM interactions o WHERE o.customer_id = base.customer_id AND o.id <> base.id
            AND o.occurred_at BETWEEN base.occurred_at - interval '7 days' AND base.occurred_at + interval '7 days') END AS repeat_contacts
    FROM base
    LEFT JOIN agents a ON a.id = base.agent_id
    LEFT JOIN customers cu ON cu.id = base.customer_id
    LEFT JOIN calls c ON c.interaction_id = base.id
    LEFT JOIN users ru ON ru.id = base.founder_reviewed_by
    LEFT JOIN ev ON ev.interaction_id = base.id`;

function toRow(r: any, canPii: boolean): ListenRow {
  const f: ListenFeatures = {
    critical: Number(r.critical), high: Number(r.high), critical_titles: r.critical_titles ?? [], quality: r.quality === null ? null : Number(r.quality),
    wrong_info: Number(r.wrong_info), policy_violations: Number(r.policy_violations), frustration: Number(r.frustration), sentiment: r.sentiment,
    resolution_status: r.resolution_status, product_severity: r.product_severity, issue: r.issue, action: r.action,
    repeat_contacts: Number(r.repeat_contacts), duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds), channel: r.channel,
  };
  return {
    ...scoreForFounder(f),
    id: r.id, order_ref: r.order_ref, order_verified: !!r.order_verified, occurred_at: r.occurred_at, channel: r.channel, direction: r.direction,
    agent_name: r.agent_name, customer_name: r.customer_name, customer_phone: canPii ? r.customer_phone : r.customer_phone ? maskPhone(r.customer_phone) : null,
    call_status: r.call_status, duration_seconds: f.duration_seconds, recording_available: !!r.recording_available, summary: r.summary, issue: r.issue,
    quality: f.quality, founder_reviewed_at: r.founder_reviewed_at, reviewed_by: r.reviewed_by, founder_note: r.founder_note, is_demo: !!r.is_demo,
  };
}

/** Flagged conversations in range, highest priority first (only "must" and "should" levels). */
export async function getListenList(db: Db, s: Session, f: ListenFilters, limit = 150): Promise<{ rows: ListenRow[]; counts: { must: number; should: number; done: number } }> {
  const b = new SqlBuilder();
  const c = [`i.occurred_at >= ${b.p(f.from)}`, `i.occurred_at <= ${b.p(f.to)}`, `i.processing_status IN ('completed','requires_review')`, scopeInteractions(s, b, 'i')];
  if (f.channel) c.push(f.channel === 'chat' ? `i.channel IN ('chat','whatsapp')` : `i.channel = ${b.p(f.channel)}`);
  if (f.agentId) c.push(`i.agent_id = ${b.p(f.agentId)}`);
  const raw = await db.query<any>(`${FEATURES_SQL(c.join(' AND '))} ORDER BY base.occurred_at DESC LIMIT 3000`, b.params);
  const canPii = s.permissions.has('customer_pii.view');
  const flagged = raw.map((r) => toRow(r, canPii)).filter((r) => r.level !== 'none');
  const counts = {
    must: flagged.filter((r) => r.level === 'must' && !r.founder_reviewed_at).length,
    should: flagged.filter((r) => r.level === 'should' && !r.founder_reviewed_at).length,
    done: flagged.filter((r) => r.founder_reviewed_at).length,
  };
  const shown = flagged.filter((r) => (f.show === 'todo' ? !r.founder_reviewed_at : f.show === 'done' ? !!r.founder_reviewed_at : true));
  shown.sort((a, b) => b.score - a.score || Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  return { rows: shown.slice(0, limit), counts };
}

/** Priority for one conversation (detail page banner). */
export async function getListenScore(db: Db, s: Session, interactionId: string): Promise<ListenRow | null> {
  const b = new SqlBuilder();
  const where = `i.id = ${b.p(interactionId)} AND ${scopeInteractions(s, b, 'i')}`;
  const r = await db.one<any>(FEATURES_SQL(where), b.params);
  return r ? toRow(r, s.permissions.has('customer_pii.view')) : null;
}

export async function markListened(db: Db, s: Session, interactionId: string, listened: boolean, note: string | null) {
  const b = new SqlBuilder();
  const idP = b.p(interactionId);
  const row = await db.one<{ id: string }>(`SELECT i.id FROM interactions i WHERE i.id = ${idP} AND ${scopeInteractions(s, b, 'i')}`, b.params);
  if (!row) return false;
  await db.exec(
    `UPDATE interactions SET founder_reviewed_at = CASE WHEN $2 THEN now() END, founder_reviewed_by = CASE WHEN $2 THEN $3::uuid END,
        founder_note = CASE WHEN $2 THEN coalesce($4, founder_note) ELSE founder_note END WHERE id = $1`,
    [interactionId, listened, s.user.id, note]);
  return true;
}
