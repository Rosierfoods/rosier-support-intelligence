/**
 * 'retention' job (per org, daily). Applies organizations.settings.retention:
 *   recordingsDays   → delete retained recording copies from private storage + null calls.recording_storage_key
 *   transcriptsDays  → blank transcript segment text / full text / translation (non-demo; metadata + analysis kept)
 *   messagesDays     → blank chat/WhatsApp message bodies and email bodies (non-demo)
 *   piiDays          → null customer name/phone/email for customers with no interaction newer than N days (non-demo)
 *   auditDays        → delete audit_logs older than N days
 * 0 or missing = keep forever. Writes one audit entry with counts.
 */
import { withOrg } from '@/lib/db';
import type { Job } from './jobs';
import { loadOrgSettings } from '@/lib/ai/settings';
import { audit } from '@/lib/audit';
import { getStorage } from '@/lib/storage';

const REDACTED = '[removed by retention policy]';
const days = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

export async function runRetentionJob(job: Pick<Job, 'org_id'>) {
  const orgId = job.org_id;
  const counts: Record<string, number> = {};
  const settings = await withOrg(orgId, (db) => loadOrgSettings(db, orgId));
  const r = settings.retention ?? ({} as any);

  // Recordings: storage deletes happen outside the DB transaction, in batches.
  const recDays = days(r.recordingsDays);
  if (recDays) {
    const storage = getStorage();
    let deleted = 0;
    for (let batch = 0; batch < 50; batch++) {
      const rows = await withOrg(orgId, (db) => db.query<{ id: string; recording_storage_key: string }>(
        `SELECT c.id, c.recording_storage_key FROM calls c JOIN interactions i ON i.id = c.interaction_id
          WHERE c.recording_storage_key IS NOT NULL AND i.occurred_at < now() - make_interval(days => $1) LIMIT 200`, [recDays]));
      if (!rows.length) break;
      try { await storage.delete(rows.map((x) => x.recording_storage_key)); } catch (e) {
        console.warn(`[retention] storage delete failed for org ${orgId}: ${(e as Error).message}`);
        break;
      }
      await withOrg(orgId, (db) => db.exec(`UPDATE calls SET recording_storage_key = NULL WHERE id = ANY($1)`, [rows.map((x) => x.id)]));
      deleted += rows.length;
      if (rows.length < 200) break;
    }
    counts.recordings_deleted = deleted;
  }

  await withOrg(orgId, async (db) => {
    const tDays = days(r.transcriptsDays);
    if (tDays) {
      counts.transcript_segments_redacted = await db.exec(
        `UPDATE transcript_segments s SET text = $2, text_en = NULL FROM interactions i
          WHERE i.id = s.interaction_id AND NOT i.is_demo AND i.occurred_at < now() - make_interval(days => $1) AND s.text <> $2`, [tDays, REDACTED]);
      counts.transcripts_redacted = await db.exec(
        `UPDATE call_transcripts t SET full_text = NULL, translation_en = NULL FROM interactions i
          WHERE i.id = t.interaction_id AND NOT i.is_demo AND i.occurred_at < now() - make_interval(days => $1)
            AND (t.full_text IS NOT NULL OR t.translation_en IS NOT NULL)`, [tDays]);
    }
    const mDays = days(r.messagesDays);
    if (mDays) {
      counts.messages_redacted = await db.exec(
        `UPDATE conversation_messages m SET body = $2 FROM interactions i
          WHERE i.id = m.interaction_id AND NOT i.is_demo AND i.occurred_at < now() - make_interval(days => $1) AND m.body <> $2`, [mDays, REDACTED]);
      counts.emails_redacted = await db.exec(
        `UPDATE email_messages e SET body_text = $2 FROM interactions i
          WHERE i.id = e.interaction_id AND NOT i.is_demo AND i.occurred_at < now() - make_interval(days => $1) AND e.body_text <> $2`, [mDays, REDACTED]);
    }
    if (tDays || mDays) {
      // Rebuild search text for records whose content was just redacted (those crossing the threshold recently).
      const ids = await db.query<{ id: string }>(
        `SELECT id FROM interactions WHERE NOT is_demo AND occurred_at < now() - make_interval(days => $1)
            AND occurred_at > now() - make_interval(days => $1 + 3) LIMIT 5000`,
        [Math.min(tDays || Number.MAX_SAFE_INTEGER, mDays || Number.MAX_SAFE_INTEGER)]);
      for (const x of ids) await db.exec('SELECT rsi_refresh_search_text($1)', [x.id]);
      counts.search_text_refreshed = ids.length;
    }
    const pDays = days(r.piiDays);
    if (pDays) {
      counts.customers_pii_removed = await db.exec(
        `UPDATE customers c SET name = NULL, phone = NULL, email = NULL
          WHERE NOT c.is_demo AND (c.name IS NOT NULL OR c.phone IS NOT NULL OR c.email IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM interactions i WHERE i.customer_id = c.id AND i.occurred_at >= now() - make_interval(days => $1))`, [pDays]);
    }
    const aDays = days(r.auditDays);
    if (aDays) counts.audit_logs_deleted = await db.exec(`DELETE FROM audit_logs WHERE created_at < now() - make_interval(days => $1)`, [aDays]);
    await audit(db, orgId, null, 'retention.run', 'organization', orgId, { counts, policy: r });
  });
  return counts;
}
