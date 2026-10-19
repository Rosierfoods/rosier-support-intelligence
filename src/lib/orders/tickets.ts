/**
 * Auto-created support tickets: one per analysed call / chat / email, describing the problem and what the agent did
 * (refund, replacement, information …). Updated on re-analysis; never overwrites a ticket a human has edited (auto_created=false).
 */
import { withOrg, withSystem, type Db } from '@/lib/db';

export const RESOLUTION_TYPES = ['refund', 'replacement', 'return', 'redelivery', 'information', 'escalated', 'other', 'none'] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

export const RESOLUTION_TYPE_LABELS: Record<ResolutionType, string> = {
  refund: 'Refund', replacement: 'Replacement', return: 'Return / pickup', redelivery: 'Re-delivery / reship',
  information: 'Information given', escalated: 'Escalated', other: 'Other action', none: 'No action yet',
};

/** "None", "N/A", "-", "not provided" … → null. */
export function meaningfulText(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t || /^(none|nil|null|n\/?a|na|-+|no action|not (yet )?(provided|applicable|given|resolved)|nothing|unknown|pending)\.?$/i.test(t)) return null;
  return t;
}

/** Classify free text such as "Agent initiated a refund of ₹499" into a resolution type. Pure; unit-tested. */
export function classifyResolution(provided: string | null | undefined, status?: string | null): ResolutionType {
  const t = (meaningfulText(provided) ?? '').toLowerCase();
  if (/refund|money back|paisa wapas|reimburs|cashback/.test(t)) return 'refund';
  if (/replac|exchange|new (jar|pack|bottle|product)|badal/.test(t)) return 'replacement';
  if (/return|pick ?up|reverse/.test(t)) return 'return';
  if (/re-?deliver|reship|re-?dispatch|resend|send again|courier again/.test(t)) return 'redelivery';
  if (status === 'escalated' || /escalat|supervisor|manager|senior|team will call/.test(t)) return 'escalated';
  if (/inform|explain|shared|told|guided|tracking|status|details|clarif|bataya/.test(t)) return 'information';
  if (t.trim()) return 'other';
  return 'none';
}

export interface TicketInput {
  orgId: string; interactionId: string; ref: string; channel: string; agentId: string | null; customerId: string | null;
  occurredAt: Date | string; summary: string | null; intent: string | null;
  primaryCategory: string | null; primarySub: string | null; customerReason: string | null;
  resolutionProvided: string | null; resolutionRequested: string | null; resolutionStatus: string;
  maxSeverity: string | null; sentiment: string | null; orderRef: string | null;
}

export function ticketPriority(maxSeverity: string | null, sentiment: string | null): string {
  if (maxSeverity === 'critical') return 'urgent';
  if (maxSeverity === 'high') return 'high';
  if (maxSeverity === 'medium' || sentiment === 'negative') return 'medium';
  return 'low';
}

function ticketStatus(resolution: string): string {
  if (resolution === 'resolved') return 'resolved';
  if (resolution === 'escalated') return 'escalated';
  if (resolution === 'pending') return 'pending';
  return 'open';
}

