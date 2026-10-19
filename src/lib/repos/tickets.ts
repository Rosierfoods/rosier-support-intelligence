import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { isUuid } from '@/lib/db';
import { SqlBuilder, escapeLike } from '@/lib/sql';
import { scopeAgents } from '@/lib/repos/scope';
import { parsePage, parseRange, sp, type SP } from '@/lib/filters';
import { maskEmail, maskPhone } from '@/lib/crypto';
import { RESOLUTION_TYPES } from '@/lib/orders/tickets';

export const TICKET_STATUSES = ['open', 'pending', 'escalated', 'resolved', 'closed'] as const;
export const TICKET_STATUS_LABELS: Record<string, string> = { open: 'Open', pending: 'Pending', escalated: 'Escalated', resolved: 'Resolved', closed: 'Closed' };
export const TICKET_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;

export interface TicketFilters {
  from: Date; to: Date; rangeLabel: string; status: string | null; resolutionType: string | null; priority: string | null;
  agentId: string | null; channel: string | null; q: string | null; page: number; pageSize: number; offset: number;
}

export function parseTicketFilters(searchParams: SP, pageSize = 50): TicketFilters {
  const range = parseRange(searchParams);
  const pick = <T extends readonly string[]>(k: string, allowed: T) => { const v = sp(searchParams, k); return v && (allowed as readonly string[]).includes(v) ? v : null; };
  const agent = sp(searchParams, 'agent');
  const { page, offset } = parsePage(searchParams, pageSize);
  return {
    from: range.from, to: range.to, rangeLabel: range.label,
    status: pick('status', TICKET_STATUSES), resolutionType: pick('action', RESOLUTION_TYPES), priority: pick('priority', TICKET_PRIORITIES),
    agentId: agent && isUuid(agent) ? agent : null,
    channel: pick('channel', ['call', 'chat', 'whatsapp', 'email'] as const),
    q: sp(searchParams, 'q')?.trim().slice(0, 100) || null,
    page, pageSize, offset,
  };
}

function conds(s: Session, f: TicketFilters, b: SqlBuilder): string {
  const c = [`t.opened_at >= ${b.p(f.from)}`, `t.opened_at <= ${b.p(f.to)}`];
  if (f.status) c.push(`t.status = ${b.p(f.status)}`);
  if (f.resolutionType) c.push(`coalesce(t.resolution_type, 'none') = ${b.p(f.resolutionType)}`);
  if (f.priority) c.push(`t.priority = ${b.p(f.priority)}`);
  if (f.agentId) c.push(`t.agent_id = ${b.p(f.agentId)}`);
  if (f.channel) c.push(f.channel === 'chat' ? `t.channel IN ('chat','whatsapp')` : `t.channel = ${b.p(f.channel)}`);
  if (f.q) {
    const like = b.p(`%${escapeLike(f.q)}%`);
    const ors = [`t.order_ref ILIKE ${like}`, `t.external_id ILIKE ${like}`, `t.problem ILIKE ${like}`, `t.action_taken ILIKE ${like}`, `t.category ILIKE ${like}`,
      `i.ref ILIKE ${like}`, `a.name ILIKE ${like}`];
    if (s.permissions.has('customer_pii.view')) {
      ors.push(`cu.name ILIKE ${like}`);
      const digits = f.q.replace(/\D/g, '');
      if (digits.length >= 4) ors.push(`regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g') LIKE ${b.p(`%${digits}%`)}`);
    }
    c.push(`(${ors.join(' OR ')})`);
  }
  c.push(scopeAgents(s, b, 't.agent_id'));
  return 'WHERE ' + c.join(' AND ');
}

const FROM = `FROM support_tickets t
  LEFT JOIN interactions i ON i.id = t.interaction_id
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN customers cu ON cu.id = t.customer_id
  LEFT JOIN calls c ON c.interaction_id = i.id`;

export interface TicketRow {
  id: string; external_id: string | null; status: string; priority: string; channel: string | null; category: string | null;
  problem: string | null; action_taken: string | null; resolution_type: string | null; order_ref: string | null; order_verified: boolean | null;
  opened_at: string; closed_at: string | null; auto_created: boolean; is_demo: boolean;
  interaction_id: string | null; interaction_ref: string | null; direction: string | null; call_status: string | null; duration_seconds: number | null;
  agent_id: string | null; agent_name: string | null; customer_name: string | null; customer_phone: string | null; customer_email: string | null;
  quality_score: number | null; sentiment: string | null; summary: string | null; critical_alerts: number;
}

