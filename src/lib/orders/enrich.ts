/**
 * Order & customer matching (runs in the background worker every minute).
 *   1. Order ID mentioned in the conversation (found by the AI analysis) → verified in Shopify.
 *   2. Otherwise the customer's phone number → Shopify customer → their latest order placed on/before the contact.
 *   3. Customer name is filled from Shopify when we don't have one.
 * Without a Shopify connection the AI order ID is kept as "unverified".
 */
import { withOrg, withSystem, type Db } from '@/lib/db';
import { findProviderConnection } from '@/lib/ai/connections';
import { errorMessage } from '@/lib/ai/errors';
import { normalisePhone } from '@/lib/crypto';
import { extractOrderCandidates } from './extract';
import { findCustomerByPhone, findOrderByName, shopifyConfigFrom, type ShopifyConfig, type ShopifyOrder } from '@/lib/providers/shopify';

const BATCH = 15;

interface Pending {
  id: string; org_id: string; channel: string; occurred_at: Date; order_ref: string | null; order_source: string | null;
  customer_id: string | null; customer_phone: string | null; customer_name: string | null; ticket_id: string | null;
  order_candidates?: string[] | null;
}

function orderSnapshot(o: ShopifyOrder) {
  return {
    name: o.name, created_at: o.createdAt, financial_status: o.financialStatus, fulfillment_status: o.fulfillmentStatus,
    total: o.total, currency: o.currency, items: o.items.slice(0, 10), customer_name: o.customerName, admin_url: o.adminUrl,
  };
}

/** Pick the order the conversation is most likely about: latest order placed before (or within a day after) the contact. */
export function pickOrderForContact(orders: ShopifyOrder[], contactAt: Date): ShopifyOrder | null {
  const limit = contactAt.getTime() + 24 * 3600_000;
  const sorted = [...orders].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return sorted.find((o) => Date.parse(o.createdAt) <= limit) ?? null;
}

export async function enrichInteraction(db: Db, cfg: ShopifyConfig | null, p: Pending): Promise<void> {
  let orderRef = p.order_ref;
  let source = p.order_source;
  let verified = false;
  let details: Record<string, unknown> | null = null;
  let customerName: string | null = null;
  let shopifyCustomerId: string | null = null;

  if (cfg) {
    // 1) AI-found order id → verify
    if (orderRef && source !== 'manual') {
      const o = await findOrderByName(cfg, orderRef);
      if (o) { orderRef = o.name; verified = true; details = orderSnapshot(o); customerName = o.customerName; }
    }
    // 1b) Other order numbers heard / typed in the conversation (customer calling from an unregistered number).
    if (!verified && source !== 'manual') {
      for (const cand of (p.order_candidates ?? []).slice(0, 4)) {
        if (orderRef && cand.toLowerCase() === orderRef.toLowerCase()) continue;
        const o = await findOrderByName(cfg, cand);
        if (o) { orderRef = o.name; source = 'ai'; verified = true; details = { ...orderSnapshot(o), matched_by: 'conversation' }; customerName = o.customerName; break; }
      }
    }
    // 2) phone → customer → latest order (only when no verified order yet)
    const phone = normalisePhone(p.customer_phone);
    if (phone && (!verified || !p.customer_name)) {
      const c = await findCustomerByPhone(cfg, phone);
      if (c) {
        customerName = customerName ?? c.name;
        shopifyCustomerId = c.id || null;
        if (!verified && (!orderRef || source === 'shopify')) {
          const o = pickOrderForContact(c.orders, new Date(p.occurred_at));
          if (o) { orderRef = o.name; source = 'shopify'; verified = true; details = { ...orderSnapshot(o), matched_by: 'phone' }; }
        }
      }
    }
  }

  // Shopify couldn't confirm any of them, but the customer clearly said an order number → still show it (marked unverified).
  if (!orderRef && (p.order_candidates ?? []).length) { orderRef = p.order_candidates![0]; source = 'ai'; }

  await db.exec(
    `UPDATE interactions SET order_ref = $2, order_source = $3, order_verified = $4, order_details = coalesce($5::jsonb, order_details), order_checked_at = now()
      WHERE id = $1`,
    [p.id, orderRef, orderRef ? source ?? 'ai' : null, verified, details ? JSON.stringify(details) : null]);
  if (p.ticket_id && orderRef) await db.exec(`UPDATE support_tickets SET order_ref = $2 WHERE id = $1`, [p.ticket_id, orderRef]);
  if (p.customer_id && (customerName || shopifyCustomerId)) {
    await db.exec(
      `UPDATE customers SET name = coalesce(name, $2),
         external_ids = CASE WHEN $3::text IS NULL THEN external_ids ELSE external_ids || jsonb_build_object('shopify', $3::text) END
        WHERE id = $1`, [p.customer_id, customerName, shopifyCustomerId]);
  }
}

