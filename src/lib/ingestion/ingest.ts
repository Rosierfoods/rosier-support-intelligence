/**
 * Normalised provider record → database. Idempotent:
 *  - interactions are unique on (org_id, source_platform, source_record_id); a re-delivered record updates in place;
 *  - chat messages are unique on (thread_id, external_message_id), emails on (interaction_id, external_message_id),
 *    so new messages are appended to an existing thread and repeats are ignored.
 * Raw provider payloads are never stored on interactions (only in webhook_events).
 *
 * Must run inside an org-scoped transaction (withOrg) or a system transaction; every insert carries org_id.
 */
import type { Db } from '@/lib/db';
import type { NormalizedInteraction, NormalizedMessage } from '@/lib/providers/types';
import { maskPhone, normalisePhone, sha256Hex } from '@/lib/crypto';
import { enqueueProcessing } from '@/lib/pipeline/jobs';
import { generateRef } from './ref';

export interface IngestSettings { autoAnalyze: boolean; storeContact: boolean; repeatWindowDays: number }
export interface IngestResult { status: 'created' | 'updated' | 'duplicate'; interactionId: string; newContent: boolean }

export async function loadIngestSettings(db: Db, orgId: string): Promise<IngestSettings> {
  const row = await db.one<{ settings: any }>('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  const s = row?.settings ?? {};
  return {
    autoAnalyze: s.ai?.autoAnalyze !== false,
    // Raw phone/email are stored unless the organisation opts out (privacy.storeCustomerContact = false);
    // hashes are always stored for matching.
    storeContact: s.privacy?.storeCustomerContact !== false,
    repeatWindowDays: Number(s.repeatContactWindowDays ?? 7) || 7,
  };
}

export function phoneHash(phone: string | null | undefined): string | null {
  const n = normalisePhone(phone);
  return n ? sha256Hex(n) : null;
}
export function emailHash(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e && e.includes('@') ? sha256Hex(e) : null;
}

/** Response metrics from an ordered message list. Pure (unit-tested). */
export function conversationMetrics(msgs: { senderType: string; sentAt: Date; body?: string | null }[]): {
  firstResponseSeconds: number | null; awaitingSince: Date | null; preview: string | null; firstAt: Date | null; lastAt: Date | null;
} {
  const sorted = [...msgs].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const firstCustomer = sorted.find((m) => m.senderType === 'customer');
  let firstResponseSeconds: number | null = null;
  if (firstCustomer) {
    const reply = sorted.find((m) => m.senderType === 'agent' && m.sentAt.getTime() >= firstCustomer.sentAt.getTime());
    if (reply) firstResponseSeconds = Math.max(0, Math.round((reply.sentAt.getTime() - firstCustomer.sentAt.getTime()) / 1000));
  }
  // Awaiting agent: customer messages after the last agent reply (bot/system messages don't count as a reply).
  let lastAgentIdx = -1;
  sorted.forEach((m, i) => { if (m.senderType === 'agent') lastAgentIdx = i; });
  const pending = sorted.slice(lastAgentIdx + 1).filter((m) => m.senderType === 'customer');
  const awaitingSince = pending.length ? pending[0].sentAt : null;
  const previewSrc = (firstCustomer?.body && firstCustomer.body.trim()) ? firstCustomer : sorted.find((m) => (m.body ?? '').trim());
  const preview = previewSrc?.body ? previewSrc.body.replace(/\s+/g, ' ').trim().slice(0, 280) : null;
  return { firstResponseSeconds, awaitingSince, preview, firstAt: sorted[0]?.sentAt ?? null, lastAt: sorted[sorted.length - 1]?.sentAt ?? null };
}

/** Run fn inside a SAVEPOINT; on error roll back to it and return null instead of aborting the transaction. */
export async function withSavepoint<T>(db: Db, name: string, fn: () => Promise<T>): Promise<T | null> {
  await db.exec(`SAVEPOINT ${name}`);
  try {
    const r = await fn();
    await db.exec(`RELEASE SAVEPOINT ${name}`);
    return r;
  } catch {
    await db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    return null;
  }
}

function validDate(d: unknown): Date | null {
  const x = d instanceof Date ? d : d ? new Date(d as any) : null;
  return x && !Number.isNaN(x.getTime()) ? x : null;
}

async function resolveCustomer(db: Db, orgId: string, c: NormalizedInteraction['customer'], platform: string, settings: IngestSettings): Promise<string | null> {
  if (!c) return null;
  const ph = phoneHash(c.phone);
  const eh = emailHash(c.email);
  if (!ph && !eh) return null;
  const phone = settings.storeContact ? normalisePhone(c.phone) : null;
  const email = settings.storeContact && eh ? c.email!.trim().toLowerCase() : null;
  const name = c.name?.trim() ? c.name.trim().slice(0, 200) : null;
  const ext = c.externalId ? { [platform]: String(c.externalId) } : {};
  const find = async () => db.one<{ id: string }>(
    `SELECT id FROM customers WHERE org_id = $1 AND ((phone_hash IS NOT NULL AND phone_hash = $2) OR (email_hash IS NOT NULL AND email_hash = $3))
      ORDER BY (phone_hash = $2) DESC NULLS LAST LIMIT 1`, [orgId, ph, eh]);
  let row = await find();
  if (!row) {
    row = await db.one<{ id: string }>(
      `INSERT INTO customers (org_id, name, phone, email, phone_hash, email_hash, external_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [orgId, name, phone, email, ph, eh, JSON.stringify(ext)]);
    if (!row) row = await find();
    return row?.id ?? null;
  }
  const id = row.id;
  // Enrich missing fields; a phone_hash clash with another customer must not abort the surrounding transaction.
  await withSavepoint(db, 'rsi_customer_enrich', () => db.exec(
    `UPDATE customers SET name = coalesce(name, $2), phone = coalesce(phone, $3), email = coalesce(email, $4),
            phone_hash = coalesce(phone_hash, $5), external_ids = external_ids || $6::jsonb
      WHERE id = $1 AND (name IS NULL OR phone IS NULL OR email IS NULL OR phone_hash IS NULL OR NOT external_ids @> $6::jsonb)`,
    [id, name, phone, email, ph, JSON.stringify(ext)]));
  return id;
}

async function resolveAgent(db: Db, orgId: string, platform: string, a: NormalizedInteraction['agent']): Promise<{ id: string; teamId: string | null } | null> {
  if (!a) return null;
  const ext = a.externalId ? String(a.externalId) : null;
  const email = a.email?.trim().toLowerCase() || null;
  const phone = normalisePhone(a.phone ?? null);
  const name = a.name?.trim() || null;
  const found = (r: { id: string; team_id: string | null } | null) => (r ? { id: r.id, teamId: r.team_id } : null);
  // 1) Agent's own mobile number (set in Team → Agents) — the most reliable mapping for MyOperator.
  if (phone) {
    const r = await db.one<{ id: string; team_id: string | null }>(
      `SELECT id, team_id FROM agents WHERE org_id = $1 AND $2 = ANY(phone_numbers) ORDER BY is_active DESC LIMIT 1`, [orgId, phone]);
    if (r) {
      if (ext) await db.exec(`UPDATE agents SET external_ids = external_ids || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND NOT external_ids ? $2`, [r.id, platform, ext]);
      return found(r);
    }
  }
  const learnPhone = async (id: string) => {
    if (phone) await db.exec(`UPDATE agents SET phone_numbers = array_append(phone_numbers, $2) WHERE id = $1 AND NOT ($2 = ANY(phone_numbers))`, [id, phone]);
  };
  // 2) Provider user id
  if (ext) {
    const r = await db.one<{ id: string; team_id: string | null }>(
      `SELECT id, team_id FROM agents WHERE org_id = $1 AND external_ids ->> $2 = $3 ORDER BY is_active DESC LIMIT 1`, [orgId, platform, ext]);
    if (r) { await learnPhone(r.id); return found(r); }
  }
  // 3) Email
  if (email) {
    const r = await db.one<{ id: string; team_id: string | null }>(
      `SELECT id, team_id FROM agents WHERE org_id = $1 AND email = $2 ORDER BY is_active DESC LIMIT 1`, [orgId, email]);
    if (r) {
      if (ext) await db.exec(`UPDATE agents SET external_ids = external_ids || jsonb_build_object($2::text, $3::text) WHERE id = $1`, [r.id, platform, ext]);
      await learnPhone(r.id);
      return found(r);
    }
  }
  // 4) Same display name (avoid creating duplicates when the provider sends only a name + number)
  if (name) {
    const r = await db.one<{ id: string; team_id: string | null }>(
      `SELECT id, team_id FROM agents WHERE org_id = $1 AND lower(name) = lower($2) ORDER BY is_active DESC LIMIT 1`, [orgId, name]);
    if (r) {
      if (ext) await db.exec(`UPDATE agents SET external_ids = external_ids || jsonb_build_object($2::text, $3::text) WHERE id = $1 AND NOT external_ids ? $2`, [r.id, platform, ext]);
      await learnPhone(r.id);
      return found(r);
    }
  }
  // 5) Create — only when we know who it is (a phone number alone stays unassigned until it is added to an agent).
  if (!ext && !email && !name) return null;
  const display = (name || email || `${platform} agent ${ext}`).slice(0, 200);
  const r = await db.one<{ id: string }>(
    `INSERT INTO agents (org_id, name, email, external_ids, phone_numbers, is_active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
    [orgId, display, email, JSON.stringify(ext ? { [platform]: ext } : {}), phone ? [phone] : []]);
  return r ? { id: r.id, teamId: null } : null;
}

/** Assign agents to calls that have an agent-side number but no agent yet (run after numbers are added in Team → Agents). */
export async function rematchAgentsByPhone(db: Db): Promise<number> {
  return db.exec(
    `UPDATE interactions i SET agent_id = a.id, team_id = a.team_id
       FROM calls c, agents a
      WHERE c.interaction_id = i.id AND c.agent_phone IS NOT NULL AND a.org_id = i.org_id
        AND c.agent_phone = ANY(a.phone_numbers) AND (i.agent_id IS NULL OR i.agent_id <> a.id)`);
}

async function upsertTicket(db: Db, orgId: string, platform: string, t: NormalizedInteraction['ticket'], customerId: string | null, openedAt: Date): Promise<string | null> {
  if (!t?.externalId) return null;
  const r = await db.one<{ id: string }>(
    `INSERT INTO support_tickets (org_id, external_id, source, customer_id, subject, status, order_ref, opened_at)
     VALUES ($1,$2,$3,$4,$5,coalesce($6,'open'),$7,$8)
     ON CONFLICT (org_id, source, external_id) DO UPDATE SET
       status = coalesce(EXCLUDED.status, support_tickets.status),
       subject = coalesce(support_tickets.subject, EXCLUDED.subject),
       order_ref = coalesce(support_tickets.order_ref, EXCLUDED.order_ref),
       customer_id = coalesce(support_tickets.customer_id, EXCLUDED.customer_id)
     RETURNING id`,
    [orgId, String(t.externalId), platform, customerId, t.subject ?? null, t.status ?? null, t.orderRef ?? null, openedAt]);
  return r?.id ?? null;
}

async function insertInteraction(db: Db, orgId: string, connectionId: string | null, rec: NormalizedInteraction, occurredAt: Date,
  ids: { customerId: string | null; agentId: string | null; teamId: string | null; ticketId: string | null }): Promise<{ id: string; created: boolean }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO interactions (org_id, ref, source_platform, source_record_id, connection_id, channel, direction, customer_id, agent_id, team_id,
                                 ticket_id, occurred_at, ended_at, subject, resolution_status, processing_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15,'open'),'imported')
       ON CONFLICT DO NOTHING RETURNING id`,
      [orgId, generateRef(), rec.sourcePlatform, rec.sourceRecordId, connectionId, rec.channel, rec.direction ?? 'inbound',
        ids.customerId, ids.agentId, ids.teamId, ids.ticketId, occurredAt, validDate(rec.endedAt), rec.subject?.slice(0, 500) ?? null,
        rec.resolutionStatus ?? null]);
    if (row) return { id: row.id, created: true };
    // Conflict: either the record already exists (concurrent delivery) or the random ref collided → retry.
    const existing = await db.one<{ id: string }>(
      'SELECT id FROM interactions WHERE org_id = $1 AND source_platform = $2 AND source_record_id = $3', [orgId, rec.sourcePlatform, rec.sourceRecordId]);
    if (existing) return { id: existing.id, created: false };
  }
  throw new Error('Could not allocate a unique interaction reference');
}

async function ingestMessages(db: Db, orgId: string, interactionId: string, rec: NormalizedInteraction): Promise<number> {
  const thread = await db.one<{ id: string }>(
    `INSERT INTO conversation_threads (org_id, interaction_id, external_thread_id, status, opened_at, closed_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (interaction_id) DO UPDATE SET
       status = coalesce(EXCLUDED.status, conversation_threads.status),
       closed_at = CASE WHEN EXCLUDED.status IS NOT NULL THEN EXCLUDED.closed_at ELSE conversation_threads.closed_at END,
       opened_at = least(conversation_threads.opened_at, EXCLUDED.opened_at)
     RETURNING id`,
    [orgId, interactionId, rec.sourceRecordId, rec.status ?? null, validDate(rec.occurredAt), rec.resolutionStatus === 'resolved' ? validDate(rec.endedAt) ?? new Date() : null]);
  if (!thread) throw new Error('Could not create conversation thread');
  const msgs = (rec.messages ?? []).filter((m) => m?.externalId).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  let inserted = 0;
  const maxSeq = await db.one<{ s: number }>('SELECT coalesce(max(seq), 0)::int AS s FROM conversation_messages WHERE thread_id = $1', [thread.id]);
  let seq = maxSeq?.s ?? 0;
  for (const m of msgs) {
    const sentAt = validDate(m.sentAt) ?? new Date();
    const row = await db.one<{ id: string }>(
      `INSERT INTO conversation_messages (org_id, thread_id, interaction_id, seq, external_message_id, sender_type, sender_name, body, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (thread_id, external_message_id) DO NOTHING RETURNING id`,
      [orgId, thread.id, interactionId, ++seq, String(m.externalId).slice(0, 300), m.senderType, m.senderName?.slice(0, 200) ?? null,
        String(m.body ?? '').slice(0, 50_000), sentAt]);
    if (!row) { seq--; continue; }
    inserted++;
    for (const a of m.attachments ?? []) {
      await db.exec(
        `INSERT INTO attachments (org_id, interaction_id, conversation_message_id, file_name, mime_type, size_bytes, source_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, interactionId, row.id, a.fileName?.slice(0, 300) ?? null, a.mimeType?.slice(0, 120) ?? null, a.sizeBytes ?? null, a.sourceRef?.slice(0, 2000) ?? null]);
    }
  }
  if (inserted) {
    // Keep seq in chronological order even when older messages arrive late (backfill after webhooks).
    await db.exec(
      `UPDATE conversation_messages m SET seq = o.rn FROM (
         SELECT id, row_number() OVER (ORDER BY sent_at, seq, created_at) AS rn FROM conversation_messages WHERE thread_id = $1) o
        WHERE m.id = o.id AND m.seq <> o.rn`, [thread.id]);
  }
  return inserted;
}

