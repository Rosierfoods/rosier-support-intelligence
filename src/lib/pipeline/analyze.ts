/**
 * 'analyze' job: AI classification + quality evaluation + alerts for one interaction.
 * DB work happens in short org-scoped transactions (RLS); the provider call happens outside any transaction.
 */
import { withOrg, type Db } from '@/lib/db';
import type { Job } from './jobs';
import {
  loadAnalysisContext, loadAiConnection, postProcessAnalysis, runAnalyzer, scoreAnalysis, vocabFor, PROMPT_VERSION,
  type AnalysisContext, type PostProcessed, type RawAnalysis,
} from '@/lib/ai/analyze';
import { applyAlerts } from '@/lib/ai/alerts';
import { HEURISTIC_PROVIDER } from '@/lib/ai/heuristic';
import { noteConnectionError, type LoadedConnection } from '@/lib/ai/connections';
import { PipelineError, ProviderError, errorMessage } from '@/lib/ai/errors';

export interface AnalyzeResult { status: 'completed' | 'requires_review'; score: number | null; flags: number; provider: string; model: string }

export async function runAnalyzeJob(job: Pick<Job, 'org_id' | 'interaction_id'>): Promise<AnalyzeResult> {
  const orgId = job.org_id;
  const interactionId = job.interaction_id;
  if (!interactionId) throw new PipelineError('Analyze job has no interaction.', { retryable: false });

  let ctx: AnalysisContext;
  let conn: LoadedConnection | null;
  try {
    ({ ctx, conn } = await withOrg(orgId, async (db) => {
      await db.exec(`UPDATE interactions SET processing_status = 'analyzing', processing_error = NULL WHERE id = $1`, [interactionId]);
      const ctx = await loadAnalysisContext(db, interactionId);
      const conn = await loadAiConnection(db, orgId);
      return { ctx, conn };
    }));
  } catch (e) {
    await markFailed(orgId, interactionId, errorMessage(e));
    throw e;
  }

  let raw: RawAnalysis;
  let pp: PostProcessed;
  try {
    raw = await runAnalyzer(ctx, conn);
    pp = postProcessAnalysis(raw.raw, {
      vocab: vocabFor(ctx), evidence: ctx.conversation.evidence, criteria: ctx.criteria, conversationText: ctx.conversation.text,
      slaCandidates: ctx.slaCandidates, activeRuleCodes: new Set(ctx.rules.map((r) => r.code)),
      source: raw.provider === HEURISTIC_PROVIDER ? 'heuristic' : 'ai',
    });
  } catch (e) {
    const msg = errorMessage(e);
    await markFailed(orgId, interactionId, msg, conn ? { provider: 'anthropic', model: String(conn.config.customModel || conn.config.model || 'claude') } : null);
    if (conn && e instanceof ProviderError && (e.status === 401 || e.status === 403)) await withOrg(orgId, (db) => noteConnectionError(db, conn!.id, msg));
    throw e;
  }

  return withOrg(orgId, (db) => persistAnalysis(db, ctx, raw, pp));
}