/** Process a batch of interactions that have not been order-checked yet. Called from the worker loop. */
export async function runOrderMatchingBatch(log: (m: string) => void = () => {}): Promise<number> {
  const orgs = await withSystem((db) => db.query<{ org_id: string }>(`SELECT id AS org_id FROM organizations LIMIT 50`));
  let done = 0;
  for (const { org_id } of orgs) {
    try {
      done += await withOrg(org_id, async (db) => {
        const conn = await findProviderConnection(db, 'shopify', org_id).catch(() => null);
        let cfg: ShopifyConfig | null = null;
        if (conn) { try { cfg = shopifyConfigFrom(conn.config, conn.secrets); } catch { cfg = null; } }
        if (cfg && conn) {
          // Shopify was connected / changed after these were checked → check them again.
          await db.exec(
            `UPDATE interactions i SET order_checked_at = NULL FROM integration_connections c
              WHERE c.id = $1 AND NOT i.order_verified AND i.order_checked_at < c.updated_at AND NOT i.is_demo
                AND i.occurred_at > now() - interval '120 days'`, [conn.id]);
        }
        // Wait for AI analysis to finish (so the conversation's own order id is used first), except where none will run.
        const rows = await db.query<Pending>(
          `SELECT i.id, i.org_id, i.channel, i.occurred_at, i.order_ref, i.order_source, i.customer_id, i.ticket_id, i.order_candidates,
                  cu.phone AS customer_phone, cu.name AS customer_name
             FROM interactions i
             LEFT JOIN customers cu ON cu.id = i.customer_id
             LEFT JOIN calls cl ON cl.interaction_id = i.id
            WHERE i.order_checked_at IS NULL AND NOT i.is_demo AND i.occurred_at > now() - interval '120 days'
              AND (i.processing_status IN ('completed','requires_review','failed')
                   OR (cl.call_status IS NOT NULL AND cl.call_status <> 'answered')
                   OR i.created_at < now() - interval '2 hours')
            ORDER BY i.occurred_at DESC LIMIT ${BATCH}`);
        let n = 0;
        for (const r of rows) {
          try { await enrichInteraction(db, cfg, r); n++; } catch (e) {
            const msg = errorMessage(e);
            log(`order match ${r.id.slice(0, 8)} failed: ${msg.slice(0, 160)}`);
            // Do not retry tight-loop on permanent errors; rate limits stop the batch and retry next minute.
            if (/rate limit|throttled/i.test(msg)) break;
            await db.exec(`UPDATE interactions SET order_checked_at = now() WHERE id = $1`, [r.id]);
          }
        }
        return n;
      });
    } catch (e) { log(`order matching error: ${errorMessage(e).slice(0, 160)}`); }
  }
  return done;
}

/**
 * Back-fill for conversations analysed before order-number detection existed: scan the transcript / messages for order
 * numbers and queue them for Shopify verification.
 */
export async function runOrderCandidateBackfill(log: (m: string) => void = () => {}, batch = 100): Promise<number> {
  const orgs = await withSystem((db) => db.query<{ id: string }>(`SELECT id FROM organizations LIMIT 50`));
  let done = 0;
  for (const { id: orgId } of orgs) {
    try {
      done += await withOrg(orgId, async (db) => {
        const rows = await db.query<{ id: string; order_verified: boolean; order_source: string | null; text: string | null }>(
          `SELECT i.id, i.order_verified, i.order_source,
                  coalesce(
                    (SELECT string_agg(s.text || coalesce(' ' || s.text_en, ''), ' ' ORDER BY s.seq) FROM transcript_segments s
                       JOIN call_transcripts t ON t.id = s.transcript_id AND t.is_current WHERE s.interaction_id = i.id),
                    (SELECT string_agg(m.body, ' ' ORDER BY m.seq) FROM conversation_messages m WHERE m.interaction_id = i.id),
                    (SELECT string_agg(coalesce(e.subject, '') || ' ' || e.body_text, ' ' ORDER BY e.seq) FROM email_messages e WHERE e.interaction_id = i.id)
                  ) AS text
             FROM interactions i
            WHERE i.order_candidates IS NULL AND i.processing_status IN ('completed','requires_review')
            ORDER BY i.occurred_at DESC LIMIT ${Math.max(1, Math.min(500, batch))}`);
        for (const r of rows) {
          const c = extractOrderCandidates(r.text ?? '');
          await db.exec(
            `UPDATE interactions SET order_candidates = $2,
               order_checked_at = CASE WHEN cardinality($2::text[]) > 0 AND NOT order_verified AND coalesce(order_source, '') <> 'manual' THEN NULL ELSE order_checked_at END
              WHERE id = $1`, [r.id, c]);
        }
        return rows.length;
      });
    } catch (e) { log(`order candidate backfill failed for org ${orgId}: ${errorMessage(e).slice(0, 160)}`); }
  }
  return done;
}
