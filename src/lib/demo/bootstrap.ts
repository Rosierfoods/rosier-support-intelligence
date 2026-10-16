import type { Db } from '@/lib/db';
import { DEFAULT_ALERT_RULES, DEFAULT_CRITERIA, DEFAULT_ORG_SETTINGS, DEFAULT_TAXONOMY, KB_DEFAULT_ARTICLES } from '@/lib/constants';

const PLACEHOLDER_NOTE =
  '> ⚠️ TEMPLATE / DEMO POLICY — replace with Rosier Foods\' approved wording and publish a new version before relying on it for live data. ' +
  'While this version is marked as a placeholder, AI analysis of live (non-demo) interactions treats this policy as missing and flags uncertainty for human review.\n\n';

export const KB_TEMPLATE_BODIES: Record<string, string> = {
  'refund-policy': `## Refund policy (template)
- Refunds are issued only after the case is verified (photos / order check) and approved by an authorised team member.
- Approved refunds go to the original payment method within **5–7 working days** of approval.
- Agents must not promise a refund, an amount, cashback or compensation before approval.
- Compensation (beyond the order value) is decided only by the escalation team.
- If a refund has not arrived after 7 working days, check the refund status and escalate to finance.`,
  'replacement-policy': `## Replacement policy (template)
- Eligible: damaged, leaking, wrong, missing, expired or short-quantity items reported within 48 hours of delivery.
- Collect: order ID + photo(s) of the product and outer box (and invoice for wrong/missing items).
- After verification a replacement request is raised; customer gets confirmation within **24 hours** and dispatch in **3–5 days**.
- Items damaged by another leaking item in the same parcel are covered.`,
  'damaged-product-handling': `## Damaged-product handling (template)
1. Apologise and acknowledge — never blame the customer or courier without evidence.
2. Ask whether other items in the parcel were affected.
3. Collect photos of product, packaging and outer box; note order ID.
4. Raise replacement for every affected item; file a courier damage report if the outer box is damaged.
5. Give the customer the reference number and timeline.`,
  'ghee-jar-leakage': `## Ghee jar leakage procedure (template)
1. Apologise; confirm whether the jar is cracked or the lid/seal leaked.
2. Collect the order ID and photos of jar, lid and outer box.
3. Raise a replacement request (or refund if the customer prefers, subject to approval).
4. Record the batch number when visible — Quality uses it to look for patterns.
5. Do **not** state a cause (packaging, transport or manufacturing) — root cause is confirmed only by Quality/Ops.
6. Two or more leakage complaints from the same customer → escalate to Team Lead.`,
  'missing-incorrect-items': `## Missing or incorrect items (template)
- Collect photo of box contents + invoice; Ops verifies dispatch weight.
- Wrong item: replacement of the correct item + reverse pickup of the wrong item.
- Missing item: dispatch the missing item in 3–5 days after verification.
- Never suggest the customer or their household is responsible.`,
  'delivery-delays': `## Delivery delays (template)
- Check tracking before responding. If tracking has not moved for 48 hours, raise a courier escalation.
- Commit to a specific update time (typically within 24 hours).
- If there is no movement 48 hours after escalation, offer replacement dispatch (subject to approval).`,
  'storage-shelf-life': `## Storage and shelf life (template)
- Best-before is printed on every pack, counted from the manufacturing date. Quote the printed date — do not state a generic shelf life.
- Ghee & oils: cool, dry place; refrigeration not required; use a dry spoon.
- Honey: natural honey can crystallise, especially when cool; warm water bath re-liquefies it. Crystallisation is not adulteration.
- Atta: store in an airtight container once opened.`,
  'approved-claims': `## Product information and approved claims (template)
- Do not make medical or health-benefit claims (e.g. "reduces cholesterol", "doctor recommended", "cures").
- For health questions, suggest consulting a doctor.
- Only describe ingredients, sourcing and process as written on the pack / product page.`,
  'order-tracking': `## Order tracking (template)
- Share the tracking link from the order system; never guess a delivery date.
- If tracking is inconsistent, escalate to the courier and inform the customer of the next update time.`,
  'escalation-rules': `## Escalation rules (template)
- Food quality / safety complaints → Quality team, always.
- Refund past 7 working days or failed refund → Finance.
- Second repeat complaint on the same issue, or a legal/consumer-forum threat → Team Lead same day.
- Compensation requests → Escalation team (agents never promise compensation).
- Any suspected data exposure → Team Lead immediately.`,
  'communication-standards': `## Customer communication standards (template)
- Greet and introduce yourself and Rosier Foods.
- Acknowledge feelings and apologise for inconvenience.
- Answer the actual question; avoid copy-paste replies that don't address it.
- Always end with clear next steps, who acts, and when; then confirm if anything else is needed.`,
  'response-templates': `## Approved response templates (template)
**Leaking jar:** "I'm sorry your ghee jar arrived leaking. I understand how inconvenient that is. Could you please share your order ID and a photo of the package so we can check this under our replacement policy? I'll guide you through the next steps."
**Refund status:** "Your refund was approved on <date>. Refunds reach the original payment method within 5–7 working days. If it hasn't arrived by <date>, I'll follow up with our finance team."`,
  'privacy-data-handling': `## Privacy and customer-data handling (template)
- Never ask for card numbers, CVV, expiry, UPI PIN, passwords or OTPs.
- For payment issues use the UTR / transaction ID only.
- Verify identity with registered phone/email and order ID; never disclose another customer's details.
- Do not paste full phone numbers or addresses into internal notes unless required.`,
};

