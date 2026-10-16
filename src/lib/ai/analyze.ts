/**
 * Interaction analysis: load context → call Claude (or the demo heuristic) → validate & post-process.
 * Persistence lives in src/lib/pipeline/analyze.ts. Nothing here logs conversation text or secrets.
 */
import type { Db } from '@/lib/db';
import type { Channel, OrgSettings, RubricGroup } from '@/lib/constants';
import { computeScore, bandFor, weightsFor, type CriterionDef, type CriterionScore } from './scoring';
import { analysisSchema, analysisJsonSchema, type AnalysisOutput, type SchemaVocab } from './schema';
import { buildConversation, resolveEvidence, type BuiltConversation, type EvidenceItem } from './conversation';
import { computeSlaCandidates, type SlaCandidate } from './sla';
import { heuristicAnalysis, HEURISTIC_MODEL, HEURISTIC_PROVIDER } from './heuristic';
import { ANALYSIS_SYSTEM_PROMPT, ANALYSIS_TOOL_NAME, PROMPT_VERSION, buildAnalysisUserPrompt } from './prompts';
import { loadOrgSettings } from './settings';
import { findProviderConnection, type LoadedConnection } from './connections';
import { PipelineError, ProviderError } from './errors';
import { callClaudeTool, claudeConfigFrom } from '@/lib/providers/anthropic';

/** Rules computed deterministically by the platform — never accepted from the model. */
export const SYSTEM_RULES = new Set(['excessive_delay', 'sla_unresolved', 'repeated_critical_failures']);
export const NO_AI_PROVIDER_MESSAGE = 'No AI analysis provider connected. Connect Claude on the Integrations page.';

export interface KbRow { article_id: string; version_id: string; slug: string; title: string; version: number; body: string; is_placeholder: boolean }
export interface RuleRow { id: string; code: string; name: string; description: string; severity: string; min_confidence: number; channels: string[] }
export interface CriterionRow { code: string; name: string; description: string; group_code: string; channels: string[] }
export interface CategoryRow { id: string; code: string; name: string; parent_id: string | null }

export interface AnalysisContext {
  interaction: {
    id: string; org_id: string; ref: string; channel: Channel; direction: string; source_platform: string; occurred_at: Date;
    subject: string | null; is_demo: boolean; agent_id: string | null; team_id: string | null; resolution_status: string; product: string | null;
  };
  settings: OrgSettings;
  conversation: BuiltConversation;
  kb: KbRow[];
  criteria: CriterionRow[];
  rules: RuleRow[];
  categories: CategoryRow[];
  slaCandidates: SlaCandidate[];
  hasUnknownSpeakers: boolean;
}

// ───────────────────────── Context ─────────────────────────
export async function loadAnalysisContext(db: Db, interactionId: string, now = new Date()): Promise<AnalysisContext> {
  const i = await db.one<any>(
    `SELECT id, org_id, ref, channel, direction, source_platform, occurred_at, subject, is_demo, agent_id, team_id, resolution_status, product
       FROM interactions WHERE id = $1`, [interactionId]);
  if (!i) throw new PipelineError('Interaction no longer exists.', { retryable: false });
  const settings = await loadOrgSettings(db, i.org_id);

  let segments: any[] = [], messages: any[] = [], emails: any[] = [];
  if (i.channel === 'call') {
    segments = await db.query(
      `SELECT s.seq, s.speaker, s.start_ms, s.end_ms, s.text, s.text_en FROM transcript_segments s
         JOIN call_transcripts t ON t.id = s.transcript_id AND t.is_current AND t.status = 'completed'
        WHERE s.interaction_id = $1 ORDER BY s.seq`, [interactionId]);
  } else if (i.channel === 'email') {
    emails = await db.query(`SELECT seq, sender_type, subject, sent_at, body_text, external_message_id FROM email_messages WHERE interaction_id = $1 ORDER BY seq`, [interactionId]);
  } else {
    messages = await db.query(`SELECT seq, sender_type, sender_name, body, sent_at, external_message_id FROM conversation_messages WHERE interaction_id = $1 ORDER BY seq`, [interactionId]);
  }
  const conversation = buildConversation({ channel: i.channel, segments, messages, emails }, { tz: settings.timezone });
  if (!conversation.evidence.size) {
    throw new PipelineError(i.channel === 'call' ? 'Nothing to analyse: this call has no completed transcript.' : 'Nothing to analyse: no messages were imported for this conversation.', { retryable: false });
  }

  const kbAll = await db.query<KbRow>(
    `SELECT a.id AS article_id, v.id AS version_id, a.slug, a.title, v.version, v.body, v.is_placeholder
       FROM knowledge_base_articles a JOIN knowledge_base_versions v ON v.id = a.current_version_id
      WHERE a.status = 'published' AND v.status = 'published' ORDER BY a.slug`);
  // Placeholder (template) policies are never treated as approved policy for live data.
  const kb = i.is_demo ? kbAll : kbAll.filter((k) => !k.is_placeholder);

  const criteria = await db.query<CriterionRow>(
    `SELECT code, name, description, group_code, channels FROM quality_criteria WHERE is_active AND $1 = ANY(channels) ORDER BY sort, code`, [i.channel]);
  const rules = (await db.query<any>(
    `SELECT id, code, name, description, severity, min_confidence, channels FROM alert_rules WHERE is_active AND $1 = ANY(channels) ORDER BY code`, [i.channel]))
    .map((r) => ({ ...r, min_confidence: Number(r.min_confidence) })) as RuleRow[];
  const categories = await db.query<CategoryRow>(
    `SELECT c.id, c.code, c.name, c.parent_id FROM issue_categories c
       LEFT JOIN issue_categories p ON p.id = c.parent_id
      WHERE c.is_active AND (c.parent_id IS NULL OR p.is_active) ORDER BY c.sort, c.code`);

  let slaCandidates: SlaCandidate[] = [];
  if (i.channel !== 'call') {
    const slaMsgs = i.channel === 'email'
      ? emails.map((e) => ({ seq: e.seq, sender_type: e.sender_type, sent_at: e.sent_at }))
      : messages.map((m) => ({ seq: m.seq, sender_type: m.sender_type, sent_at: m.sent_at }));
    slaCandidates = computeSlaCandidates(slaMsgs, i.channel, settings, { now, resolved: i.resolution_status === 'resolved' }).candidates;
  }
  return {
    interaction: { ...i, occurred_at: new Date(i.occurred_at) }, settings, conversation, kb, criteria, rules, categories, slaCandidates,
    hasUnknownSpeakers: conversation.unknownSpeakers,
  };
}

