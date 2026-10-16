/**
 * DEMO DATA generator. Every row it creates is marked is_demo = true (or hangs off a demo interaction),
 * uses fictional people and example.com addresses, and is shown with a DEMO DATA label in the UI.
 */
import bcrypt from 'bcryptjs';
import type { Db } from '@/lib/db';
import { SCENARIOS, type Scenario, type Turn, type Variant } from './scenarios';
import { bandFor, computeScore, defaultCriteriaDefs, weightsFor } from '@/lib/ai/scoring';
import { DEFAULT_ORG_SETTINGS, type Channel } from '@/lib/constants';
import { sha256Hex } from '@/lib/crypto';

// ───────── deterministic PRNG ─────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEAMS = [
  { key: 'calls', name: 'Inbound Calls', description: 'MyOperator inbound voice support' },
  { key: 'chat', name: 'Chat & WhatsApp', description: 'LimeChat web chat and WhatsApp' },
  { key: 'email', name: 'Email & Escalations', description: 'Email support and escalated cases' },
];
const AGENTS = [
  { name: 'Priya Sharma', team: 'calls', poor: 0.08 },
  { name: 'Rahul Verma', team: 'calls', poor: 0.25 },
  { name: 'Imran Khan', team: 'calls', poor: 0.55 },
  { name: 'Neha Gupta', team: 'chat', poor: 0.12 },
  { name: 'Aman Singh', team: 'chat', poor: 0.38 },
  { name: 'Kavya Nair', team: 'chat', poor: 0.2 },
  { name: 'Rohit Yadav', team: 'email', poor: 0.3 },
  { name: 'Sneha Joshi', team: 'email', poor: 0.1 },
];
export const DEMO_USERS = [
  { email: 'admin@rosier.demo', name: 'Demo Admin', role: 'super_admin' },
  { email: 'crm@rosier.demo', name: 'Ritu Malhotra', role: 'crm_manager' },
  { email: 'lead.calls@rosier.demo', name: 'Vikram Rao', role: 'team_leader', team: 'calls' },
  { email: 'qa@rosier.demo', name: 'Anjali Desai', role: 'quality_analyst' },
  { email: 'priya@rosier.demo', name: 'Priya Sharma', role: 'support_agent', team: 'calls', agent: 'Priya Sharma' },
] as const;

const FIRST = ['Aarav', 'Ishita', 'Rohan', 'Meera', 'Kabir', 'Ananya', 'Arjun', 'Diya', 'Vivaan', 'Saanvi', 'Aditya', 'Pooja', 'Karan', 'Nisha', 'Manish', 'Swati', 'Deepak', 'Radhika', 'Siddharth', 'Tanvi', 'Gaurav', 'Shreya', 'Nikhil', 'Bhavna', 'Harsh', 'Lata', 'Mohit', 'Rekha', 'Vikas', 'Sunita'];
const LAST = ['Mehta', 'Kapoor', 'Iyer', 'Reddy', 'Bansal', 'Chopra', 'Pillai', 'Agarwal', 'Saxena', 'Kulkarni', 'Bhatt', 'Mishra', 'Sethi', 'Menon', 'Tiwari'];

const SCENARIO_KB: Record<string, string[]> = {
  ghee_leak: ['ghee-jar-leakage', 'replacement-policy', 'damaged-product-handling'],
  ghee_leak_overpromise: ['refund-policy', 'ghee-jar-leakage', 'escalation-rules'],
  refund_status: ['refund-policy'],
  delivery_delay: ['delivery-delays', 'order-tracking'],
  payment_failed: ['privacy-data-handling', 'refund-policy'],
  shelf_life_claims: ['approved-claims', 'storage-shelf-life'],
  wrong_product: ['missing-incorrect-items', 'replacement-policy'],
  oil_leak: ['damaged-product-handling', 'replacement-policy'],
  honey_crystal: ['storage-shelf-life', 'approved-claims'],
  cancellation: ['refund-policy'],
  coupon: ['communication-standards'],
  missing_item: ['missing-incorrect-items'],
  atta_quality: ['escalation-rules', 'storage-shelf-life', 'replacement-policy'],
  refund_not_received_repeat: ['refund-policy', 'escalation-rules'],
  appreciation: ['communication-standards'],
};

const CONFIRMED_CAUSE: Record<string, string> = {
  ghee_leak: 'Lid seal failure in one batch (confirmed by Quality)',
  delivery_delay: 'Courier hub backlog (confirmed by courier)',
  wrong_product: 'Warehouse picking error (confirmed by Ops)',
  oil_leak: 'Transit damage — crushed carton (confirmed by courier report)',
  missing_item: 'Packing miss at warehouse (confirmed by weight check)',
  atta_quality: 'Storage humidity at a warehouse node (confirmed by Quality)',
};

