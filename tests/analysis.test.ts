import { describe, expect, it } from 'vitest';
import { buildConversation, resolveEvidence } from '@/lib/ai/conversation';
import { postProcessAnalysis, buildClaudeAnalysisRequest, vocabFor, scoreAnalysis, type AnalysisContext } from '@/lib/ai/analyze';
import { analysisSchema, type AnalysisOutput } from '@/lib/ai/schema';
import { businessMinutesBetween, computeSlaCandidates } from '@/lib/ai/sla';
import { heuristicAnalysis } from '@/lib/ai/heuristic';
import { selectFlags } from '@/lib/ai/alerts';
import { buildMessagesRequest, callClaudeTool, extractToolInput, mapAnthropicError } from '@/lib/providers/anthropic';
import { mapSarvamOutput, chooseSttMode, sarvamConfigFrom } from '@/lib/providers/sarvam';
import { mapSpeakers } from '@/lib/pipeline/transcribe';
import { DEFAULT_ALERT_RULES, DEFAULT_CRITERIA, DEFAULT_ORG_SETTINGS, DEFAULT_TAXONOMY, KB_DEFAULT_ARTICLES } from '@/lib/constants';
import { ProviderError } from '@/lib/ai/errors';

// ───────────── fixtures ─────────────
const IST = (s: string) => new Date(`${s}+05:30`);
const chat = buildConversation({
  channel: 'chat',
  messages: [
    { seq: 0, sender_type: 'customer', body: 'Hi, my ghee jar arrived leaking. Order #RF102938', sent_at: IST('2026-10-09T11:00:00') },
    { seq: 1, sender_type: 'agent', sender_name: 'Priya Sharma', body: 'Sorry to hear that! Please share a photo.', sent_at: IST('2026-10-09T11:05:00') },
    { seq: 2, sender_type: 'customer', body: 'Sent. Will I get a refund today?', sent_at: IST('2026-10-09T11:07:00') },
    { seq: 3, sender_type: 'agent', sender_name: 'Priya Sharma', body: 'Yes, refund will be done today, guaranteed.', sent_at: IST('2026-10-09T11:09:00') },
  ],
});

const categories = DEFAULT_TAXONOMY.flatMap((c, ci) => [
  { id: `c${ci}`, code: c.code, name: c.name, parent_id: null as string | null },
  ...c.subs.map(([s, n], si) => ({ id: `c${ci}s${si}`, code: `${c.code}.${s}`, name: n, parent_id: `c${ci}` })),
]);
const rules = DEFAULT_ALERT_RULES.map((r, k) => ({ id: `r${k}`, code: r.code, name: r.name, description: r.description, severity: r.severity, min_confidence: r.min_confidence ?? 0.6, channels: ['call', 'chat', 'whatsapp', 'email'] }));
const criteria = DEFAULT_CRITERIA.map((c) => ({ code: c.code, name: c.name, description: c.description, group_code: c.group, channels: ['call', 'chat', 'whatsapp', 'email'] }));
const kb = KB_DEFAULT_ARTICLES.map((a, k) => ({ article_id: `a${k}`, version_id: `v${k}`, slug: a.slug, title: a.title, version: 1, body: 'Policy text', is_placeholder: false }));
const vocab = vocabFor({ categories, rules, criteria, kb });

function baseOutput(over: Partial<AnalysisOutput> = {}): AnalysisOutput {
  return {
    summary: 'Leaking jar; agent promised refund.', customer_intent: 'replacement or refund', language: 'en', sentiment: 'negative',
    products: ['A2 Desi Ghee'], customer_questions: [], concerns: [], requested_actions: [], speaker_labels: [],
    resolution_status_suggestion: 'pending', issue_labels: [], criterion_scores: [], positives: [], missed_opportunities: [],
    incorrect_statements: [], policy_violations: [], frustration_indicators: [], improved_response: '', confidence: 0.8,
    policy_uncertain: false, policy_uncertainty_note: '', flags: [], translation_en: '', ...over,
  };
}

