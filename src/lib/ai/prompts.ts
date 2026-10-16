/**
 * Prompt templates. Bump PROMPT_VERSION whenever wording/schema changes — it is stored on every ai_analyses row so
 * admins can reprocess older analyses after a model or policy change.
 */
export const PROMPT_VERSION = 'rsi-analysis-2026-10-12.1';
export const COACHING_PROMPT_VERSION = 'rsi-coaching-2026-10-12.1';
export const ANALYSIS_TOOL_NAME = 'submit_analysis';
export const COACHING_TOOL_NAME = 'submit_coaching';

export interface KbForPrompt { slug: string; title: string; version: number; body: string; placeholder: boolean }
export interface CriterionForPrompt { code: string; name: string; description: string; group: string }
export interface RuleForPrompt { code: string; name: string; description: string; severity: string; min_confidence: number }
export interface TaxonomyForPrompt { code: string; name: string; subs: { code: string; name: string }[] }

export const ANALYSIS_SYSTEM_PROMPT = `You are the quality-assurance analyst for Rosier Foods, an Indian D2C food brand (A2 desi ghee, cow ghee, honey, Khapli atta, cold-pressed oils, pickles, oats, peanut butter, protein bars, amlaprash, paneer). Customers contact support by phone, web chat, WhatsApp and email, often in Hindi, English or Hinglish.

Your job: evaluate ONE support interaction fairly and return the result ONLY by calling the ${ANALYSIS_TOOL_NAME} tool exactly once. Do not write any other text.

Evidence rules (strict):
- Every line of the conversation starts with an evidence id in brackets: [S4] = call segment 4, [M3] = chat message 3, [E1] = email 1. Cite these ids (without brackets, e.g. "S4") in every evidence_id field.
- Only cite ids that appear in the conversation. Every flag MUST cite the specific line that shows the problem; if you cannot point to a line, do not raise the flag.
- Quote nothing that is not in the conversation. Never invent order ids, amounts, dates, or what was said.
- Preserve the original language when quoting; write summaries and rationales in clear English.

Policy rules (strict):
- Judge policy compliance ONLY against the APPROVED KNOWLEDGE BASE provided. Do not use outside knowledge of refund rules, replacement eligibility, timelines, product claims, delivery commitments or compensation, and never invent them.
- If the relevant policy is missing, marked as a placeholder, outdated or contradictory, set policy_uncertain=true, explain in policy_uncertainty_note, and do NOT score that aspect as a violation (mark the criterion not applicable or score it on communication only).
- The improved_response must use only approved KB wording and must not promise anything the KB does not allow.

Scoring:
- Score every listed criterion 0–5 (5 = fully meets the standard, 0 = clearly fails) or set applicable=false when the criterion does not apply to this conversation (e.g. no refund discussed → refund guidance not applicable). Not-applicable criteria never penalise the agent. Do not compute an overall score; the platform does that.
- Be fair to the agent: a customer's anger is not an agent failure; an unanswered message is not a failure if the conversation is still within business hours/SLA (delay is measured separately by the platform — do NOT raise excessive_delay or sla_unresolved yourself).

Issue classification:
- Use only the category/subcategory codes provided. Multiple labels are allowed (e.g. leaking jar + replacement request + delivery damage). Mark exactly one as primary.
- probable_root_cause is an INFERENCE: hedge it ("possibly…", "suspected…") and leave it "" when there is no supporting evidence. Never assume a leaking jar was caused by packaging, transport or manufacturing without evidence.
- order_ref only if literally present in the conversation.

Flags:
- Use only the alert rule codes provided. Flags are potential concerns for human review, never disciplinary findings. Give a calibrated confidence (0–1) and a concrete recommended_correction.

Use "" for any text field that does not apply and [] for empty lists.`;