export interface DemoSummary { interactions: number; calls: number; chats: number; emails: number; flags: number; coaching: number }

export async function clearDemoData(db: Db, orgId: string) {
  await db.exec('DELETE FROM processing_jobs WHERE org_id = $1 AND payload->>\'demo\' = \'true\'', [orgId]);
  await db.exec('DELETE FROM coaching_actions WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM interactions WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM customer_feedback WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM support_tickets WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM customers WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('UPDATE teams SET lead_user_id = NULL WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM users WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM agents WHERE org_id = $1 AND is_demo', [orgId]);
  await db.exec('DELETE FROM teams WHERE org_id = $1 AND is_demo', [orgId]);
}

export async function generateDemoData(db: Db, orgId: string, opts: { password: string; seed?: number; now?: Date }): Promise<DemoSummary> {
  const rnd = mulberry32(opts.seed ?? 20261012);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)];
  const between = (a: number, b: number) => a + rnd() * (b - a);
  const int = (a: number, b: number) => Math.floor(between(a, b + 1));
  const now = opts.now ?? new Date();

  await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
  await clearDemoData(db, orgId);

  // ───────── reference data ─────────
  const cats = await db.query<{ id: string; code: string }>('SELECT id, code FROM issue_categories WHERE org_id = $1', [orgId]);
  const catId = new Map(cats.map((c) => [c.code, c.id]));
  const kb = await db.query<{ slug: string; article_id: string; version_id: string }>(
    `SELECT a.slug, a.id AS article_id, a.current_version_id AS version_id FROM knowledge_base_articles a WHERE a.org_id = $1`, [orgId]);
  const kbBySlug = new Map(kb.map((k) => [k.slug, k]));
  const criteria = defaultCriteriaDefs();
  const settings = DEFAULT_ORG_SETTINGS;

  // ───────── teams, agents, users ─────────
  const teamIds: Record<string, string> = {};
  for (const t of TEAMS) {
    const r = await db.one<{ id: string }>(
      `INSERT INTO teams (org_id, name, description, is_demo) VALUES ($1,$2,$3,true)
       ON CONFLICT (org_id, name) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
      [orgId, t.name, t.description]);
    teamIds[t.key] = r!.id;
  }
  const agents: { id: string; name: string; team: string; poor: number }[] = [];
  for (const a of AGENTS) {
    const email = a.name.toLowerCase().replace(' ', '.') + '@rosier.demo';
    const r = await db.one<{ id: string }>(
      `INSERT INTO agents (org_id, name, email, team_id, external_ids, is_demo) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [orgId, a.name, email, teamIds[a.team], JSON.stringify({ demo: a.name })]);
    agents.push({ id: r!.id, name: a.name, team: a.team, poor: a.poor });
  }
  const pwHash = await bcrypt.hash(opts.password, 10);
  const users: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const agentId = 'agent' in u ? agents.find((a) => a.name === u.agent)?.id ?? null : null;
    const teamId = 'team' in u ? teamIds[u.team] : null;
    const r = await db.one<{ id: string }>(
      `INSERT INTO users (org_id, email, name, password_hash, role, team_id, agent_id, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [orgId, u.email, u.name, pwHash, u.role, teamId, agentId]);
    if (r) users[u.role] = r.id;
    if (r && agentId) await db.exec('UPDATE agents SET user_id = $1 WHERE id = $2', [r.id, agentId]);
  }
  if (users.team_leader) await db.exec('UPDATE teams SET lead_user_id = $1 WHERE id = $2', [users.team_leader, teamIds.calls]);
  const reviewers = [users.quality_analyst, users.team_leader, users.crm_manager].filter(Boolean);

  // ───────── customers ─────────
  const customers: { id: string; first: string; name: string }[] = [];
  for (let i = 0; i < 90; i++) {
    const first = pick(FIRST); const last = pick(LAST);
    const phone = `+91 90000 ${String(10000 + i * 97).slice(-5)}`;
    const email = `${first}.${last}${i}@example.com`.toLowerCase();
    const r = await db.one<{ id: string }>(
      `INSERT INTO customers (org_id, name, phone, email, phone_hash, email_hash, is_demo) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [orgId, `${first} ${last}`, phone, email, sha256Hex('demo:' + phone), sha256Hex('demo:' + email)]);
    customers.push({ id: r!.id, first, name: `${first} ${last}` });
  }

  // ───────── interactions ─────────
  const plan: Channel[] = [
    ...Array(62).fill('call'), ...Array(36).fill('whatsapp'), ...Array(26).fill('chat'), ...Array(40).fill('email'),
  ];
  const summary: DemoSummary = { interactions: 0, calls: 0, chats: 0, emails: 0, flags: 0, coaching: 0 };
  const recentRefundCustomers: { id: string; at: number }[] = [];
  let missedCalls = 0;
  const specialStatuses = ['failed', 'failed', 'requires_review', 'requires_review', 'requires_review', 'analysis_pending', 'transcription_pending'];

  for (let idx = 0; idx < plan.length; idx++) {
    const channel = plan[idx];
    // date: last 60 days, slightly more volume recently
    const daysAgo = Math.floor(Math.pow(rnd(), 1.25) * 60);
    const hourWeights = channel === 'call' ? [9, 10, 11, 11, 12, 12, 13, 15, 16, 16, 17, 18] : [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    const start = new Date(now.getTime() - daysAgo * 86400_000);
    start.setHours(pick(hourWeights), int(0, 59), int(0, 59), 0);
    if (start > now) start.setTime(now.getTime() - int(30, 600) * 60_000);

    const teamKey = channel === 'call' ? 'calls' : channel === 'email' ? 'email' : 'chat';
    const pool = agents.filter((a) => a.team === teamKey || (teamKey === 'email' && rnd() < 0.05));
    const agent = pick(pool);
    const customer = pick(customers);
    const ref = 'RSI-' + Math.floor(rnd() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
    const sourceId = `demo-${channel}-${idx}-${ref}`;

    // Missed calls (no conversation content)
    if (channel === 'call' && missedCalls < 12 && rnd() < 0.2) {
      missedCalls++;
      const ix = await db.one<{ id: string }>(
        `INSERT INTO interactions (org_id, ref, source_platform, source_record_id, channel, direction, customer_id, agent_id, team_id,
           occurred_at, subject, preview, processing_status, resolution_status, is_demo)
         VALUES ($1,$2,'demo',$3,'call','inbound',$4,$5,$6,$7,'Missed call','Missed inbound call — no recording','completed','open',true) RETURNING id`,
        [orgId, ref, sourceId, customer.id, null, teamIds.calls, start]);
      await db.exec(
        `INSERT INTO calls (org_id, interaction_id, call_status, duration_seconds, ring_seconds, from_number_masked, recording_available)
         VALUES ($1,$2,'missed',0,$3,'••••••' || $4,false)`,
        [orgId, ix!.id, int(20, 45), String(1000 + idx).slice(-4)]);
      summary.interactions++; summary.calls++;
      continue;
    }

    // Scenario choice (ghee leakage trends up over the last 14 days)
    const eligible = SCENARIOS.filter((s) => s.channels.includes(channel));
    const weighted = eligible.map((s) => ({ s, w: s.weight * (s.key.startsWith('ghee_leak') && daysAgo < 14 ? 1.7 : 1) }));
    const total = weighted.reduce((a, b) => a + b.w, 0);
    let roll = rnd() * total; let sc: Scenario = eligible[0];
    for (const w of weighted) { roll -= w.w; if (roll <= 0) { sc = w.s; break; } }
    const isPoor = rnd() < agent.poor;
    const variant: Variant = isPoor ? sc.poor : sc.good;
    const product = pick(sc.products);
    const order = '#RF' + int(40000, 69999);

    let cust = customer;
    if (sc.key === 'refund_not_received_repeat') {
      const prior = recentRefundCustomers.find((r) => Math.abs(r.at - start.getTime()) < 7 * 86400_000);
      if (prior) cust = customers.find((c) => c.id === prior.id) ?? customer;
    }
    if (sc.key === 'refund_status') recentRefundCustomers.push({ id: cust.id, at: start.getTime() });

    const fill = (t: string) => t.replaceAll('{cust}', cust.first).replaceAll('{agent}', agent.name.split(' ')[0])
      .replaceAll('{order}', order).replaceAll('{product}', product);
    const turns: Turn[] = (channel === 'call' ? variant.call : variant.text).map(([sp, t]) => [sp, fill(t)]);
    const subject = fill(sc.subject);
    const special = idx % 23 === 7 && specialStatuses.length ? specialStatuses.shift()! : null;

    // build message timeline
    type Msg = { seq: number; speaker: 'A' | 'C'; text: string; at: Date; startMs: number; endMs: number };
    const msgs: Msg[] = [];
    let cursor = start.getTime();
    let ms = 0;
    for (let i = 0; i < turns.length; i++) {
      const [sp, text] = turns[i];
      if (channel === 'call') {
        const dur = Math.max(2200, text.length * 65) + int(0, 900);
        msgs.push({ seq: i, speaker: sp, text, at: new Date(cursor + ms), startMs: ms, endMs: ms + dur });
        ms += dur + int(300, 1400);
      } else {
        if (i > 0) {
          const prevSp = turns[i - 1][0];
          let gapMin: number;
          if (channel === 'email') gapMin = sp === 'A' ? (isPoor ? between(300, 1500) : between(40, 240)) : between(30, 600);
          else gapMin = sp === 'A' && prevSp === 'C' ? (isPoor ? (rnd() < 0.5 ? between(25, 140) : between(3, 12)) : between(0.5, 6)) : between(0.3, 4);
          cursor += gapMin * 60_000;
        }
        msgs.push({ seq: i, speaker: sp, text, at: new Date(cursor), startMs: 0, endMs: 0 });
      }
    }
    const endAt = channel === 'call' ? new Date(start.getTime() + ms) : msgs[msgs.length - 1].at;
    const firstCust = msgs.find((m) => m.speaker === 'C');
    const firstAgentAfter = firstCust ? msgs.find((m) => m.speaker === 'A' && m.seq > firstCust.seq) : undefined;
    const ringSeconds = int(4, 35);
    const firstResponse = channel === 'call' ? ringSeconds
      : firstCust && firstAgentAfter ? Math.round((firstAgentAfter.at.getTime() - firstCust.at.getTime()) / 1000) : null;
    const resolved = variant.resolution === 'resolved';
    const resolutionSeconds = resolved ? (channel === 'call' ? Math.round(ms / 1000) : Math.round((endAt.getTime() - start.getTime()) / 1000)) : null;
    const lastIsCustomer = msgs[msgs.length - 1]?.speaker === 'C';

    const analysed = !special;
    const ix = await db.one<{ id: string }>(
      `INSERT INTO interactions (org_id, ref, source_platform, source_record_id, channel, direction, customer_id, agent_id, team_id,
         occurred_at, ended_at, subject, preview, processing_status, processing_error, resolution_status, review_status,
         first_response_seconds, resolution_seconds, awaiting_agent_since, product, is_demo, reopened)
       VALUES ($1,$2,'demo',$3,$4,'inbound',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'not_reviewed',$15,$16,$17,$18,true,$19) RETURNING id`,
      [orgId, ref, sourceId, channel, cust.id, agent.id, teamIds[agent.team], start, endAt, subject,
        (firstCust?.text ?? turns[0][1]).slice(0, 220),
        special ?? 'completed',
        special === 'failed' ? 'Recording could not be retrieved from the provider (HTTP 404: recording expired). Retry once the provider confirms availability.' : null,
        variant.resolution, firstResponse, resolutionSeconds,
        lastIsCustomer && channel !== 'call' ? msgs[msgs.length - 1].at : null,
        product, sc.key === 'refund_not_received_repeat']);
    const interactionId = ix!.id;
    summary.interactions++;

    // channel-specific content
    if (channel === 'call') {
      summary.calls++;
      const call = await db.one<{ id: string }>(
        `INSERT INTO calls (org_id, interaction_id, call_status, duration_seconds, ring_seconds, from_number_masked, to_number_masked,
           recording_available, recording_source_ref, language_hint)
         VALUES ($1,$2,'answered',$3,$4,$5,'••••••0100',$6,$7,'hi-IN') RETURNING id`,
        [orgId, interactionId, Math.round(ms / 1000), ringSeconds, '••••••' + String(2000 + idx).slice(-4),
          special !== 'failed', special === 'failed' ? null : `demo://recordings/${ref}.mp3`]);
      if (special !== 'failed' && special !== 'transcription_pending') {
        const tr = await db.one<{ id: string }>(
          `INSERT INTO call_transcripts (org_id, call_id, interaction_id, provider, model, language, status, diarized, full_text)
           VALUES ($1,$2,$3,'demo','synthetic-transcript','hi-IN','completed',true,$4) RETURNING id`,
          [orgId, call!.id, interactionId, msgs.map((m) => `${m.speaker === 'A' ? 'Agent' : 'Customer'}: ${m.text}`).join('\n')]);
        for (const m of msgs) {
          await db.exec(
            `INSERT INTO transcript_segments (org_id, transcript_id, interaction_id, seq, speaker, start_ms, end_ms, text)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [orgId, tr!.id, interactionId, m.seq, m.speaker === 'A' ? 'agent' : 'customer', m.startMs, m.endMs, m.text]);
        }
      } else if (special === 'failed') {
        await db.exec(
          `INSERT INTO call_transcripts (org_id, call_id, interaction_id, provider, model, status, error, attempt)
           VALUES ($1,$2,$3,'sarvam','saarika','failed','Recording unavailable (HTTP 404 from provider)',3)`,
          [orgId, call!.id, interactionId]);
        await db.exec(
          `INSERT INTO processing_jobs (org_id, type, interaction_id, status, attempts, max_attempts, last_error, payload, finished_at)
           VALUES ($1,'transcribe',$2,'dead',5,5,'Recording unavailable (HTTP 404 from provider)','{"demo":true}',now())`,
          [orgId, interactionId]);
      }
    } else if (channel === 'email') {
      summary.emails++;
      for (const m of msgs) {
        await db.exec(
          `INSERT INTO email_messages (org_id, interaction_id, seq, external_message_id, sender_type, subject, from_address, to_addresses, sent_at, body_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [orgId, interactionId, m.seq, `${sourceId}-m${m.seq}`, m.speaker === 'A' ? 'agent' : 'customer',
            (m.seq === 0 ? '' : 'Re: ') + subject,
            m.speaker === 'A' ? 'care@rosier.demo' : `${cust.first.toLowerCase()}@example.com`,
            [m.speaker === 'A' ? `${cust.first.toLowerCase()}@example.com` : 'care@rosier.demo'], m.at,
            m.speaker === 'A' ? `Hi ${cust.first},\n\n${m.text}\n\nWarm regards,\n${agent.name.split(' ')[0]}\nRosier Foods Customer Care` : `${m.text}\n\n${cust.name}`]);
      }
    } else {
      summary.chats++;
      const th = await db.one<{ id: string }>(
        `INSERT INTO conversation_threads (org_id, interaction_id, external_thread_id, status, assigned_queue, opened_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, interactionId, sourceId, resolved ? 'closed' : 'open', channel === 'whatsapp' ? 'WhatsApp Support' : 'Web Chat', start, resolved ? endAt : null]);
      for (const m of msgs) {
        await db.exec(
          `INSERT INTO conversation_messages (org_id, thread_id, interaction_id, seq, external_message_id, sender_type, sender_name, body, sent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [orgId, th!.id, interactionId, m.seq, `${sourceId}-m${m.seq}`, m.speaker === 'A' ? 'agent' : 'customer',
            m.speaker === 'A' ? agent.name : cust.name, m.text, m.at]);
      }
    }

    if (!analysed) continue;

    // ───────── AI analysis (synthetic) ─────────
    const kbIds = (SCENARIO_KB[sc.key] ?? []).map((s) => kbBySlug.get(s)?.version_id).filter(Boolean) as string[];
    const criterionScores = criteria.map((c) => {
      const base = variant.scores[c.code];
      if (base === null) return { code: c.code, score: null, na: true, rationale: 'Not applicable to this conversation.' };
      let s = typeof base === 'number' ? base : (isPoor ? 2 : 4);
      if (!isPoor && rnd() < 0.3) s = Math.max(3, s - 1);
      if (isPoor && rnd() < 0.2) s = Math.min(5, s + 1);
      const ev = s <= 2 ? (variant.flags?.find((f) => f.criterion === c.code) ? 'See flagged excerpt.' : 'Behaviour not observed.') : 'Observed in conversation.';
      return { code: c.code, score: s, na: false, evidence: ev, rationale: s >= 4 ? 'Meets the standard.' : s >= 3 ? 'Partially meets the standard.' : 'Below the standard.' };
    });
    const weights = weightsFor(settings, channel);
    const { overall, groups } = computeScore(criterionScores, criteria, weights);
    const band = bandFor(overall, settings.scoreBands);
    const confidence = Math.round(between(isPoor ? 0.72 : 0.78, 0.96) * 1000) / 1000;
    const lowConf = special === 'requires_review';

    const output = {
      summary: variant.summary, customer_intent: sc.intent, sentiment: variant.sentiment, product, language: channel === 'call' ? 'hi-en' : 'en',
      customer_questions: turns.filter((t) => t[0] === 'C' && t[1].includes('?')).map((t) => t[1]).slice(0, 4),
      requested_actions: [sc.resolutionRequested], resolution_status: variant.resolution,
    };
    const analysis = await db.one<{ id: string }>(
      `INSERT INTO ai_analyses (org_id, interaction_id, kind, provider, model, prompt_version, kb_version_ids, status, output, created_at)
       VALUES ($1,$2,'full','demo','demo-synthetic','demo-1',$3,'completed',$4,$5) RETURNING id`,
      [orgId, interactionId, kbIds, JSON.stringify(output), new Date(endAt.getTime() + 5 * 60_000)]);

    const evalRow = await db.one<{ id: string }>(
      `INSERT INTO quality_evaluations (org_id, interaction_id, analysis_id, evaluator_type, overall_score, band, criterion_scores, group_scores,
         positives, missed_opportunities, incorrect_statements, policy_violations, frustration_indicators, improved_response, confidence,
         rubric_snapshot, kb_version_ids, policy_uncertain, policy_uncertainty_note, created_at)
       VALUES ($1,$2,$3,'ai',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [orgId, interactionId, analysis!.id, overall, band?.label ?? null, JSON.stringify(criterionScores), JSON.stringify(groups),
        JSON.stringify(variant.positives), JSON.stringify(variant.missed), JSON.stringify(variant.incorrect ?? []),
        JSON.stringify(variant.violations ?? []), JSON.stringify(variant.frustration ?? []), variant.improved ?? null,
        lowConf ? 0.48 : confidence, JSON.stringify({ weights }), kbIds, lowConf,
        lowConf ? 'Low confidence: mixed-language audio with overlapping speech; human review requested.' : null,
        new Date(endAt.getTime() + 5 * 60_000)]);

    await db.exec(
      `UPDATE interactions SET quality_score = $2, quality_band = $3, sentiment = $4, ai_summary = $5, customer_intent = $6 WHERE id = $1`,
      [interactionId, overall, band?.label ?? null, variant.sentiment, variant.summary, sc.intent]);

    // ───────── issue labels (multi-label) ─────────
    const labelsToUse = sc.labels.filter((l, i) => i === 0 || rnd() < 0.7);
    let primaryLabelId: string | null = null;
    for (const l of labelsToUse) {
      const lab = await db.one<{ id: string }>(
        `INSERT INTO interaction_issue_labels (org_id, interaction_id, category_id, subcategory_id, is_primary, product, customer_reason,
           severity, resolution_requested, resolution_provided, order_ref, replacement_status, escalated, confidence, evidence, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ai') RETURNING id`,
        [orgId, interactionId, catId.get(l.cat), catId.get(`${l.cat}.${l.sub}`), !!l.primary, product, sc.customerReason, l.severity,
          sc.resolutionRequested, variant.resolutionProvided, order, l.cat === 'replacement' ? variant.replacementStatus ?? null : null,
          variant.resolution === 'escalated', Math.round(between(0.74, 0.97) * 1000) / 1000, firstCust?.text ?? null]);
      if (l.primary) primaryLabelId = lab!.id;
    }
    if (sc.rootCause && primaryLabelId) {
      const confirmed = daysAgo > 20 && rnd() < 0.3;
      await db.exec(
        `INSERT INTO issue_root_causes (org_id, label_id, interaction_id, cause, status, is_ai_inference, evidence, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orgId, primaryLabelId, interactionId,
          confirmed ? CONFIRMED_CAUSE[sc.key] ?? sc.rootCause : sc.rootCause,
          confirmed ? 'confirmed' : 'suspected', !confirmed, firstCust?.text ?? null,
          confirmed ? users.quality_analyst ?? null : null, confirmed ? new Date(start.getTime() + 3 * 86400_000) : null]);
    }

    // ───────── flags ─────────
    for (const f of variant.flags ?? []) {
      let tIdx = f.turn;
      if (channel !== 'call') {
        const callTurns = variant.call;
        const wantSp = callTurns[Math.min(f.turn, callTurns.length - 1)][0];
        const rel = f.turn / Math.max(1, callTurns.length - 1);
        const candidates = msgs.filter((m) => m.speaker === wantSp);
        tIdx = candidates.length ? candidates.reduce((best, m) =>
          Math.abs(m.seq / Math.max(1, msgs.length - 1) - rel) < Math.abs(best.seq / Math.max(1, msgs.length - 1) - rel) ? m : best).seq : 0;
      }
      const m = msgs[Math.min(tIdx, msgs.length - 1)];
      const evidenceRef = channel === 'call' ? { segment_seq: m.seq, start_ms: m.startMs }
        : channel === 'email' ? { email_seq: m.seq, sent_at: m.at.toISOString() } : { message_seq: m.seq, sent_at: m.at.toISOString() };
      const ageDays = (now.getTime() - start.getTime()) / 86400_000;
      const r = rnd();
      const status = ageDays > 21 ? (r < 0.35 ? 'confirmed' : r < 0.6 ? 'coaching_assigned' : r < 0.85 ? 'resolved' : 'false_positive')
        : ageDays > 7 ? (r < 0.4 ? 'under_review' : r < 0.7 ? 'confirmed' : r < 0.9 ? 'new' : 'false_positive')
          : (r < 0.75 ? 'new' : 'under_review');
      const rule = await db.one<{ severity: string; name: string }>('SELECT severity, name FROM alert_rules WHERE org_id = $1 AND code = $2', [orgId, f.rule]);
      const kbArticle = kbBySlug.get((SCENARIO_KB[sc.key] ?? [])[0] ?? '');
      const reviewer = status === 'new' ? null : pick(reviewers);
      const flag = await db.one<{ id: string }>(
        `INSERT INTO quality_flags (org_id, interaction_id, evaluation_id, agent_id, severity, rule_code, title, reason, excerpt, evidence_ref,
           criterion_code, policy_article_id, policy_version_id, confidence, recommended_correction, status, assigned_to,
           acknowledged_at, resolved_at, is_demo, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true,$20) RETURNING id`,
        [orgId, interactionId, evalRow!.id, agent.id, rule?.severity ?? 'medium', f.rule, rule?.name ?? f.rule, f.reason, m.text,
          JSON.stringify(evidenceRef), f.criterion, kbArticle?.article_id ?? null, kbArticle?.version_id ?? null, f.confidence,
          f.correction, status, reviewer, status === 'new' ? null : new Date(start.getTime() + 86400_000),
          status === 'resolved' || status === 'false_positive' ? new Date(start.getTime() + 4 * 86400_000) : null,
          new Date(endAt.getTime() + 6 * 60_000)]);
      summary.flags++;
      if (status !== 'new' && reviewer) {
        await db.exec(
          `INSERT INTO reviewer_decisions (org_id, target_type, target_id, interaction_id, reviewer_id, decision, before_state, after_state, notes, created_at)
           VALUES ($1,'flag',$2,$3,$4,$5,'{"status":"new"}',$6,$7,$8)`,
          [orgId, flag!.id, interactionId, reviewer,
            status === 'false_positive' ? 'false_positive' : status === 'under_review' ? 'start_review' : 'confirm',
            JSON.stringify({ status }), status === 'false_positive' ? 'Context shows the agent followed up correctly on the next contact.' : 'Evidence matches the excerpt.',
            new Date(start.getTime() + 86400_000)]);
        await db.exec(`UPDATE interactions SET review_status = 'reviewed' WHERE id = $1`, [interactionId]);
      }
      // coaching for confirmed issues
      if ((status === 'coaching_assigned' || (status === 'resolved' && rnd() < 0.7)) && users.crm_manager) {
        const coachStatus = status === 'resolved' ? (rnd() < 0.6 ? 'reviewed' : 'completed') : pick(['assigned', 'acknowledged', 'in_progress']);
        const baseline = overall ?? 60;
        const ca = await db.one<{ id: string }>(
          `INSERT INTO coaching_actions (org_id, agent_id, flag_id, interaction_id, title, what_went_wrong, why_it_matters, evidence, sop_reference,
             policy_version_id, better_response, recommended_action, exercise, review_date, target_metric, target_value, baseline_value,
             source, status, created_by, is_demo, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'ai',$18,$19,true,$20) RETURNING id`,
          [orgId, agent.id, flag!.id, interactionId, rule?.name ?? f.rule, f.reason,
            whyItMatters(f.rule), m.text, kbArticle ? `${kbArticle.slug} (v1)` : null, kbArticle?.version_id ?? null,
            variant.improved ?? f.correction, f.correction, exerciseFor(f.criterion),
            new Date(start.getTime() + 14 * 86400_000), f.criterion, Math.min(100, Math.round(baseline + 20)), baseline,
            coachStatus, users.crm_manager, new Date(start.getTime() + 2 * 86400_000)]);
        const reviewed = coachStatus === 'reviewed';
        await db.exec(
          `INSERT INTO coaching_assignments (org_id, coaching_action_id, agent_id, assigned_by, goal, assigned_at, acknowledged_at, completed_at,
             reviewed_at, reviewed_by, outcome, outcome_value, outcome_notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [orgId, ca!.id, agent.id, users.crm_manager, `Raise ${f.criterion.replace(/_/g, ' ')} score to 4/5 or above on the next 10 reviewed interactions`,
            new Date(start.getTime() + 2 * 86400_000),
            coachStatus !== 'assigned' ? new Date(start.getTime() + 3 * 86400_000) : null,
            ['completed', 'reviewed'].includes(coachStatus) ? new Date(start.getTime() + 9 * 86400_000) : null,
            reviewed ? new Date(start.getTime() + 15 * 86400_000) : null, reviewed ? users.crm_manager : null,
            reviewed ? (rnd() < 0.7 ? 'improved' : 'no_change') : null,
            reviewed ? Math.round(baseline + between(5, 25)) : null,
            reviewed ? 'Re-check of subsequent interactions shows the behaviour is less frequent.' : null]);
        summary.coaching++;
        if (status === 'coaching_assigned') await db.exec(`UPDATE quality_flags SET status = 'coaching_assigned' WHERE id = $1`, [flag!.id]);
      }
    }

    // ───────── CSAT feedback (only some interactions) ─────────
    if ((resolved || variant.resolution === 'escalated') && rnd() < 0.45) {
      const csat = isPoor ? int(1, 3) : int(4, 5);
      await db.exec(
        `INSERT INTO customer_feedback (org_id, interaction_id, customer_id, csat, comment, source, received_at, is_demo)
         VALUES ($1,$2,$3,$4,$5,'post_interaction_survey',$6,true)`,
        [orgId, interactionId, cust.id, csat, csat >= 4 ? 'Helpful and quick.' : 'Not satisfied with the response.', new Date(endAt.getTime() + 3600_000)]);
      await db.exec('UPDATE interactions SET csat = $2 WHERE id = $1', [interactionId, csat]);
    }
  }

  // ───────── post-processing ─────────
  await db.exec(`SELECT rsi_refresh_search_text(id) FROM interactions WHERE org_id = $1 AND is_demo`, [orgId]);
  await db.exec('SELECT rsi_recompute_repeat_contacts($1)', [settings.repeatContactWindowDays]);

  // notifications for open critical flags
  const crit = await db.query<{ id: string; interaction_id: string; title: string; ref: string }>(
    `SELECT f.id, f.interaction_id, f.title, i.ref FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id
      WHERE f.org_id = $1 AND f.is_demo AND f.severity = 'critical' AND f.status IN ('new','under_review') ORDER BY f.created_at DESC LIMIT 10`, [orgId]);
  for (const u of [users.super_admin, users.crm_manager].filter(Boolean)) {
    for (const c of crit) {
      await db.exec(
        `INSERT INTO notification_events (org_id, user_id, type, severity, title, body, link) VALUES ($1,$2,'quality_flag','critical',$3,$4,$5)`,
        [orgId, u, `Critical alert: ${c.title}`, `Interaction ${c.ref} (DEMO DATA)`, `/inbox/${c.interaction_id}?flag=${c.id}`]);
    }
  }
  return summary;
}

function whyItMatters(rule: string): string {
  const m: Record<string, string> = {
    unauthorized_refund_promise: 'Unapproved promises create financial exposure and customer disappointment when they cannot be honoured.',
    sensitive_data_exposure: 'Requesting OTPs or card details puts customers at risk of fraud and breaches data-protection obligations.',
    unprofessional_behavior: 'Blaming or dismissing customers damages trust and increases repeat contacts and escalations.',
    incorrect_refund_replacement_info: 'Wrong timelines or eligibility create repeat contacts and complaints when expectations are missed.',
    false_product_info: 'Unapproved product or health claims are a regulatory and reputational risk.',
    missing_follow_up: 'Without an owner and a time, customers chase us again — raising volume and frustration.',
    scripted_non_answer: 'Copy-paste replies that miss the question make customers feel unheard.',
    issue_not_acknowledged: 'Customers who must repeat themselves are far more likely to escalate.',
    incomplete_resolution: 'Conversations without a clear outcome become repeat contacts.',
    major_policy_violation: 'Major SOP breaches carry customer-safety, legal or financial risk.',
    sla_unresolved: 'Complaints past SLA are the strongest driver of escalations and negative reviews.',
    clarity_empathy: 'Small improvements in warmth and clarity lift CSAT and loyalty.',
  };
  return m[rule] ?? 'Affects customer experience and policy compliance.';
}
function exerciseFor(criterion: string): string {
  const m: Record<string, string> = {
    empathy: 'Rewrite three recent replies to open with acknowledgment + apology before any process step; review with your team lead.',
    next_steps: 'For the next 10 conversations, end every reply with: what happens next, who does it, and by when.',
    accuracy: 'Re-read the refund & replacement SOPs and complete the 10-question timeline quiz with your team lead.',
    refund_replacement: 'Role-play three refund requests where the customer pushes for an immediate refund; practise escalating instead of promising.',
    privacy: 'Complete the payment-data handling refresher; practise collecting a UTR instead of card details.',
    product_policy_info: 'Review the approved-claims article and list five claims you must never make.',
    understanding: 'Practise paraphrasing the customer’s issue back to them before answering, in five recorded calls.',
    troubleshooting: 'Shadow a senior agent on five similar cases and note their diagnostic questions.',
    resolution: 'For each open case this week, confirm an outcome or an owner before closing.',
    escalation: 'Review the escalation rules and map five recent cases to the correct escalation path.',
    sop_compliance: 'Walk through the relevant SOP with your team lead and complete a checklist on the next five cases.',
  };
  return m[criterion] ?? 'Review the relevant SOP with your team lead and apply it on the next five cases.';
}
