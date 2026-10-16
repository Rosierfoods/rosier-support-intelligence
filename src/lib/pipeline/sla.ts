/**
 * 'sla_check' job (per org, every 15 min from the worker): open complaints whose customer has been waiting longer than
 * the resolution SLA *in business hours* get one 'sla_unresolved' flag (evidence = the customer message awaiting reply).
 */
import { withOrg } from '@/lib/db';
import type { Job } from './jobs';
import { loadOrgSettings } from '@/lib/ai/settings';
import { businessMinutesBetween, fmtMin } from '@/lib/ai/sla';
import { applyAlerts } from '@/lib/ai/alerts';
import type { ResolvedFlag, RuleRow } from '@/lib/ai/analyze';

export async function runSlaCheckJob(job: Pick<Job, 'org_id'>, now = new Date()): Promise<{ checked: number; flagged: number }> {
  return withOrg(job.org_id, async (db) => {
    const settings = await loadOrgSettings(db, job.org_id);
    const rule = await db.one<any>(`SELECT id, code, name, description, severity, min_confidence, channels FROM alert_rules WHERE code = 'sla_unresolved' AND is_active`);
    if (!rule) return { checked: 0, flagged: 0 };
    const resMin = Number(settings.sla?.resolutionHours ?? 0) * 60;
    if (resMin <= 0) return { checked: 0, flagged: 0 };
    const rows = await db.query<any>(
      `SELECT i.id, i.org_id, i.ref, i.channel, i.agent_id, i.team_id, i.is_demo, i.awaiting_agent_since
         FROM interactions i
        WHERE i.resolution_status IN ('open','pending','unresolved','escalated') AND i.awaiting_agent_since IS NOT NULL
          AND i.channel <> 'call' AND i.channel = ANY($1)
          AND i.awaiting_agent_since < now() - make_interval(mins => $2)
          AND NOT EXISTS (SELECT 1 FROM quality_flags f WHERE f.interaction_id = i.id AND f.rule_code = 'sla_unresolved')
        ORDER BY i.awaiting_agent_since LIMIT 500`, [rule.channels, Math.floor(resMin)]); // wall-clock pre-filter; business hours checked below
    let flagged = 0;
    for (const r of rows) {
      const waited = businessMinutesBetween(r.awaiting_agent_since, now, settings.businessHours, settings.timezone);
      if (waited <= resMin) continue;
      const ev = r.channel === 'email'
        ? await db.one<any>(`SELECT seq, sent_at, body_text AS body FROM email_messages WHERE interaction_id = $1 AND sender_type = 'customer' AND sent_at <= $2 ORDER BY sent_at DESC LIMIT 1`, [r.id, r.awaiting_agent_since])
        : await db.one<any>(`SELECT seq, sent_at, body, external_message_id FROM conversation_messages WHERE interaction_id = $1 AND sender_type = 'customer' AND sent_at <= $2 ORDER BY sent_at DESC LIMIT 1`, [r.id, r.awaiting_agent_since]);
      if (!ev) continue; // flags must link to evidence
      const ref: Record<string, unknown> = r.channel === 'email'
        ? { email_seq: ev.seq, sent_at: new Date(ev.sent_at).toISOString() }
        : { message_seq: ev.seq, sent_at: new Date(ev.sent_at).toISOString(), ...(ev.external_message_id ? { message_external_id: ev.external_message_id } : {}) };
      const cand: ResolvedFlag = {
        rule_code: 'sla_unresolved', confidence: 1, criterion_code: null, policy_slug: null, source: 'sla',
        reason: `Customer has been waiting ${fmtMin(waited)} of business time for a reply; the resolution SLA is ${fmtMin(resMin)} (non-business hours excluded).`,
        recommended_correction: 'Reply now with a clear owner, next step and timeline; escalate if blocked.',
        excerpt: String(ev.body ?? '').slice(0, 1500), evidence_ref: ref, evidence_id: `${r.channel === 'email' ? 'E' : 'M'}${ev.seq}`,
      };
      const { inserted } = await applyAlerts(db, {
        interaction: r, evaluationId: null, candidates: [cand], rules: [{ ...rule, min_confidence: Number(rule.min_confidence) } as RuleRow], kb: [], settings,
      });
      flagged += inserted.length;
    }
    return { checked: rows.length, flagged };
  });
}