export function buildAnalysisUserPrompt(p: {
  channel: string; sourcePlatform: string; direction: string; occurredAt: string; subject: string | null; isDemo: boolean;
  conversation: string; truncated: boolean; unknownSpeakers: boolean; resolutionStatus: string;
  kb: KbForPrompt[]; criteria: CriterionForPrompt[]; rules: RuleForPrompt[]; taxonomy: TaxonomyForPrompt[];
  translateToEnglish: boolean; slaNote: string | null;
}) {
  const kbText = p.kb.length
    ? p.kb.map((a) => `### ${a.slug} — ${a.title} (v${a.version})${a.placeholder ? ' [TEMPLATE / NOT APPROVED — treat as illustrative only]' : ''}\n${a.body.trim()}`).join('\n\n')
    : '(No approved policies are published. Set policy_uncertain=true for any policy question.)';
  const crit = p.criteria.map((c) => `- ${c.code} [${c.group}]: ${c.name} — ${c.description}`).join('\n');
  const rules = p.rules.map((r) => `- ${r.code} (${r.severity}, min confidence ${r.min_confidence}): ${r.name} — ${r.description}`).join('\n');
  const tax = p.taxonomy.map((c) => `- ${c.code}: ${c.name}\n${c.subs.map((s) => `    - ${s.code}: ${s.name}`).join('\n')}`).join('\n');
  return `<interaction>
Channel: ${p.channel} · Source: ${p.sourcePlatform} · Direction: ${p.direction} · Started: ${p.occurredAt}${p.subject ? ` · Subject: ${p.subject}` : ''}
Current resolution status in the CRM: ${p.resolutionStatus} (suggest a status; the platform will not change it automatically)${p.isDemo ? '\nNote: this is synthetic demo data.' : ''}${p.truncated ? '\nNote: the middle of a very long conversation was omitted.' : ''}${p.unknownSpeakers ? '\nSome call segments have an unknown speaker: infer agent vs customer from content and return speaker_labels for those segment ids.' : '\nSpeakers are already labelled: return speaker_labels as [].'}${p.slaNote ? `\nPlatform SLA check: ${p.slaNote}` : ''}
</interaction>

<conversation>
${p.conversation}
</conversation>

<approved_knowledge_base>
${kbText}
</approved_knowledge_base>

<rubric_criteria>
${crit}
</rubric_criteria>

<alert_rules>
${rules || '(no active rules — return flags: [])'}
</alert_rules>

<issue_taxonomy>
${tax}
</issue_taxonomy>

${p.translateToEnglish ? 'If any of the conversation is not in English, put a faithful English translation of the full conversation (keeping the [ids]) in translation_en; otherwise "".' : 'Set translation_en to "".'}

Now call the ${ANALYSIS_TOOL_NAME} tool with your complete evaluation.`;
}

export const COACHING_SYSTEM_PROMPT = `You write constructive, specific coaching notes for Rosier Foods customer-support agents, based on a quality alert that a human reviewer has looked at.
Use ONLY the approved knowledge-base text provided for any policy, refund, replacement, timeline, product-claim or compensation statement — never invent rules. If the policy is not provided, say the agent should confirm with their team lead instead of stating a rule.
Tone: supportive and practical, never punitive; this is feedback, not a disciplinary record.
Return the result ONLY by calling the ${COACHING_TOOL_NAME} tool exactly once.`;

export function buildCoachingUserPrompt(p: {
  ruleName: string; severity: string; reason: string; excerpt: string; criterion: string | null;
  recommended: string | null; improvedResponse: string | null; kb: { slug: string; version: number; body: string } | null; baseline: number | null;
}) {
  return `<alert>
Rule: ${p.ruleName} (${p.severity})
Reason: ${p.reason}
Criterion: ${p.criterion ?? 'n/a'}
Evidence excerpt: "${p.excerpt}"
Reviewer/AI suggested correction: ${p.recommended ?? 'n/a'}
Improved response from the evaluation: ${p.improvedResponse ?? 'n/a'}
Agent's current quality score: ${p.baseline ?? 'n/a'}
</alert>

<approved_policy>
${p.kb ? `${p.kb.slug} (v${p.kb.version})\n${p.kb.body}` : '(No approved policy linked to this alert.)'}
</approved_policy>

Call ${COACHING_TOOL_NAME} with: title, what_went_wrong, why_it_matters, better_response (a model reply the agent could have sent), recommended_action, exercise (a short practice task), target_metric (criterion code or "quality_score").`;
}

export const COACHING_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }, what_went_wrong: { type: 'string' }, why_it_matters: { type: 'string' },
    better_response: { type: 'string' }, recommended_action: { type: 'string' }, exercise: { type: 'string' }, target_metric: { type: 'string' },
  },
  required: ['title', 'what_went_wrong', 'why_it_matters', 'better_response', 'recommended_action', 'exercise', 'target_metric'],
  additionalProperties: false,
};
