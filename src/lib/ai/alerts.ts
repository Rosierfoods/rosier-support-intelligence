/**
 * Alert engine (spec §10). Turns evidence-linked flag candidates into quality_flags according to the org's active
 * alert_rules (channel applicability, min confidence), de-duplicates per (interaction, rule, evidence), links the
 * relevant policy version, and notifies reviewers. Flags are *potential concerns* for human verification —
 * nothing here takes any action against an employee.
 */
import type { Db } from '@/lib/db';
import { notifyUsers, usersWithRoles } from '@/lib/notify';
import { enqueue } from '@/lib/pipeline/jobs';
import { evidenceKey } from './conversation';
import type { ResolvedFlag, RuleRow } from './analyze';
import type { OrgSettings } from '@/lib/constants';

export interface AlertInteraction { id: string; org_id: string; ref: string; channel: string; agent_id: string | null; team_id: string | null; is_demo: boolean }
export interface KbRef { article_id: string; version_id: string; slug: string }

export const CONFIRMED_STATUSES = ['confirmed', 'coaching_assigned', 'resolved'];

/** Pure filter: which candidates pass rule activity, channel and confidence; de-duplicated by rule+evidence. */
export function selectFlags(candidates: ResolvedFlag[], rules: RuleRow[], channel: string, existingKeys: Set<string> = new Set()) {
  const byCode = new Map(rules.map((r) => [r.code, r]));
  const seen = new Set(existingKeys);
  const out: { flag: ResolvedFlag; rule: RuleRow }[] = [];
  for (const f of candidates) {
    const rule = byCode.get(f.rule_code);
    if (!rule) continue;
    if (rule.channels?.length && !rule.channels.includes(channel)) continue;
    if (f.confidence < Number(rule.min_confidence ?? 0)) continue;
    const key = `${f.rule_code}|${evidenceKey(f.evidence_ref)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ flag: f, rule });
  }
  return out;
}

export async function applyAlerts(db: Db, p: {
  interaction: AlertInteraction; evaluationId: string | null; candidates: ResolvedFlag[]; rules: RuleRow[]; kb: KbRef[]; settings: OrgSettings;
}): Promise<{ inserted: { id: string; severity: string; rule_code: string }[] }> {
  const { interaction: i } = p;
  const existing = await db.query<{ rule_code: string; evidence_ref: any }>(`SELECT rule_code, evidence_ref FROM quality_flags WHERE interaction_id = $1`, [i.id]);
  const existingKeys = new Set(existing.map((e) => `${e.rule_code}|${evidenceKey(e.evidence_ref ?? {})}`));
  const kbBySlug = new Map(p.kb.map((k) => [k.slug, k]));
  const inserted: { id: string; severity: string; rule_code: string }[] = [];

  for (const { flag: f, rule } of selectFlags(p.candidates, p.rules, i.channel, existingKeys)) {
    const kb = f.policy_slug ? kbBySlug.get(f.policy_slug) : undefined;
    const row = await db.one<{ id: string }>(
      `INSERT INTO quality_flags (org_id, interaction_id, evaluation_id, agent_id, severity, rule_code, title, reason, excerpt, evidence_ref,
         criterion_code, policy_article_id, policy_version_id, confidence, recommended_correction, status, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new',$16) RETURNING id`,
      [i.org_id, i.id, p.evaluationId, i.agent_id, rule.severity, rule.code, rule.name, f.reason.slice(0, 2000), f.excerpt.slice(0, 2000),
        JSON.stringify(f.evidence_ref), f.criterion_code, kb?.article_id ?? null, kb?.version_id ?? null, round3(f.confidence),
        f.recommended_correction, i.is_demo]);
    inserted.push({ id: row!.id, severity: rule.severity, rule_code: rule.code });
  }

  // Repeated critical failures: ≥2 human-confirmed critical flags for this agent in 30 days → one critical flag (once per 30 days).
  const repeated = p.rules.find((r) => r.code === 'repeated_critical_failures');
  if (repeated && i.agent_id && (!repeated.channels?.length || repeated.channels.includes(i.channel))) {
    const confirmed = await db.query<{ id: string; ref: string; rule_code: string }>(
      `SELECT f.id, x.ref, f.rule_code FROM quality_flags f JOIN interactions x ON x.id = f.interaction_id
        WHERE f.agent_id = $1 AND f.severity = 'critical' AND f.rule_code <> 'repeated_critical_failures'
          AND f.status = ANY($2) AND f.created_at >= now() - interval '30 days' ORDER BY f.created_at DESC LIMIT 10`,
      [i.agent_id, CONFIRMED_STATUSES]);
    if (confirmed.length >= 2) {
      const already = await db.one(
        `SELECT 1 FROM quality_flags WHERE agent_id = $1 AND rule_code = 'repeated_critical_failures' AND created_at >= now() - interval '30 days' LIMIT 1`, [i.agent_id]);
      if (!already) {
        const refs = Array.from(new Set(confirmed.map((c) => c.ref)));
        const row = await db.one<{ id: string }>(
          `INSERT INTO quality_flags (org_id, interaction_id, evaluation_id, agent_id, severity, rule_code, title, reason, excerpt, evidence_ref,
             confidence, recommended_correction, status, is_demo)
           VALUES ($1,$2,$3,$4,'critical','repeated_critical_failures',$5,$6,$7,$8,1,$9,'new',$10) RETURNING id`,
          [i.org_id, i.id, p.evaluationId, i.agent_id, repeated.name,
            `${confirmed.length} critical alerts for this agent were confirmed by reviewers in the last 30 days. This is a pattern for a manager to review with the agent — not an automatic finding.`,
            `Confirmed critical alerts on: ${refs.join(', ')}`,
            JSON.stringify({ related_flag_ids: confirmed.map((c) => c.id), related_interaction_refs: refs }),
            'Team lead to review the related cases with the agent and agree a coaching plan.', i.is_demo]);
        inserted.push({ id: row!.id, severity: 'critical', rule_code: 'repeated_critical_failures' });
      }
    }
  }

  if (inserted.length) await notifyForFlags(db, i, inserted, p.settings);
  return { inserted };
}