async function ingestEmails(db: Db, orgId: string, interactionId: string, rec: NormalizedInteraction): Promise<number> {
  const emails = (rec.emails ?? []).filter((e) => e?.externalId).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  let inserted = 0;
  const maxSeq = await db.one<{ s: number }>('SELECT coalesce(max(seq), 0)::int AS s FROM email_messages WHERE interaction_id = $1', [interactionId]);
  let seq = maxSeq?.s ?? 0;
  for (const e of emails) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO email_messages (org_id, interaction_id, seq, external_message_id, sender_type, subject, from_address, to_addresses, cc_addresses, sent_at, body_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (interaction_id, external_message_id) DO NOTHING RETURNING id`,
      [orgId, interactionId, ++seq, String(e.externalId).slice(0, 500), e.senderType, e.subject?.slice(0, 500) ?? null, e.from?.slice(0, 500) ?? null,
        (e.to ?? []).slice(0, 50), (e.cc ?? []).slice(0, 50), validDate(e.sentAt) ?? new Date(), String(e.bodyText ?? '').slice(0, 100_000)]);
    if (!row) { seq--; continue; }
    inserted++;
    for (const a of e.attachments ?? []) {
      await db.exec(
        `INSERT INTO attachments (org_id, interaction_id, email_message_id, file_name, mime_type, size_bytes, source_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orgId, interactionId, row.id, a.fileName?.slice(0, 300) ?? null, a.mimeType?.slice(0, 120) ?? null, a.sizeBytes ?? null, a.sourceRef?.slice(0, 2000) ?? null]);
    }
  }
  if (inserted) {
    await db.exec(
      `UPDATE email_messages m SET seq = o.rn FROM (
         SELECT id, row_number() OVER (ORDER BY sent_at, seq, created_at) AS rn FROM email_messages WHERE interaction_id = $1) o
        WHERE m.id = o.id AND m.seq <> o.rn`, [interactionId]);
  }
  return inserted;
}