export async function persistAnalysis(db: Db, ctx: AnalysisContext, raw: RawAnalysis, pp: PostProcessed): Promise<AnalyzeResult> {
  const i = ctx.interaction;
  const out = pp.output;
  const { overall, groups, band, weights } = scoreAnalysis(pp, ctx.criteria, ctx.settings, i.channel);
  const kbIds = ctx.kb.map((k) => k.version_id);
  const product = out.products[0] ?? pp.labels.find((l) => l.product)?.product ?? null;
  const minConf = Number(ctx.settings.ai?.minConfidenceForAlert ?? 0.6);
  const needsReview = out.confidence < minConf || out.policy_uncertain;
  const status: AnalyzeResult['status'] = needsReview ? 'requires_review' : 'completed';

  // Stored output: spec fields + UI-friendly `text` on list items + server-side score breakdown.
  const stored = {
    ...out,
    product,
    customer_questions: out.customer_questions.map((q) => ({ ...q, text: q.agent_answer ? `${q.question} → ${q.agent_answer}` : `${q.question} (not answered)` })),
    resolution_status: out.resolution_status_suggestion, // suggestion only — interactions.resolution_status is never auto-changed
    score: { overall, band, groups, weights },
    sla_candidates: ctx.slaCandidates,
    validation: { dropped: pp.dropped, strict_schema: raw.strict ?? null },
    analyzer: raw.provider === HEURISTIC_PROVIDER ? 'Heuristic demo analyzer (keyword rules, not AI)' : 'Claude',
  };

  await db.exec(`UPDATE ai_analyses SET is_current = false WHERE interaction_id = $1 AND kind = 'full' AND is_current`, [i.id]);
  const analysis = await db.one<{ id: string }>(
    `INSERT INTO ai_analyses (org_id, interaction_id, kind, provider, model, prompt_version, kb_version_ids, status, output, input_tokens, output_tokens, is_current)
     VALUES ($1,$2,'full',$3,$4,$5,$6,'completed',$7,$8,$9,true) RETURNING id`,
    [i.org_id, i.id, raw.provider, raw.model, PROMPT_VERSION, kbIds, JSON.stringify(stored), raw.inputTokens, raw.outputTokens]);

  // Evaluation: a human evaluation stays current (human corrections win); otherwise the new AI evaluation becomes current.
  const cur = await db.one<{ evaluator_type: string }>(`SELECT evaluator_type FROM quality_evaluations WHERE interaction_id = $1 AND is_current LIMIT 1`, [i.id]);
  const humanCurrent = cur?.evaluator_type === 'human';
  if (!humanCurrent) await db.exec(`UPDATE quality_evaluations SET is_current = false WHERE interaction_id = $1 AND is_current`, [i.id]);
  const evaluation = await db.one<{ id: string }>(
    `INSERT INTO quality_evaluations (org_id, interaction_id, analysis_id, evaluator_type, overall_score, band, criterion_scores, group_scores,
       positives, missed_opportunities, incorrect_statements, policy_violations, frustration_indicators, improved_response, confidence,
       policy_uncertain, policy_uncertainty_note, rubric_snapshot, kb_version_ids, is_current)
     VALUES ($1,$2,$3,'ai',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [i.org_id, i.id, analysis!.id, overall, band, JSON.stringify(pp.criterionScores), JSON.stringify(groups),
      JSON.stringify(out.positives), JSON.stringify(out.missed_opportunities), JSON.stringify(out.incorrect_statements),
      JSON.stringify(out.policy_violations), JSON.stringify(out.frustration_indicators), out.improved_response || null,
      round3(out.confidence), out.policy_uncertain, out.policy_uncertainty_note || null,
      JSON.stringify({ weights, criteria: ctx.criteria.map((c) => ({ code: c.code, group: c.group_code })), bands: ctx.settings.scoreBands }),
      kbIds, !humanCurrent]);

  // Issue labels: deactivate previous AI labels, keep human labels.
  await db.exec(`UPDATE interaction_issue_labels SET is_active = false WHERE interaction_id = $1 AND source = 'ai' AND is_active`, [i.id]);
  const catId = new Map(ctx.categories.map((c) => [c.code, c.id]));
  for (const l of pp.labels) {
    const lab = await db.one<{ id: string }>(
      `INSERT INTO interaction_issue_labels (org_id, interaction_id, category_id, subcategory_id, is_primary, product, variant, customer_reason,
         agent_reason, severity, resolution_requested, resolution_provided, order_ref, escalated, confidence, evidence, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ai') RETURNING id`,
      [i.org_id, i.id, catId.get(l.category_code), l.subcategory_code ? catId.get(l.subcategory_code) ?? null : null, l.is_primary,
        l.product, l.variant, l.customer_reason, l.agent_reason, l.severity, l.resolution_requested, l.resolution_provided, l.order_ref,
        i.resolution_status === 'escalated', round3(l.confidence), l.evidence]);
    if (l.probable_root_cause) {
      await db.exec(
        `INSERT INTO issue_root_causes (org_id, label_id, interaction_id, cause, status, is_ai_inference, evidence) VALUES ($1,$2,$3,$4,'suspected',true,$5)`,
        [i.org_id, lab!.id, i.id, l.probable_root_cause, l.evidence]);
    }
  }

  // Speaker labels inferred by the model for undiarized call segments (never overrides known speakers).
  if (i.channel === 'call' && pp.speakerLabels.length) {
    for (const s of pp.speakerLabels) {
      await db.exec(
        `UPDATE transcript_segments ts SET speaker = $3 FROM call_transcripts t
          WHERE t.id = ts.transcript_id AND t.is_current AND ts.interaction_id = $1 AND ts.seq = $2 AND ts.speaker = 'unknown'`,
        [i.id, s.seq, s.speaker]);
    }
  }
  if (i.channel === 'call' && out.translation_en) {
    await db.exec(`UPDATE call_transcripts SET translation_en = $2 WHERE interaction_id = $1 AND is_current AND translation_en IS NULL`, [i.id, out.translation_en]);
  }

  // Alerts
  const { inserted } = await applyAlerts(db, {
    interaction: { id: i.id, org_id: i.org_id, ref: i.ref, channel: i.channel, agent_id: i.agent_id, team_id: i.team_id, is_demo: i.is_demo },
    evaluationId: evaluation!.id, candidates: pp.flags, rules: ctx.rules,
    kb: ctx.kb.map((k) => ({ article_id: k.article_id, version_id: k.version_id, slug: k.slug })), settings: ctx.settings,
  });

  await db.exec(
    `UPDATE interactions SET processing_status = $2, processing_error = $3, sentiment = $4, ai_summary = $5, customer_intent = $6,
       product = COALESCE(product, $7)
       ${humanCurrent ? '' : ', quality_score = $8, quality_band = $9'}
     WHERE id = $1`,
    humanCurrent
      ? [i.id, status, needsReview ? reviewReason(out, minConf) : null, out.sentiment, out.summary || null, out.customer_intent || null, product]
      : [i.id, status, needsReview ? reviewReason(out, minConf) : null, out.sentiment, out.summary || null, out.customer_intent || null, product, overall, band]);
  await db.exec('SELECT rsi_refresh_search_text($1)', [i.id]);
  return { status, score: overall, flags: inserted.length, provider: raw.provider, model: raw.model };
}