export function vocabFor(ctx: Pick<AnalysisContext, 'categories' | 'rules' | 'criteria' | 'kb'>): SchemaVocab {
  const parents = ctx.categories.filter((c) => !c.parent_id);
  const parentIds = new Set(parents.map((p) => p.id));
  return {
    categoryCodes: parents.map((c) => c.code),
    subcategoryCodes: ctx.categories.filter((c) => c.parent_id && parentIds.has(c.parent_id)).map((c) => c.code),
    ruleCodes: ctx.rules.map((r) => r.code).filter((c) => !SYSTEM_RULES.has(c)),
    criterionCodes: ctx.criteria.map((c) => c.code),
    policySlugs: ctx.kb.map((k) => k.slug),
  };
}

// ───────────────────────── Provider call ─────────────────────────
export interface RawAnalysis { raw: unknown; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; strict?: boolean }

export function buildClaudeAnalysisRequest(ctx: AnalysisContext) {
  const vocab = vocabFor(ctx);
  const parents = ctx.categories.filter((c) => !c.parent_id);
  const slaNote = ctx.slaCandidates.length ? ctx.slaCandidates.map((c) => `${c.rule_code} at ${c.evidence_id}: ${c.reason}`).join(' ') : null;
  const user = buildAnalysisUserPrompt({
    channel: ctx.interaction.channel, sourcePlatform: ctx.interaction.source_platform, direction: ctx.interaction.direction,
    occurredAt: ctx.interaction.occurred_at.toISOString(), subject: ctx.interaction.subject, isDemo: ctx.interaction.is_demo,
    conversation: ctx.conversation.text, truncated: ctx.conversation.truncated, unknownSpeakers: ctx.hasUnknownSpeakers,
    resolutionStatus: ctx.interaction.resolution_status,
    kb: ctx.kb.map((k) => ({ slug: k.slug, title: k.title, version: k.version, body: k.body, placeholder: k.is_placeholder })),
    criteria: ctx.criteria.map((c) => ({ code: c.code, name: c.name, description: c.description, group: c.group_code })),
    rules: ctx.rules.filter((r) => !SYSTEM_RULES.has(r.code)).map((r) => ({ code: r.code, name: r.name, description: r.description, severity: r.severity, min_confidence: r.min_confidence })),
    taxonomy: parents.map((p) => ({ code: p.code, name: p.name, subs: ctx.categories.filter((c) => c.parent_id === p.id).map((c) => ({ code: c.code, name: c.name })) })),
    translateToEnglish: !!ctx.settings.ai?.translateToEnglish,
    slaNote,
  });
  return {
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: user }],
    tool: {
      name: ANALYSIS_TOOL_NAME,
      description: 'Submit the complete, evidence-linked quality evaluation for this interaction. Call exactly once.',
      input_schema: analysisJsonSchema(vocab),
      strict: true,
    },
  };
}

/**
 * Pick the analyser: Claude when connected; else the heuristic for demo records; else fail clearly.
 * Must be called OUTSIDE a DB transaction (network I/O).
 */