// ───────────── evidence mapping ─────────────
describe('conversation evidence ids', () => {
  it('assigns stable ids and refs', () => {
    expect(chat.text).toContain('[M0]');
    expect(chat.text).toContain('Agent (Priya)');
    expect(chat.text).not.toContain('Sharma'); // only agent first name
    const e = resolveEvidence(chat.evidence, ' [m3] ');
    expect(e?.ref).toMatchObject({ message_seq: 3 });
    expect(resolveEvidence(chat.evidence, 'M99')).toBeNull();
  });

  it('call segments get S ids with start_ms', () => {
    const c = buildConversation({ channel: 'call', segments: [{ seq: 4, speaker: 'agent', start_ms: 51000, text: 'Namaste' }] });
    expect(c.text).toMatch(/^\[S4\] 00:51 Agent: Namaste/);
    expect(c.evidence.get('S4')?.ref).toEqual({ segment_seq: 4, start_ms: 51000 });
  });
});

describe('postProcessAnalysis', () => {
  const raw = baseOutput({
    flags: [
      { rule_code: 'unauthorized_refund_promise', evidence_id: 'M3', reason: 'Promised refund today', criterion_code: 'refund_replacement', policy_slug: 'refund-policy', confidence: 0.9, recommended_correction: 'Do not promise' },
      { rule_code: 'unauthorized_refund_promise', evidence_id: 'M42', reason: 'bad evidence', criterion_code: '', policy_slug: '', confidence: 0.9, recommended_correction: '' },
      { rule_code: 'made_up_rule', evidence_id: 'M3', reason: 'x', criterion_code: '', policy_slug: '', confidence: 0.9, recommended_correction: '' },
      { rule_code: 'excessive_delay', evidence_id: 'M0', reason: 'model must not raise SLA flags', criterion_code: '', policy_slug: '', confidence: 0.9, recommended_correction: '' },
      { rule_code: 'clarity_empathy', evidence_id: '', reason: 'no evidence', criterion_code: 'empathy', policy_slug: 'not-a-slug', confidence: 0.7, recommended_correction: '' },
    ],
    issue_labels: [
      { category_code: 'quality', subcategory_code: 'quality.ghee_leak', is_primary: false, product: 'A2 Desi Ghee', variant: '', customer_reason: 'leaking', agent_reason: '', severity: 'high', resolution_requested: 'Refund', resolution_provided: '', order_ref: '#RF102938', probable_root_cause: 'Possibly transit damage', confidence: 0.8, evidence_id: 'M0' },
      { category_code: 'refund', subcategory_code: 'delivery.delayed', is_primary: false, product: '', variant: '', customer_reason: '', agent_reason: '', severity: 'medium', resolution_requested: '', resolution_provided: '', order_ref: 'ORD-INVENTED', probable_root_cause: '', confidence: 0.6, evidence_id: 'M2' },
      { category_code: 'not_a_category', subcategory_code: '', is_primary: true, product: '', variant: '', customer_reason: '', agent_reason: '', severity: 'low', resolution_requested: '', resolution_provided: '', order_ref: '', probable_root_cause: '', confidence: 0.5, evidence_id: 'M0' },
    ],
    criterion_scores: [
      { code: 'greeting', applicable: true, score: 7, evidence_id: 'M1', rationale: '' },
      { code: 'refund_replacement', applicable: true, score: 1, evidence_id: 'M3', rationale: 'promise' },
      { code: 'escalation', applicable: false, score: 0, evidence_id: '', rationale: 'n/a' },
      { code: 'bogus', applicable: true, score: 5, evidence_id: '', rationale: '' },
    ],
  });
  const pp = postProcessAnalysis(raw, { vocab, evidence: chat.evidence, criteria, conversationText: chat.text, activeRuleCodes: new Set(rules.map((r) => r.code)) });

  it('drops flags whose evidence id does not resolve, unknown rules and model-raised SLA rules', () => {
    expect(pp.flags.map((f) => [f.rule_code, f.evidence_id])).toEqual([['unauthorized_refund_promise', 'M3']]);
    expect(pp.flags[0].evidence_ref).toMatchObject({ message_seq: 3 });
    expect(pp.flags[0].excerpt).toContain('guaranteed');
    expect(pp.dropped.flags).toBe(4);
  });

  it('enforces taxonomy, sub-category membership and literal order refs; one primary', () => {
    expect(pp.labels).toHaveLength(2);
    expect(pp.labels[0]).toMatchObject({ category_code: 'quality', subcategory_code: 'quality.ghee_leak', order_ref: '#RF102938', is_primary: true });
    expect(pp.labels[1]).toMatchObject({ category_code: 'refund', subcategory_code: null, order_ref: null, is_primary: false });
    expect(pp.dropped.labels).toBe(1);
  });

  it('normalises criterion scores: clamped, N/A for missing/inapplicable, unknown codes dropped', () => {
    const by = new Map(pp.criterionScores.map((c) => [c.code, c]));
    expect(by.get('greeting')).toMatchObject({ score: 5, na: false, evidence_id: 'M1' });
    expect(by.get('escalation')).toMatchObject({ na: true, score: null });
    expect(by.get('closure')).toMatchObject({ na: true }); // not returned → N/A
    expect(by.has('bogus')).toBe(false);
    expect(pp.criterionScores).toHaveLength(criteria.length);
  });

  it('computes the score server-side', () => {
    const s = scoreAnalysis(pp, criteria, DEFAULT_ORG_SETTINGS as any, 'chat');
    // communication: greeting 5 → 20/20; policy: refund 1 → 4/20; others N/A → (20+4)/(40)=60
    expect(s.overall).toBe(60);
    expect(s.band).toBe('Requires review');
  });

  it('merges deterministic SLA candidates with resolvable evidence only', () => {
    const p2 = postProcessAnalysis(baseOutput(), {
      vocab, evidence: chat.evidence, criteria, conversationText: chat.text,
      slaCandidates: [
        { rule_code: 'excessive_delay', evidence_id: 'M2', reason: 'late', confidence: 1, business_minutes: 40, sla_minutes: 15, awaiting: false },
        { rule_code: 'sla_unresolved', evidence_id: 'M77', reason: 'x', confidence: 1, business_minutes: 4000, sla_minutes: 2880, awaiting: true },
      ],
    });
    expect(p2.flags.map((f) => [f.rule_code, f.source, f.evidence_id])).toEqual([['excessive_delay', 'sla', 'M2']]);
  });

  it('rejects structurally invalid output', () => {
    expect(() => postProcessAnalysis({ summary: 1 }, { vocab, evidence: chat.evidence, criteria, conversationText: chat.text })).toThrow(ProviderError);
  });
});