function reviewReason(out: { confidence: number; policy_uncertain: boolean }, minConf: number) {
  const r: string[] = [];
  if (out.confidence < minConf) r.push(`AI confidence ${Math.round(out.confidence * 100)}% is below the ${Math.round(minConf * 100)}% review threshold`);
  if (out.policy_uncertain) r.push('an approved policy was missing or unclear');
  return `Requires human review: ${r.join('; ')}.`;
}

/** Mark the interaction failed (separate transaction so it survives the job's error) and keep a failed ai_analyses row. */
export async function markFailed(orgId: string, interactionId: string, message: string, analysis?: { provider: string; model: string } | null) {
  try {
    await withOrg(orgId, async (db) => {
      await db.exec(`UPDATE interactions SET processing_status = 'failed', processing_error = $2 WHERE id = $1`, [interactionId, message.slice(0, 1000)]);
      if (analysis) {
        await db.exec(
          `INSERT INTO ai_analyses (org_id, interaction_id, kind, provider, model, prompt_version, status, error, is_current)
           VALUES ($1,$2,'full',$3,$4,$5,'failed',$6,false)`,
          [orgId, interactionId, analysis.provider, analysis.model, PROMPT_VERSION, message.slice(0, 2000)]);
      }
    });
  } catch { /* the job failure itself is still recorded on processing_jobs */ }
}

function round3(n: number) { return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000; }