export async function upsertAutoTicket(db: Db, t: TicketInput): Promise<string | null> {
  const category = [t.primaryCategory, t.primarySub].filter(Boolean).join(' › ') || null;
  const problem = (meaningfulText(t.customerReason) || meaningfulText(t.intent) || meaningfulText(t.summary) || '').slice(0, 1000) || null;
  const action = (meaningfulText(t.resolutionProvided) || '').slice(0, 1000) || null;
  const rtype = classifyResolution(t.resolutionProvided, t.resolutionStatus);
  const subject = (category ? `${category}${t.orderRef ? ` — ${t.orderRef}` : ''}` : (t.intent || 'Customer contact')).slice(0, 300);
  const r = await db.one<{ id: string }>(
    `INSERT INTO support_tickets (org_id, external_id, source, customer_id, subject, status, order_ref, opened_at, closed_at,
        interaction_id, agent_id, channel, category, problem, action_taken, resolution_type, priority, auto_created)
     VALUES ($1, $2, 'auto', $3, $4, $5, $6, $7, CASE WHEN $5 = 'resolved' THEN now() END, $8, $9, $10, $11, $12, $13, $14, $15, true)
     ON CONFLICT (interaction_id) WHERE interaction_id IS NOT NULL DO UPDATE SET
       subject = CASE WHEN support_tickets.auto_created THEN EXCLUDED.subject ELSE support_tickets.subject END,
       status = CASE WHEN support_tickets.auto_created THEN EXCLUDED.status ELSE support_tickets.status END,
       closed_at = CASE WHEN support_tickets.auto_created THEN EXCLUDED.closed_at ELSE support_tickets.closed_at END,
       category = CASE WHEN support_tickets.auto_created THEN EXCLUDED.category ELSE support_tickets.category END,
       problem = CASE WHEN support_tickets.auto_created THEN EXCLUDED.problem ELSE support_tickets.problem END,
       action_taken = CASE WHEN support_tickets.auto_created THEN EXCLUDED.action_taken ELSE support_tickets.action_taken END,
       resolution_type = CASE WHEN support_tickets.auto_created THEN EXCLUDED.resolution_type ELSE support_tickets.resolution_type END,
       priority = CASE WHEN support_tickets.auto_created THEN EXCLUDED.priority ELSE support_tickets.priority END,
       order_ref = coalesce(EXCLUDED.order_ref, support_tickets.order_ref),
       agent_id = coalesce(EXCLUDED.agent_id, support_tickets.agent_id),
       customer_id = coalesce(support_tickets.customer_id, EXCLUDED.customer_id)
     RETURNING id`,
    [t.orgId, `T-${t.ref}`, t.customerId, subject, ticketStatus(t.resolutionStatus), t.orderRef, t.occurredAt,
      t.interactionId, t.agentId, t.channel, category, problem, action, rtype, ticketPriority(t.maxSeverity, t.sentiment)]);
  if (r) await db.exec(`UPDATE interactions SET ticket_id = coalesce(ticket_id, $2) WHERE id = $1`, [t.interactionId, r.id]);
  return r?.id ?? null;
}

/**
 * Back-fill: conversations analysed before tickets existed (or whose ticket was never written) get one built from the
 * stored analysis (primary issue label, summary, intent, alerts). Runs in the worker maintenance step in small batches.
 */
export async function runTicketBackfillBatch(log: (m: string) => void = () => {}, batch = 100): Promise<number> {
  const orgs = await withSystem((db) => db.query<{ id: string }>(`SELECT id FROM organizations LIMIT 50`));
  let done = 0;
  for (const { id: orgId } of orgs) {
    try {
      done += await withOrg(orgId, async (db) => {
        const rows = await db.query<any>(
          `SELECT i.id, i.ref, i.channel, i.agent_id, i.customer_id, i.occurred_at, i.ai_summary, i.customer_intent, i.resolution_status,
                  i.sentiment, i.order_ref, pc.name AS cat, sc.name AS sub, l.customer_reason, l.resolution_provided, l.resolution_requested, l.order_ref AS label_order,
                  (SELECT q.severity FROM quality_flags q WHERE q.interaction_id = i.id AND q.status <> 'false_positive'
                    ORDER BY CASE q.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 1) AS max_sev
             FROM interactions i
             LEFT JOIN LATERAL (SELECT * FROM interaction_issue_labels x WHERE x.interaction_id = i.id AND x.is_active
                                ORDER BY x.is_primary DESC, x.created_at LIMIT 1) l ON true
             LEFT JOIN issue_categories pc ON pc.id = l.category_id
             LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
            WHERE i.processing_status IN ('completed','requires_review') AND (i.ai_summary IS NOT NULL OR l.id IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.interaction_id = i.id)
            ORDER BY i.occurred_at DESC LIMIT ${Math.max(1, Math.min(500, batch))}`);
        for (const r of rows) {
          await upsertAutoTicket(db, {
            orgId, interactionId: r.id, ref: r.ref, channel: r.channel, agentId: r.agent_id, customerId: r.customer_id, occurredAt: r.occurred_at,
            summary: r.ai_summary, intent: r.customer_intent, primaryCategory: r.cat, primarySub: r.sub, customerReason: r.customer_reason,
            resolutionProvided: r.resolution_provided, resolutionRequested: r.resolution_requested, resolutionStatus: r.resolution_status,
            maxSeverity: r.max_sev, sentiment: r.sentiment, orderRef: r.order_ref ?? r.label_order ?? null,
          });
        }
        return rows.length;
      });
    } catch (e) {
      log(`ticket backfill failed for org ${orgId}: ${(e as Error).message}`);
    }
  }
  return done;
}