describe('alert rule selection', () => {
  it('applies min confidence, channel and dedupe', () => {
    const f = { rule_code: 'unauthorized_refund_promise', reason: '', criterion_code: null, policy_slug: null, recommended_correction: null, excerpt: 'x', evidence_ref: { message_seq: 3 }, evidence_id: 'M3', source: 'ai' as const };
    const sel = selectFlags([{ ...f, confidence: 0.69 }, { ...f, confidence: 0.9 }, { ...f, confidence: 0.95 }], rules, 'chat');
    expect(sel).toHaveLength(1);
    expect(selectFlags([{ ...f, confidence: 0.9 }], rules, 'chat', new Set(['unauthorized_refund_promise|M3']))).toHaveLength(0);
    const emailOnly = rules.map((r) => ({ ...r, channels: ['email'] }));
    expect(selectFlags([{ ...f, confidence: 0.9 }], emailOnly, 'chat')).toHaveLength(0);
  });
});

// ───────────── SLA / business hours ─────────────
describe('business hours', () => {
  const satOnly = { days: [6], start: '09:30', end: '18:30' };
  const tz = 'Asia/Kolkata';
  it('Friday 18:00 IST customer message with Saturday-only hours: Sat 10:00 reply = 30 business minutes', () => {
    expect(businessMinutesBetween(IST('2026-10-09T18:00:00'), IST('2026-10-10T10:00:00'), satOnly, tz)).toBe(30);
  });
  it('…reply on Monday 10:00 = the full Saturday (540 min)', () => {
    expect(businessMinutesBetween(IST('2026-10-09T18:00:00'), IST('2026-10-12T10:00:00'), satOnly, tz)).toBe(540);
  });
  it('default Mon–Sat 09:30–18:30: Friday 18:00 → Saturday 10:00 = 60 min', () => {
    expect(businessMinutesBetween(IST('2026-10-09T18:00:00'), IST('2026-10-10T10:00:00'), DEFAULT_ORG_SETTINGS.businessHours, tz)).toBe(60);
  });
  it('overnight outside hours = 0', () => {
    expect(businessMinutesBetween(IST('2026-10-09T19:00:00'), IST('2026-10-10T09:00:00'), DEFAULT_ORG_SETTINGS.businessHours, tz)).toBe(0);
  });
  it('works in a DST time zone', () => {
    // London switches from BST to GMT on 2026-10-25; Mon 26 Oct 09:00–17:00 local = 8h
    expect(businessMinutesBetween(new Date('2026-10-26T08:00:00Z'), new Date('2026-10-26T18:00:00Z'), { days: [1], start: '09:00', end: '17:00' }, 'Europe/London')).toBe(480);
  });
});