async function notifyForFlags(db: Db, i: AlertInteraction, flags: { id: string; severity: string; rule_code: string }[], settings: OrgSettings) {
  const critical = flags.filter((f) => f.severity === 'critical');
  const high = flags.filter((f) => f.severity === 'high');
  if (!critical.length && !high.length) return;
  const lead = i.team_id ? await db.one<{ lead_user_id: string | null }>('SELECT lead_user_id FROM teams WHERE id = $1', [i.team_id]) : null;
  const leadIds = lead?.lead_user_id ? [lead.lead_user_id] : [];
  const link = `/inbox/${i.id}`;
  if (critical.length) {
    const users = [...(await usersWithRoles(db, ['super_admin', 'crm_manager'])), ...leadIds];
    await notifyUsers(db, i.org_id, users, {
      type: 'quality_flag', severity: 'critical', link: `${link}?flag=${critical[0].id}#evidence`,
      title: `Critical alert on ${i.ref}${i.is_demo ? ' (demo)' : ''}`,
      body: `${critical.length} potential critical concern${critical.length > 1 ? 's' : ''} (${critical.map((c) => c.rule_code.replace(/_/g, ' ')).join(', ')}) need human review.`,
    });
    if (settings.notifications?.emailCritical && process.env.SMTP_URL) {
      for (const f of critical) await enqueue(db, i.org_id, 'notify', { interactionId: i.id, payload: { flagId: f.id, kind: 'critical_flag' }, dedupeKey: `notify:flag:${f.id}`, priority: 40 });
    }
  }
  if (high.length) {
    const users = [...(await usersWithRoles(db, ['crm_manager'])), ...leadIds];
    await notifyUsers(db, i.org_id, users, {
      type: 'quality_flag', severity: 'high', link: `${link}?flag=${high[0].id}#evidence`,
      title: `High-severity alert on ${i.ref}${i.is_demo ? ' (demo)' : ''}`,
      body: `${high.length} potential concern${high.length > 1 ? 's' : ''} (${high.map((c) => c.rule_code.replace(/_/g, ' ')).join(', ')}) for review.`,
    });
  }
}

function round3(n: number) { return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000; }
