import { z } from 'zod';
import { SENTIMENTS, SEVERITIES, RESOLUTION_STATUSES } from '@/lib/constants';

/**
 * Output contract of one interaction analysis (Claude tool `submit_analysis` or the heuristic analyzer).
 * Empty string = "not applicable / not present" (strict tool schemas avoid nullable unions — see providers/anthropic.ts).
 * Evidence ids: [S<seq>] call segment, [M<seq>] chat/WhatsApp message, [E<seq>] email.
 */
export const EVIDENCE_ID_RE = /^[SME]\d+$/;
const evidenceId = z.string().transform((s) => s.trim().replace(/^\[|\]$/g, '').toUpperCase()).pipe(z.union([z.string().regex(EVIDENCE_ID_RE), z.literal('')]));
const txt = (max = 4000) => z.string().transform((s) => s.trim().slice(0, max));
const conf = z.number().transform((n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)));
const noted = z.object({ text: txt(1000), evidence_id: evidenceId });

export const analysisSchema = z.object({
  summary: txt(2000),
  customer_intent: txt(500),
  language: txt(40),
  sentiment: z.enum(SENTIMENTS),
  products: z.array(txt(120)).max(10),
  customer_questions: z.array(z.object({ question: txt(500), agent_answer: txt(1000), answered: z.boolean(), evidence_id: evidenceId })).max(20),
  concerns: z.array(txt(300)).max(20),
  requested_actions: z.array(txt(300)).max(10),
  speaker_labels: z.array(z.object({ evidence_id: evidenceId, speaker: z.enum(['agent', 'customer', 'unknown']) })).max(500),
  resolution_status_suggestion: z.enum(RESOLUTION_STATUSES),
  issue_labels: z.array(z.object({
    category_code: txt(80),
    subcategory_code: txt(120),
    is_primary: z.boolean(),
    product: txt(120),
    variant: txt(120),
    customer_reason: txt(500),
    agent_reason: txt(500),
    severity: z.enum(SEVERITIES),
    resolution_requested: txt(200),
    resolution_provided: txt(200),
    order_ref: txt(80),
    probable_root_cause: txt(500),
    confidence: conf,
    evidence_id: evidenceId,
  })).max(8),
  criterion_scores: z.array(z.object({
    code: txt(80),
    applicable: z.boolean(),
    score: z.number(),
    evidence_id: evidenceId,
    rationale: txt(600),
  })).max(40),
  positives: z.array(noted).max(15),
  missed_opportunities: z.array(noted).max(15),
  incorrect_statements: z.array(z.object({ text: txt(1000), correction: txt(1000), evidence_id: evidenceId })).max(15),
  policy_violations: z.array(z.object({ text: txt(1000), policy_slug: txt(120), evidence_id: evidenceId })).max(15),
  frustration_indicators: z.array(noted).max(15),
  improved_response: txt(3000),
  confidence: conf,
  policy_uncertain: z.boolean(),
  policy_uncertainty_note: txt(1000),
  flags: z.array(z.object({
    rule_code: txt(80),
    evidence_id: evidenceId,
    reason: txt(1000),
    criterion_code: txt(80),
    policy_slug: txt(120),
    confidence: conf,
    recommended_correction: txt(1500),
  })).max(20),
  translation_en: txt(60000),
});

export type AnalysisOutput = z.infer<typeof analysisSchema>;
export type AnalysisFlag = AnalysisOutput['flags'][number];

export interface SchemaVocab {
  categoryCodes: string[];      // top-level codes
  subcategoryCodes: string[];   // full codes "cat.sub"
  ruleCodes: string[];
  criterionCodes: string[];
  policySlugs: string[];
}

const S = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const enumOf = (vals: string[], description?: string) => ({ type: 'string', enum: Array.from(new Set(vals)), ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items: unknown, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
const EV = { type: 'string', pattern: '^([SME][0-9]+)?$', description: 'Evidence id like S4 / M3 / E1 from the transcript, or "" if none' };

/**
 * JSON Schema for the strict `submit_analysis` tool. All properties required, no unions, additionalProperties:false,
 * no numeric/string constraints (unsupported by strict mode). Codes are enums built from the org's live taxonomy,
 * rules, criteria and KB slugs so strict sampling can only emit valid values.
 */
export function analysisJsonSchema(v: SchemaVocab): Record<string, unknown> {
  const withEmpty = (xs: string[]) => [...xs, ''];
  const noted = obj({ text: S(), evidence_id: EV });
  return obj({
    summary: S('2–4 sentence neutral summary in English'),
    customer_intent: S('What the customer wants, one line'),
    language: S('Detected language(s): e.g. "hi", "en", "hi-en (Hinglish)"'),
    sentiment: enumOf([...SENTIMENTS]),
    products: arr(S(), 'Rosier products mentioned'),
    customer_questions: arr(obj({ question: S(), agent_answer: S('What the agent answered, or "" if unanswered'), answered: { type: 'boolean' }, evidence_id: EV })),
    concerns: arr(S()),
    requested_actions: arr(S()),
    speaker_labels: arr(obj({ evidence_id: EV, speaker: enumOf(['agent', 'customer', 'unknown']) }), 'Only for call segments whose speaker is unknown; otherwise []'),
    resolution_status_suggestion: enumOf([...RESOLUTION_STATUSES]),
    issue_labels: arr(obj({
      category_code: enumOf(v.categoryCodes),
      subcategory_code: enumOf(withEmpty(v.subcategoryCodes), 'Full code "category.sub" belonging to category_code, or ""'),
      is_primary: { type: 'boolean' },
      product: S(), variant: S(), customer_reason: S(), agent_reason: S(),
      severity: enumOf([...SEVERITIES]),
      resolution_requested: S(), resolution_provided: S(),
      order_ref: S('Only if literally present in the conversation, else ""'),
      probable_root_cause: S('INFERENCE ONLY, clearly hedged; "" when there is no supporting evidence'),
      confidence: { type: 'number', description: '0–1' },
      evidence_id: EV,
    })),
    criterion_scores: arr(obj({
      code: enumOf(v.criterionCodes),
      applicable: { type: 'boolean' },
      score: { type: 'integer', description: '0–5; use 0 when not applicable' },
      evidence_id: EV,
      rationale: S(),
    })),
    positives: arr(noted),
    missed_opportunities: arr(noted),
    incorrect_statements: arr(obj({ text: S(), correction: S('Correct information per approved KB, or "" if unknown'), evidence_id: EV })),
    policy_violations: arr(obj({ text: S(), policy_slug: enumOf(withEmpty(v.policySlugs)), evidence_id: EV })),
    frustration_indicators: arr(noted),
    improved_response: S('A better agent reply using only approved policy wording'),
    confidence: { type: 'number', description: 'Overall confidence 0–1' },
    policy_uncertain: { type: 'boolean' },
    policy_uncertainty_note: S(),
    flags: arr(obj({
      rule_code: enumOf(v.ruleCodes.length ? v.ruleCodes : ['none']),
      evidence_id: EV,
      reason: S(),
      criterion_code: enumOf(withEmpty(v.criterionCodes)),
      policy_slug: enumOf(withEmpty(v.policySlugs)),
      confidence: { type: 'number', description: '0–1' },
      recommended_correction: S(),
    })),
    translation_en: S('English translation of non-English content when requested, else ""'),
  });
}