describe('computeSlaCandidates', () => {
  const settings = { ...DEFAULT_ORG_SETTINGS, businessHours: { days: [6], start: '09:30', end: '18:30' } } as any;
  const msgs = (agentAt: string | null) => [
    { seq: 0, sender_type: 'customer', sent_at: IST('2026-10-09T18:00:00') },
    { seq: 1, sender_type: 'bot', sent_at: IST('2026-10-09T18:00:05') }, // auto-reply does not count
    ...(agentAt ? [{ seq: 2, sender_type: 'agent', sent_at: IST(agentAt) }] : []),
  ];
  it('reply within SLA in business time → no flag even though wall-clock gap is 16 h', () => {
    expect(computeSlaCandidates(msgs('2026-10-10T09:40:00'), 'chat', settings).candidates).toEqual([]);
  });
  it('reply after SLA in business time → excessive_delay on the waiting customer message', () => {
    const r = computeSlaCandidates(msgs('2026-10-10T10:30:00'), 'chat', settings);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ rule_code: 'excessive_delay', evidence_id: 'M0', business_minutes: 60, awaiting: false });
  });
  it('unanswered but still within SLA (outside business hours) → not flagged', () => {
    expect(computeSlaCandidates(msgs(null), 'chat', settings, { now: IST('2026-10-10T09:00:00') }).candidates).toEqual([]);
  });
  it('unanswered beyond resolution SLA in business time → sla_unresolved', () => {
    const r = computeSlaCandidates(msgs(null), 'chat', settings, { now: IST('2026-10-24T12:00:00') }); // 2 Saturdays = 1080 min + 150… > 48h? no
    // 48h resolution = 2880 business minutes = 5.33 Saturdays; so only excessive_delay here
    expect(r.candidates.map((c) => c.rule_code)).toEqual(['excessive_delay']);
    const r2 = computeSlaCandidates(msgs(null), 'chat', settings, { now: IST('2026-11-28T12:00:00') });
    expect(r2.candidates.map((c) => c.rule_code)).toEqual(['sla_unresolved']);
  });
  it('resolved conversations are never flagged for awaiting replies', () => {
    expect(computeSlaCandidates(msgs(null), 'chat', settings, { now: IST('2026-11-28T12:00:00'), resolved: true }).candidates).toEqual([]);
  });
});