const SELECT = `SELECT t.id, t.external_id, t.status, t.priority, coalesce(t.channel, i.channel) AS channel, t.category, t.problem, t.action_taken,
    t.resolution_type, coalesce(i.order_ref, t.order_ref) AS order_ref, i.order_verified, t.opened_at, t.closed_at, t.auto_created, t.is_demo,
    t.interaction_id, i.ref AS interaction_ref, i.direction, c.call_status, c.duration_seconds, t.agent_id, a.name AS agent_name,
    cu.name AS customer_name, cu.phone AS customer_phone, cu.email::text AS customer_email,
    i.quality_score, i.sentiment, i.ai_summary AS summary,
    (SELECT count(*)::int FROM quality_flags qf WHERE qf.interaction_id = i.id AND qf.severity = 'critical' AND qf.status <> 'false_positive') AS critical_alerts`;

function mask(r: TicketRow, canPii: boolean): TicketRow {
  if (canPii) return r;
  return { ...r, customer_phone: r.customer_phone ? maskPhone(r.customer_phone) : null, customer_email: r.customer_email ? maskEmail(r.customer_email) : null };
}

export async function listTickets(db: Db, s: Session, f: TicketFilters) {
  const b = new SqlBuilder();
  const where = conds(s, f, b);
  const canPii = s.permissions.has('customer_pii.view');
  const [rows, total, summary] = await Promise.all([
    db.query<TicketRow>(`${SELECT} ${FROM} ${where}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END, t.opened_at DESC
       LIMIT ${f.pageSize} OFFSET ${f.offset}`, b.params),
    db.one<{ n: number }>(`SELECT count(*)::int AS n ${FROM} ${where}`, b.params),
    db.query<{ key: string; kind: string; n: number }>(
      `SELECT coalesce(t.resolution_type, 'none') AS key, 'action' AS kind, count(*)::int AS n ${FROM} ${where} GROUP BY 1
       UNION ALL SELECT t.status, 'status', count(*)::int ${FROM} ${where} GROUP BY 1
       UNION ALL SELECT t.priority, 'priority', count(*)::int ${FROM} ${where} GROUP BY 1`, b.params),
  ]);
  const byKind = (k: string) => Object.fromEntries(summary.filter((x) => x.kind === k).map((x) => [x.key, x.n])) as Record<string, number>;
  return { rows: rows.map((r) => mask(r, canPii)), total: total?.n ?? 0, actions: byKind('action'), statuses: byKind('status'), priorities: byKind('priority') };
}

export const TICKET_EXPORT_MAX = 20000;

export async function exportTickets(db: Db, s: Session, f: TicketFilters) {
  const b = new SqlBuilder();
  const where = conds(s, f, b);
  const rows = await db.query<TicketRow>(`${SELECT} ${FROM} ${where} ORDER BY t.opened_at DESC LIMIT ${TICKET_EXPORT_MAX + 1}`, b.params);
  const canPii = s.permissions.has('customer_pii.view');
  return { rows: rows.slice(0, TICKET_EXPORT_MAX).map((r) => mask(r, canPii)), truncated: rows.length > TICKET_EXPORT_MAX };
}

/** Manual edit of a ticket. Once edited by a person, re-analysis no longer overwrites it (auto_created=false). */
export async function updateTicket(db: Db, s: Session, id: string, p: { status: string; resolutionType: string | null; actionTaken: string | null; problem: string | null }) {
  const b = new SqlBuilder();
  const idP = b.p(id);
  const scope = scopeAgents(s, b, 't.agent_id');
  const row = await db.one<{ id: string }>(`SELECT t.id FROM support_tickets t WHERE t.id = ${idP} AND ${scope}`, b.params);
  if (!row) return false;
  await db.exec(
    `UPDATE support_tickets SET status = $2, resolution_type = coalesce($3, resolution_type), action_taken = coalesce($4, action_taken),
        problem = coalesce($5, problem), auto_created = false, updated_at = now(),
        closed_at = CASE WHEN $2 IN ('resolved','closed') THEN coalesce(closed_at, now()) ELSE NULL END
      WHERE id = $1`, [id, p.status, p.resolutionType, p.actionTaken, p.problem]);
  return true;
}