/** Creates an organisation with default settings. Returns its id. */
export async function createOrganization(db: Db, name: string, slug: string): Promise<string> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO organizations (name, slug, settings) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [name, slug, JSON.stringify(DEFAULT_ORG_SETTINGS)],
  );
  return row!.id;
}

/** Idempotently seeds taxonomy, rubric criteria, alert rules and KB templates for an org. */
export async function ensureOrgDefaults(db: Db, orgId: string) {
  let sort = 0;
  for (const cat of DEFAULT_TAXONOMY) {
    const parent = await db.one<{ id: string }>(
      `INSERT INTO issue_categories (org_id, code, name, sort) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, code) DO UPDATE SET name = issue_categories.name RETURNING id`,
      [orgId, cat.code, cat.name, sort++],
    );
    let s = 0;
    for (const [code, name] of cat.subs) {
      await db.exec(
        `INSERT INTO issue_categories (org_id, parent_id, code, name, sort) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, code) DO NOTHING`,
        [orgId, parent!.id, `${cat.code}.${code}`, name, s++],
      );
    }
  }
  let i = 0;
  for (const c of DEFAULT_CRITERIA) {
    await db.exec(
      `INSERT INTO quality_criteria (org_id, code, name, description, group_code, sort) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, c.code, c.name, c.description, c.group, i++],
    );
  }
  for (const r of DEFAULT_ALERT_RULES) {
    await db.exec(
      `INSERT INTO alert_rules (org_id, code, name, description, severity, min_confidence) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, code) DO NOTHING`,
      [orgId, r.code, r.name, r.description, r.severity, r.min_confidence ?? 0.6],
    );
  }
  for (const a of KB_DEFAULT_ARTICLES) {
    const existing = await db.one('SELECT id FROM knowledge_base_articles WHERE org_id = $1 AND slug = $2', [orgId, a.slug]);
    if (existing) continue;
    const art = await db.one<{ id: string }>(
      `INSERT INTO knowledge_base_articles (org_id, slug, title, category, status) VALUES ($1,$2,$3,$4,'published') RETURNING id`,
      [orgId, a.slug, a.title, a.category],
    );
    const v = await db.one<{ id: string }>(
      `INSERT INTO knowledge_base_versions (org_id, article_id, version, body, change_note, status, published_at, is_placeholder)
       VALUES ($1,$2,1,$3,'Initial template — replace with approved policy','published',now(),true) RETURNING id`,
      [orgId, art!.id, PLACEHOLDER_NOTE + (KB_TEMPLATE_BODIES[a.slug] ?? '')],
    );
    await db.exec('UPDATE knowledge_base_articles SET current_version_id = $1 WHERE id = $2', [v!.id, art!.id]);
  }
}