// ───────────── heuristic analyzer ─────────────
describe('heuristic analyzer', () => {
  it('produces output that validates against the zod schema and links flags to evidence', () => {
    const out = heuristicAnalysis({
      channel: 'chat', evidence: chat.evidence, taxonomySubs: new Set(vocab.subcategoryCodes), taxonomyCats: new Set(vocab.categoryCodes),
      criteria, ruleCodes: new Set(vocab.ruleCodes),
    });
    const parsed = analysisSchema.safeParse(out);
    expect(parsed.success).toBe(true);
    expect(out.confidence).toBeLessThan(0.6);
    expect(out.summary).toMatch(/Heuristic/);
    expect(out.issue_labels[0].subcategory_code).toBe('quality.ghee_leak');
    const pp = postProcessAnalysis(out, { vocab, evidence: chat.evidence, criteria, conversationText: chat.text, source: 'heuristic' });
    expect(pp.flags.some((f) => f.rule_code === 'unauthorized_refund_promise' && f.evidence_id === 'M3')).toBe(true);
    expect(pp.labels[0].order_ref).toBe('RF102938');
  });
});

// ───────────── Claude request building ─────────────
describe('Anthropic client', () => {
  const cfg = { apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5', maxTokens: 4000, timeoutMs: 5000 };
  it('builds a Messages API request with auto tool choice and strict tool', () => {
    const r = buildMessagesRequest(cfg, { system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', input_schema: { type: 'object' }, strict: true }] });
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers).toEqual({ 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(r.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4000, system: 'sys', tool_choice: { type: 'auto' } });
    expect((r.body.tools as any[])[0]).toEqual({ name: 't', description: 'd', input_schema: { type: 'object' }, strict: true });
  });

  it('builds the analysis request: strict schema with taxonomy/rule enums, SLA rules excluded', () => {
    const ctx = {
      interaction: { id: 'i', org_id: 'o', ref: 'RSI-1', channel: 'chat', direction: 'inbound', source_platform: 'limechat', occurred_at: new Date('2026-10-09T05:30:00Z'), subject: null, is_demo: false, agent_id: null, team_id: null, resolution_status: 'open', product: null },
      settings: DEFAULT_ORG_SETTINGS, conversation: chat, kb, criteria, rules, categories, slaCandidates: [], hasUnknownSpeakers: false,
    } as unknown as AnalysisContext;
    const req = buildClaudeAnalysisRequest(ctx);
    const body = buildMessagesRequest(cfg, { system: req.system, messages: req.messages, tools: [req.tool] }).body as any;
    const schema = body.tools[0].input_schema;
    expect(body.tools[0].strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('flags');
    const ruleEnum = schema.properties.flags.items.properties.rule_code.enum as string[];
    expect(ruleEnum).toContain('unauthorized_refund_promise');
    expect(ruleEnum).not.toContain('excessive_delay');
    expect(ruleEnum).not.toContain('repeated_critical_failures');
    expect(schema.properties.issue_labels.items.properties.category_code.enum).toContain('quality');
    expect(JSON.stringify(schema)).not.toMatch(/"minimum"|"maximum"|"minLength"/);
    expect(req.messages[0].content).toContain('[M3]');
    expect(req.messages[0].content).toContain('refund-policy');
  });

  it('maps errors: 429/529 retryable with retry-after; 401 not retryable; key redacted', () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    const e429 = mapAnthropicError(429, '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', h({ 'retry-after': '12' }));
    expect(e429.retryable).toBe(true);
    expect(e429.retryAfterMs).toBe(12000);
    expect(mapAnthropicError(529, '{}', h({})).retryable).toBe(true);
    const e401 = mapAnthropicError(401, '{"error":{"message":"bad key sk-ant-abc123"}}', h({}));
    expect(e401.retryable).toBe(false);
    expect(mapAnthropicError(400, '{"error":{"message":"key sk-ant-abc123 invalid"}}', h({})).message).not.toContain('sk-ant-abc123');
  });

  it('extracts tool input or falls back to JSON text', () => {
    expect(extractToolInput({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'submit_analysis', input: { a: 1 } }] }, 'submit_analysis')).toEqual({ a: 1 });
    expect(extractToolInput({ stopReason: 'end_turn', content: [{ type: 'text', text: 'Here:\n```json\n{"a":2}\n```' }] }, 'submit_analysis')).toEqual({ a: 2 });
    expect(() => extractToolInput({ stopReason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] }, 'submit_analysis')).toThrow(/max_tokens/);
  });

  it('retries once without strict when the schema is too complex; captures usage', async () => {
    const calls: any[] = [];
    const fake = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.tools[0].strict) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } }), { status: 400 });
      return new Response(JSON.stringify({ id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'submit_analysis', input: { ok: true } }], usage: { input_tokens: 1200, output_tokens: 340 } }), { status: 200, headers: { 'request-id': 'req_1' } });
    }) as typeof fetch;
    const r = await callClaudeTool(cfg, { system: 's', messages: [{ role: 'user', content: 'x' }], tool: { name: 'submit_analysis', description: 'd', input_schema: { type: 'object' } } }, fake);
    expect(calls).toHaveLength(2);
    expect(r.strict).toBe(false);
    expect(r.input).toEqual({ ok: true });
    expect(r.resp.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
    expect(r.resp.requestId).toBe('req_1');
  });

  it('network failure becomes a clean retryable ProviderError', async () => {
    const boom = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch;
    await expect(callClaudeTool(cfg, { messages: [{ role: 'user', content: 'x' }], tool: { name: 't', description: 'd', input_schema: {} } }, boom))
      .rejects.toMatchObject({ retryable: true, message: expect.stringContaining('ENOTFOUND') });
  });
});