export async function runAnalyzer(ctx: AnalysisContext, conn: LoadedConnection | null, fetchImpl: typeof fetch = fetch): Promise<RawAnalysis> {
  if (conn) {
    const cfg = claudeConfigFrom(conn.config, conn.secrets);
    const req = buildClaudeAnalysisRequest(ctx);
    const { resp, input, strict } = await callClaudeTool(cfg, req, fetchImpl);
    return { raw: input, provider: 'anthropic', model: resp.model || cfg.model, inputTokens: resp.usage.inputTokens, outputTokens: resp.usage.outputTokens, strict };
  }
  if (ctx.interaction.is_demo) {
    const vocab = vocabFor(ctx);
    const raw = heuristicAnalysis({
      channel: ctx.interaction.channel, evidence: ctx.conversation.evidence,
      taxonomySubs: new Set(vocab.subcategoryCodes), taxonomyCats: new Set(vocab.categoryCodes),
      criteria: ctx.criteria, ruleCodes: new Set(vocab.ruleCodes),
    });
    return { raw, provider: HEURISTIC_PROVIDER, model: HEURISTIC_MODEL, inputTokens: null, outputTokens: null };
  }
  throw new PipelineError(NO_AI_PROVIDER_MESSAGE, { retryable: true, retryAfterMs: 30 * 60_000 });
}

export async function loadAiConnection(db: Db, orgId: string) {
  return findProviderConnection(db, 'anthropic', orgId);
}

// ───────────────────────── Validation & post-processing (pure) ─────────────────────────
export interface ResolvedLabel {
  category_code: string; subcategory_code: string | null; is_primary: boolean; product: string | null; variant: string | null;
  customer_reason: string | null; agent_reason: string | null; severity: string; resolution_requested: string | null; resolution_provided: string | null;
  order_ref: string | null; probable_root_cause: string | null; confidence: number; evidence: string | null; evidence_ref: Record<string, unknown> | null;
}
export interface ResolvedFlag {
  rule_code: string; reason: string; criterion_code: string | null; policy_slug: string | null; confidence: number;
  recommended_correction: string | null; excerpt: string; evidence_ref: Record<string, unknown>; evidence_id: string; source: 'ai' | 'sla' | 'heuristic';
}
export interface PostProcessed {
  output: AnalysisOutput;
  labels: ResolvedLabel[];
  flags: ResolvedFlag[];
  criterionScores: (CriterionScore & { evidence_id?: string; evidence_ref?: Record<string, unknown> | null })[];
  speakerLabels: { seq: number; speaker: 'agent' | 'customer' | 'unknown' }[];
  dropped: { flags: number; labels: number; criteria: number; evidence: number };
}

const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/**
 * Validate tool output with zod, enforce vocabularies (taxonomy / rules / criteria / KB slugs), resolve evidence ids,
 * DROP flags whose evidence id does not resolve (flags must always link to evidence), and merge deterministic SLA candidates.
 */