async function ingestCall(db: Db, orgId: string, interactionId: string, rec: NormalizedInteraction): Promise<boolean> {
  const agentPhone = normalisePhone(rec.agent?.phone ?? null);
  const c = rec.call;
  if (!c) return false;
  const ref = c.recordingRef?.trim() || null;
  const available = !!ref && (/^https?:\/\//i.test(ref) || ref.startsWith('myoperator-file:'));
  const before = await db.one<{ recording_source_ref: string | null; call_status: string }>('SELECT recording_source_ref, call_status FROM calls WHERE interaction_id = $1', [interactionId]);
  await db.exec(
    `INSERT INTO calls (org_id, interaction_id, call_status, duration_seconds, ring_seconds, from_number_masked, to_number_masked,
                        recording_available, recording_source_ref, language_hint, agent_phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (interaction_id) DO UPDATE SET
       call_status = EXCLUDED.call_status,
       duration_seconds = coalesce(EXCLUDED.duration_seconds, calls.duration_seconds),
       ring_seconds = coalesce(EXCLUDED.ring_seconds, calls.ring_seconds),
       from_number_masked = coalesce(EXCLUDED.from_number_masked, calls.from_number_masked),
       to_number_masked = coalesce(EXCLUDED.to_number_masked, calls.to_number_masked),
       recording_available = calls.recording_available OR EXCLUDED.recording_available,
       recording_source_ref = coalesce(EXCLUDED.recording_source_ref, calls.recording_source_ref),
       language_hint = coalesce(EXCLUDED.language_hint, calls.language_hint),
       agent_phone = coalesce(EXCLUDED.agent_phone, calls.agent_phone)`,
    [orgId, interactionId, c.status, c.durationSeconds ?? null, c.ringSeconds ?? null,
      c.fromNumber ? maskPhone(c.fromNumber) : null, c.toNumber ? maskPhone(c.toNumber) : null, available, ref, c.languageHint ?? null, agentPhone]);
  // New content for the pipeline: first time we see the call, or a recording arrived later.
  return !before || (!!ref && before.recording_source_ref !== ref) || before.call_status !== c.status;
}

/** Ingest one normalised record. Idempotent; safe to call repeatedly with the same or a growing record. */
export async function ingestRecord(db: Db, orgId: string, connectionId: string | null, rec: NormalizedInteraction, settings?: IngestSettings): Promise<IngestResult> {
  if (!rec?.sourcePlatform || !rec?.sourceRecordId) throw new Error('Record is missing sourcePlatform / sourceRecordId');
  if (!['call', 'chat', 'whatsapp', 'email'].includes(rec.channel)) throw new Error(`Unsupported channel "${rec.channel}"`);
  const cfg = settings ?? (await loadIngestSettings(db, orgId));
  const occurredAt = validDate(rec.occurredAt) ?? new Date();
  const sourceRecordId = String(rec.sourceRecordId).slice(0, 500);
  rec = { ...rec, sourceRecordId };

  const existing = await db.one<{ id: string; customer_id: string | null; agent_id: string | null }>(
    'SELECT id, customer_id, agent_id FROM interactions WHERE org_id = $1 AND source_platform = $2 AND source_record_id = $3 FOR UPDATE',
    [orgId, rec.sourcePlatform, sourceRecordId]);

  const customerId = await resolveCustomer(db, orgId, rec.customer, rec.sourcePlatform, cfg);
  const agent = await resolveAgent(db, orgId, rec.sourcePlatform, rec.agent);
  const ticketId = await upsertTicket(db, orgId, rec.sourcePlatform, rec.ticket ?? null, customerId, occurredAt);

  let interactionId: string;
  let created = false;
  if (!existing) {
    const r = await insertInteraction(db, orgId, connectionId, rec, occurredAt, { customerId, agentId: agent?.id ?? null, teamId: agent?.teamId ?? null, ticketId });
    interactionId = r.id;
    created = r.created;
  } else {
    interactionId = existing.id;
  }
  if (!created) {
    await db.exec(
      `UPDATE interactions SET
         customer_id = coalesce(customer_id, $2),
         agent_id = coalesce($3, agent_id),
         team_id = CASE WHEN $3::uuid IS NOT NULL THEN $4 ELSE team_id END,
         ticket_id = coalesce(ticket_id, $5),
         subject = coalesce(subject, $6),
         resolution_status = coalesce($7, resolution_status),
         ended_at = coalesce($8, ended_at),
         occurred_at = least(occurred_at, $9),
         connection_id = coalesce(connection_id, $10)
       WHERE id = $1`,
      [interactionId, customerId, agent?.id ?? null, agent?.teamId ?? null, ticketId, rec.subject?.slice(0, 500) ?? null,
        rec.resolutionStatus ?? null, validDate(rec.endedAt), occurredAt, connectionId]);
  }

  let newContent = created;
  if (rec.call) newContent = (await ingestCall(db, orgId, interactionId, rec)) || newContent;
  if (rec.messages?.length || rec.channel === 'chat' || rec.channel === 'whatsapp') {
    if ((await ingestMessages(db, orgId, interactionId, rec)) > 0) newContent = true;
  }
  if (rec.emails?.length) {
    if ((await ingestEmails(db, orgId, interactionId, rec)) > 0) newContent = true;
  }

  // Derived fields from the full stored thread.
  if (rec.channel === 'call') {
    const c = rec.call;
    if (created && c) {
      const preview = `${rec.direction === 'outbound' ? 'Outbound' : 'Inbound'} call · ${c.status}${c.durationSeconds ? ` · ${Math.floor(c.durationSeconds / 60)}m ${c.durationSeconds % 60}s` : ''}`;
      await db.exec('UPDATE interactions SET preview = $2 WHERE id = $1 AND preview IS NULL', [interactionId, preview]);
    }
    if (c?.status === 'answered' && validDate(rec.endedAt)) {
      await db.exec(`UPDATE interactions SET resolution_seconds = coalesce(resolution_seconds, greatest(0, extract(epoch FROM (ended_at - occurred_at))::int)) WHERE id = $1 AND ended_at IS NOT NULL`, [interactionId]);
    }
  } else if (newContent || rec.resolutionStatus) {
    const rows = rec.channel === 'email'
      ? await db.query<{ sender_type: string; sent_at: Date; body: string }>('SELECT sender_type, sent_at, body_text AS body FROM email_messages WHERE interaction_id = $1', [interactionId])
      : await db.query<{ sender_type: string; sent_at: Date; body: string }>('SELECT sender_type, sent_at, body FROM conversation_messages WHERE interaction_id = $1', [interactionId]);
    const m = conversationMetrics(rows.map((r) => ({ senderType: r.sender_type, sentAt: new Date(r.sent_at), body: r.body })));
    await db.exec(
      `UPDATE interactions SET
         first_response_seconds = $2,
         awaiting_agent_since = CASE WHEN resolution_status = 'resolved' THEN NULL ELSE $3::timestamptz END,
         preview = coalesce($4, preview),
         occurred_at = least(occurred_at, coalesce($5, occurred_at)),
         resolution_seconds = CASE WHEN resolution_status = 'resolved' AND $6::timestamptz IS NOT NULL
                                   THEN greatest(0, extract(epoch FROM ($6::timestamptz - least(occurred_at, coalesce($5, occurred_at))))::int)
                                   ELSE resolution_seconds END,
         ended_at = CASE WHEN resolution_status = 'resolved' THEN coalesce(ended_at, $6) ELSE ended_at END
       WHERE id = $1`,
      [interactionId, m.firstResponseSeconds, m.awaitingSince, m.preview, m.firstAt, m.lastAt]);
  }

  if (newContent || created) {
    await db.exec('SELECT rsi_refresh_search_text($1)', [interactionId]);
  }
  if (created && customerId) {
    // Repeat-contact flag for this customer's interactions (a backfilled older record can change later ones).
    await db.exec(
      `UPDATE interactions i SET is_repeat_contact = EXISTS (
          SELECT 1 FROM interactions p WHERE p.org_id = i.org_id AND p.customer_id = i.customer_id AND p.id <> i.id
             AND p.occurred_at < i.occurred_at AND p.occurred_at >= i.occurred_at - make_interval(days => $3))
        WHERE i.org_id = $1 AND i.customer_id = $2`, [orgId, customerId, cfg.repeatWindowDays]);
  }
  if (newContent && cfg.autoAnalyze) {
    await enqueueProcessing(db, orgId, interactionId, { reason: created ? 'imported' : 'new_content' });
  }
  return { status: created ? 'created' : newContent ? 'updated' : 'duplicate', interactionId, newContent };
}

/** JSON (e.g. from webhook_events.payload) → NormalizedInteraction with Date objects restored. */
export function reviveRecord(r: any): NormalizedInteraction {
  const d = (v: any) => (v ? new Date(v) : v);
  return {
    ...r,
    occurredAt: d(r.occurredAt),
    endedAt: d(r.endedAt),
    messages: r.messages?.map((m: NormalizedMessage) => ({ ...m, sentAt: d(m.sentAt) })),
    emails: r.emails?.map((e: any) => ({ ...e, sentAt: d(e.sentAt) })),
  };
}