// ───────────── Sarvam mapping ─────────────
describe('Sarvam output mapping & speakers', () => {
  it('maps diarized batch output', () => {
    const m = mapSarvamOutput({ transcript: 'a b', language_code: 'hi-IN', diarized_transcript: { entries: [
      { transcript: 'Namaste, Rosier Foods se Neha bol rahi hoon', start_time_seconds: 0.5, end_time_seconds: 3.2, speaker_id: '0' },
      { transcript: 'Mera ghee leak ho gaya', start_time_seconds: 3.4, end_time_seconds: 5, speaker_id: '1' }] } });
    expect(m.diarized).toBe(true);
    expect(m.segments[0]).toEqual({ speakerId: '0', startMs: 500, endMs: 3200, text: 'Namaste, Rosier Foods se Neha bol rahi hoon' });
    expect(mapSpeakers(m.segments).speakers).toEqual(['agent', 'customer']);
  });
  it('maps REST timestamps (phrase chunks) and leaves speakers unknown without a greeting', () => {
    const m = mapSarvamOutput({ transcript: 'x', timestamps: { words: ['hello?', 'haan ji'], start_time_seconds: [0, 1.5], end_time_seconds: [1, 2] } });
    expect(m.diarized).toBe(false);
    expect(m.segments.map((s) => s.startMs)).toEqual([0, 1500]);
    expect(mapSpeakers([{ speakerId: '0', startMs: 0, endMs: 1, text: 'hello?' }, { speakerId: '1', startMs: 1, endMs: 2, text: 'haan' }]).speakers).toEqual(['unknown', 'unknown']);
  });
  it('chooses batch for long or unknown-duration audio', () => {
    const cfg = sarvamConfigFrom({}, { apiKey: 'k' });
    expect(chooseSttMode(cfg, 600)).toBe('batch');
    expect(chooseSttMode(cfg, null)).toBe('batch');
    expect(chooseSttMode(cfg, 12)).toBe('sync');
  });
});