export function postProcessAnalysis(raw: unknown, p: {
  vocab: SchemaVocab; evidence: Map<string, EvidenceItem>; criteria: { code: string }[]; conversationText: string;
  slaCandidates?: SlaCandidate[]; activeRuleCodes?: Set<string>; source?: 'ai' | 'heuristic';
}): PostProcessed {
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ProviderError('analysis', `AI output failed validation (${issues}).`, { retryable: true, retryAfterMs: 120_000 });
  }
  const out = parsed.data;
  const cats = new Set(p.vocab.categoryCodes), subs = new Set(p.vocab.subcategoryCodes);
  const rules = new Set(p.vocab.ruleCodes.filter((r) => !SYSTEM_RULES.has(r)));
  const crits = new Set(p.vocab.criterionCodes), slugs = new Set(p.vocab.policySlugs);
  const dropped = { flags: 0, labels: 0, criteria: 0, evidence: 0 };
  const convLower = p.conversationText.toLowerCase();
  const ev = (id: string) => resolveEvidence(p.evidence, id);

  // labels
  const labels: ResolvedLabel[] = [];
  for (const l of out.issue_labels) {
    if (!cats.has(l.category_code)) { dropped.labels++; continue; }
    const sub = l.subcategory_code && subs.has(l.subcategory_code) && l.subcategory_code.startsWith(l.category_code + '.') ? l.subcategory_code : null;
    if (labels.some((x) => x.category_code === l.category_code && x.subcategory_code === sub)) continue;
    const e = ev(l.evidence_id);
    if (l.evidence_id && !e) dropped.evidence++;
    const order = blank(l.order_ref);
    labels.push({
      category_code: l.category_code, subcategory_code: sub, is_primary: l.is_primary,
      product: blank(l.product), variant: blank(l.variant), customer_reason: blank(l.customer_reason), agent_reason: blank(l.agent_reason),
      severity: l.severity, resolution_requested: blank(l.resolution_requested), resolution_provided: blank(l.resolution_provided),
      order_ref: order && convLower.includes(order.toLowerCase()) ? order : null, // only if literally present
      probable_root_cause: blank(l.probable_root_cause), confidence: l.confidence,
      evidence: e ? e.excerpt.slice(0, 500) : null, evidence_ref: e ? e.ref : null,
    });
  }
  if (labels.length && labels.filter((l) => l.is_primary).length !== 1) labels.forEach((l, idx) => { l.is_primary = idx === 0; });

  // criteria → every configured criterion appears exactly once (missing ⇒ N/A)
  const byCode = new Map<string, AnalysisOutput['criterion_scores'][number]>();
  for (const c of out.criterion_scores) { if (crits.has(c.code)) { if (!byCode.has(c.code)) byCode.set(c.code, c); } else dropped.criteria++; }
  const criterionScores = p.criteria.map((c) => {
    const s = byCode.get(c.code);
    if (!s) return { code: c.code, score: null, na: true, rationale: 'Not evaluated by the analyser.' };
    const e = ev(s.evidence_id);
    if (!s.applicable) return { code: c.code, score: null, na: true, rationale: s.rationale || 'Not applicable.', evidence_id: e?.id, evidence_ref: e?.ref ?? null };
    return {
      code: c.code, score: Math.max(0, Math.min(5, Math.round(s.score))), na: false,
      evidence: e ? e.excerpt.slice(0, 300) : undefined, evidence_id: e?.id, evidence_ref: e?.ref ?? null, rationale: s.rationale,
    };
  });

  // flags
  const flags: ResolvedFlag[] = [];
  const src = p.source ?? 'ai';
  for (const f of out.flags) {
    if (!rules.has(f.rule_code) || (p.activeRuleCodes && !p.activeRuleCodes.has(f.rule_code))) { dropped.flags++; continue; }
    const e = ev(f.evidence_id);
    if (!e) { dropped.flags++; continue; } // flags must always link to evidence
    flags.push({
      rule_code: f.rule_code, reason: f.reason || 'Potential concern detected.', criterion_code: f.criterion_code && crits.has(f.criterion_code) ? f.criterion_code : null,
      policy_slug: f.policy_slug && slugs.has(f.policy_slug) ? f.policy_slug : null, confidence: f.confidence,
      recommended_correction: blank(f.recommended_correction), excerpt: e.excerpt, evidence_ref: e.ref, evidence_id: e.id, source: src,
    });
  }
  for (const c of p.slaCandidates ?? []) {
    if (p.activeRuleCodes && !p.activeRuleCodes.has(c.rule_code)) continue;
    const e = ev(c.evidence_id);
    if (!e) continue;
    flags.push({
      rule_code: c.rule_code, reason: c.reason, criterion_code: null, policy_slug: null, confidence: c.confidence,
      recommended_correction: c.awaiting ? 'Reply to the customer now with a clear next step and timeline.' : 'Respond within the first-response SLA during business hours; set expectations when a check will take longer.',
      excerpt: e.excerpt, evidence_ref: e.ref, evidence_id: e.id, source: 'sla',
    });
  }

  // speaker labels (calls only; S ids)
  const speakerLabels = out.speaker_labels
    .map((s) => ({ e: ev(s.evidence_id), speaker: s.speaker }))
    .filter((x) => x.e && x.e.ref.segment_seq !== undefined && x.speaker !== 'unknown')
    .map((x) => ({ seq: Number(x.e!.ref.segment_seq), speaker: x.speaker }));

  // sanitise free-text references
  out.policy_violations = out.policy_violations.map((v) => ({ ...v, policy_slug: slugs.has(v.policy_slug) ? v.policy_slug : '' }));
  for (const list of [out.positives, out.missed_opportunities, out.frustration_indicators, out.incorrect_statements, out.policy_violations, out.customer_questions] as { evidence_id: string }[][]) {
    for (const x of list) if (x.evidence_id && !ev(x.evidence_id)) { x.evidence_id = ''; dropped.evidence++; }
  }
  return { output: out, labels, flags, criterionScores, speakerLabels, dropped };
}

/** Server-side score — never trust model arithmetic. */
export function scoreAnalysis(pp: Pick<PostProcessed, 'criterionScores'>, criteria: CriterionRow[], settings: OrgSettings, channel: Channel) {
  const defs: CriterionDef[] = criteria.map((c) => ({ code: c.code, name: c.name, group: c.group_code as RubricGroup, channels: c.channels }));
  const weights = weightsFor(settings, channel);
  const { overall, groups } = computeScore(pp.criterionScores, defs, weights);
  const band = bandFor(overall, settings.scoreBands);
  return { overall, groups, band: band?.label ?? null, weights };
}

export { PROMPT_VERSION };
