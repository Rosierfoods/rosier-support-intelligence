// Coaching drafts from quality flags. Uses Claude when connected (approved KB text only, strict tool output),
// otherwise a deterministic template. Signature is a contract used by the coaching workstream — keep it stable.
import { z } from 'zod';
import type { Db } from '@/lib/db';
import { findProviderConnection } from './connections';
import { callClaudeTool, claudeConfigFrom } from '@/lib/providers/anthropic';
import { COACHING_JSON_SCHEMA, COACHING_SYSTEM_PROMPT, COACHING_TOOL_NAME, buildCoachingUserPrompt } from './prompts';

export interface CoachingDraft {
  title: string; whatWentWrong: string; whyItMatters: string; evidence: string; sopReference: string | null;
  policyVersionId: string | null; betterResponse: string; recommendedAction: string; exercise: string;
  reviewDate: string; targetMetric: string; targetValue: number | null; baselineValue: number | null; source: 'ai' | 'manual';
  generatedBy: string; // 'template' | model name
}

const coachingSchema = z.object({
  title: z.string().min(1).max(200), what_went_wrong: z.string().min(1).max(2000), why_it_matters: z.string().min(1).max(2000),
  better_response: z.string().max(3000), recommended_action: z.string().max(2000), exercise: z.string().max(2000), target_metric: z.string().max(80),
});

/**
 * Build a coaching draft from a quality flag (evidence-based; uses only approved KB text). Runs inside withOrg.
 * Note: when Claude is connected this performs a network call inside the caller's transaction (typically a few seconds).
 */
export async function draftCoachingFromFlag(db: Db, flagId: string): Promise<CoachingDraft | null> {
  const f = await db.one(
    `SELECT f.*, i.quality_score, i.is_demo AS interaction_is_demo, a.slug AS kb_slug, v.version AS kb_version, v.body AS kb_body,
            v.status AS kb_status, v.is_placeholder AS kb_placeholder, e.improved_response, r.name AS rule_name
       FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id
       LEFT JOIN knowledge_base_articles a ON a.id = f.policy_article_id
       LEFT JOIN knowledge_base_versions v ON v.id = f.policy_version_id
       LEFT JOIN quality_evaluations e ON e.id = f.evaluation_id
       LEFT JOIN alert_rules r ON r.code = f.rule_code
      WHERE f.id = $1`, [flagId]);
  if (!f) return null;
  const review = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
  const baseline = f.quality_score !== null ? Number(f.quality_score) : null;
  const template: CoachingDraft = {
    title: f.title,
    whatWentWrong: f.reason,
    whyItMatters: 'Affects customer trust, repeat contacts and policy compliance.',
    evidence: f.excerpt,
    sopReference: f.kb_slug ? `${f.kb_slug} (v${f.kb_version})` : null,
    policyVersionId: f.policy_version_id,
    betterResponse: f.improved_response ?? f.recommended_correction ?? '',
    recommendedAction: f.recommended_correction ?? '',
    exercise: 'Review the referenced SOP with your team lead and apply it on the next five similar cases.',
    reviewDate: review,
    targetMetric: f.criterion_code ?? 'quality_score',
    targetValue: baseline !== null ? Math.min(100, Math.round(baseline + 15)) : 80,
    baselineValue: baseline,
    source: 'ai',
    generatedBy: 'template',
  };

  let conn;
  try { conn = await findProviderConnection(db, 'anthropic', f.org_id); } catch { conn = null; }
  if (!conn) return template;

  // Only approved text: published (or superseded-but-referenced) versions; placeholders only for demo records.
  const kbOk = f.kb_body && f.kb_status !== 'draft' && (!f.kb_placeholder || f.interaction_is_demo);
  try {
    const cfg = claudeConfigFrom(conn.config, conn.secrets);
    const { input, resp } = await callClaudeTool({ ...cfg, maxTokens: Math.min(cfg.maxTokens, 2000), timeoutMs: Math.min(cfg.timeoutMs, 60_000) }, {
      system: COACHING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildCoachingUserPrompt({
        ruleName: f.rule_name ?? f.title, severity: f.severity, reason: f.reason, excerpt: f.excerpt, criterion: f.criterion_code,
        recommended: f.recommended_correction, improvedResponse: f.improved_response, baseline,
        kb: kbOk ? { slug: f.kb_slug, version: f.kb_version, body: f.kb_body } : null,
      }) }],
      tool: { name: COACHING_TOOL_NAME, description: 'Submit the coaching note.', input_schema: COACHING_JSON_SCHEMA, strict: true },
    });
    const c = coachingSchema.parse(input);
    return {
      ...template,
      title: c.title, whatWentWrong: c.what_went_wrong, whyItMatters: c.why_it_matters,
      betterResponse: c.better_response || template.betterResponse, recommendedAction: c.recommended_action || template.recommendedAction,
      exercise: c.exercise || template.exercise,
      targetMetric: /^[a-z_]{2,60}$/.test(c.target_metric) ? c.target_metric : template.targetMetric,
      sopReference: kbOk ? template.sopReference : null,
      policyVersionId: kbOk ? template.policyVersionId : null,
      generatedBy: resp.model || cfg.model,
    };
  } catch (e) {
    console.warn(`[coaching] Claude draft failed, using template: ${(e as Error).message?.slice(0, 160)}`);
    return template;
  }
}
