/**
 * Offline heuristic analyzer — used ONLY for demo interactions when no AI provider is connected, so the demo pipeline
 * runs end-to-end without API keys. Output is clearly labelled (provider 'heuristic', model 'demo-heuristic') and
 * low-confidence (→ 'requires_review'). Keyword rules over the configured taxonomy; never used for live data.
 */
import type { AnalysisOutput } from './schema';
import type { EvidenceItem } from './conversation';

export const HEURISTIC_PROVIDER = 'heuristic';
export const HEURISTIC_MODEL = 'demo-heuristic';
export const HEURISTIC_CONFIDENCE = 0.4;

// `ctx` (optional) must also match somewhere in the customer's text, e.g. ghee-specific subcategories need "ghee".
const KEYWORDS: { sub: string; re: RegExp; product?: string; ctx?: RegExp }[] = [
  { sub: 'quality.ghee_leak', re: /\b(leak|leaking|leaked|tapak|reesa|ris raha|oily box)\b/i, product: 'A2 Desi Ghee', ctx: /\b(ghee|jar)\b/i },
  { sub: 'quality.ghee_broken', re: /\b(broken|cracked|crack|toota|tooti|tut gaya)\b.*\b(jar|bottle)\b|\b(jar|bottle)\b.*\b(broken|cracked|toota|tooti)\b/i, ctx: /\bghee\b/i },
  { sub: 'quality.ghee_smell_taste', re: /\b(smell|taste|badbu|swad|rancid|kadwa|bitter)\b/i, ctx: /\bghee\b/i },
  { sub: 'quality.ghee_texture', re: /\b(texture|grainy|danedar|consistency|solid|liquid)\b/i, ctx: /\bghee\b/i },
  { sub: 'quality.oil_leak', re: /\boil\b.*\b(leak|spill)/i, product: 'Cold Pressed Mustard Oil' },
  { sub: 'quality.honey_quality', re: /\bhoney\b.*\b(crystal|jam gaya|fake|sugar|adulter)/i, product: 'Wild Forest Honey' },
  { sub: 'quality.atta_quality', re: /\batta\b.*\b(insect|keede|smell|stale|lumps)/i, product: 'Khapli Atta' },
  { sub: 'quality.pickle_quality', re: /\b(pickle|achaar|achar)\b.*\b(fungus|mould|mold|spoil|kharab)/i },
  { sub: 'quality.packaging_damage', re: /\b(packaging|package|box|parcel)\b.*\b(damage|damaged|torn|crushed|phata)/i },
  { sub: 'replacement.requested', re: /\b(replace|replacement|exchange|badal|naya bhej)/i },
  { sub: 'replacement.wrong_product', re: /\b(wrong (item|product)|galat (item|product|saman))\b/i },
  { sub: 'replacement.missing_item', re: /\b(missing|not in the box|item missing)\b/i },
  { sub: 'replacement.expired', re: /\b(expired|expiry|near expiry)\b/i },
  { sub: 'refund.delayed', re: /\brefund\b.*\b(not (yet )?(received|credited)|delay|kab aayega|still waiting|nahi aaya|abhi tak)/i },
  { sub: 'refund.requested', re: /\b(refund|money back|paise wapas|paisa wapas)\b/i },
  { sub: 'delivery.delayed', re: /\b(order|delivery|parcel|package|shipment)\b.*\b(delay|delayed|late|not (yet )?delivered|kab aayega|abhi tak nahi)\b/i },
  { sub: 'delivery.status', re: /\b(track|tracking|where is my order|order status|kahan hai)\b/i },
  { sub: 'order_payment.payment_failed', re: /\b(payment (failed|deducted)|paise kat gaye|amount deducted)\b/i },
  { sub: 'order_payment.cancellation', re: /\b(cancel|cancellation)\b/i },
  { sub: 'order_payment.invoice', re: /\b(invoice|bill|gst)\b/i },
  { sub: 'product_info.shelf_life', re: /\b(shelf life|best before|kitne din)\b/i },
  { sub: 'product_info.usage', re: /\b(how to use|kaise use|recipe)\b/i },
  { sub: 'website_cx.coupon', re: /\b(coupon|promo code|discount code)\b/i },
  { sub: 'other.appreciation', re: /\b(thank you so much|great product|love (the|your)|bahut accha)\b/i },
];

const PRODUCT_RE: [RegExp, string][] = [
  [/\bA2\b|\bbilona\b/i, 'A2 Desi Ghee'], [/\bcow ghee\b/i, 'Cow Ghee'], [/\bghee\b/i, 'A2 Desi Ghee'], [/\bhoney\b|\bshahad\b/i, 'Wild Forest Honey'],
  [/\bkhapli\b|\batta\b/i, 'Khapli Atta'], [/\bmustard oil\b|\bsarson\b/i, 'Cold Pressed Mustard Oil'], [/\bgroundnut oil\b/i, 'Cold Pressed Groundnut Oil'],
  [/\bmango pickle\b|\baam ka achaar\b/i, 'Mango Pickle'], [/\bpickle\b|\bachaar\b/i, 'Mixed Pickle'], [/\boats\b/i, 'High Protein Oats'],
  [/\bpeanut butter\b/i, 'Peanut Butter'], [/\bprotein bar\b/i, 'Protein Bar'], [/\bamlaprash\b/i, 'Amlaprash'], [/\bpaneer\b/i, 'Paneer'],
];

const NEG = /\b(angry|frustrat|worst|disappoint|pathetic|useless|bakwas|ghatiya|third time|again and again|still not|complaint|consumer forum|bekaar)\b/i;
const POS = /\b(thank you|thanks|great|perfect|happy|dhanyavaad|shukriya|resolved|awesome)\b/i;
const GREET = /\b(namaste|namaskar|hello|hi|good (morning|afternoon|evening)|welcome|thank you for (calling|contacting|reaching)|rosier)\b/i;
const EMPATHY = /\b(sorry|apologi[sz]e|understand|inconvenience|maafi|maaf|samajh sakta|samajh sakti)\b/i;
const CLOSE = /\b(anything else|kuch aur|have a (good|great|nice) day|thank you for|dhanyavaad|take care)\b/i;
const NEXT = /\b(within|by (today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday)|\d+\s*(hours|hrs|days|working days|ghante|din)|reference|ticket|we will|I will|we'll|I'll)\b/i;
const SENSITIVE_ASK = /\b(otp|cvv|card number|upi pin|password|pin number|expiry date)\b/i;
const REFUND_PROMISE = /\b(refund|cashback|compensation|paise)\b.*\b(today|aaj|right now|guarantee|definitely|pakka|immediately|turant)\b/i;
const RUDE = /\b(not my problem|calm down|you people|aap log|your fault|read the (policy|website)|we can'?t do anything)\b/i;
const ORDER_RE = /\b(?:order\s*(?:id|no\.?|number)?\s*[:#]?\s*)(#?[A-Z]{0,4}\d{4,12})\b/i;

export function heuristicAnalysis(input: {
  channel: string;
  evidence: Map<string, EvidenceItem>;
  taxonomySubs: Set<string>;   // active full sub codes
  taxonomyCats: Set<string>;   // active category codes
  criteria: { code: string }[];
  ruleCodes: Set<string>;
}): AnalysisOutput {
  const items = Array.from(input.evidence.values());
  const cust = items.filter((e) => e.speaker === 'customer' || e.speaker === 'unknown');
  const agent = items.filter((e) => e.speaker === 'agent');
  const custText = cust.map((e) => e.excerpt).join('\n');
  const allText = items.map((e) => e.excerpt).join('\n');

  // ── products
  const products = Array.from(new Set(PRODUCT_RE.filter(([re]) => re.test(allText)).map(([, p]) => p))).slice(0, 3);

  // ── labels
  const hits: { sub: string; ev: EvidenceItem; product?: string }[] = [];
  for (const k of KEYWORDS) {
    if (!input.taxonomySubs.has(k.sub)) continue;
    if (k.ctx && !k.ctx.test(custText)) continue;
    const ev = cust.find((e) => k.re.test(e.excerpt));
    if (ev && !hits.some((h) => h.sub === k.sub)) hits.push({ sub: k.sub, ev, product: k.product });
  }
  if (!hits.length && input.taxonomySubs.has('other.unclassified') && cust[0]) hits.push({ sub: 'other.unclassified', ev: cust[0] });
  const orderRef = (allText.match(ORDER_RE)?.[1] ?? '').slice(0, 40);
  const negative = NEG.test(custText);
  const positive = POS.test(cust.slice(-2).map((e) => e.excerpt).join(' '));
  const issue_labels = hits.slice(0, 4).filter((h) => input.taxonomyCats.has(h.sub.split('.')[0])).map((h, i) => ({
    category_code: h.sub.split('.')[0],
    subcategory_code: h.sub,
    is_primary: i === 0,
    product: h.product ?? products[0] ?? '',
    variant: '',
    customer_reason: h.ev.excerpt.slice(0, 200),
    agent_reason: '',
    severity: (h.sub.startsWith('quality.') || negative ? 'high' : 'medium') as 'high' | 'medium',
    resolution_requested: /replace/i.test(custText) ? 'Replacement' : /refund/i.test(custText) ? 'Refund' : '',
    resolution_provided: '',
    order_ref: orderRef,
    probable_root_cause: '',
    confidence: 0.45,
    evidence_id: h.ev.id,
  }));

  // ── criteria
  const firstAgent = agent[0];
  const lastAgent = agent[agent.length - 1];
  const greeted = !!firstAgent && GREET.test(firstAgent.excerpt);
  const empathetic = agent.some((e) => EMPATHY.test(e.excerpt));
  const closed = !!lastAgent && CLOSE.test(lastAgent.excerpt);
  const nextSteps = agent.some((e) => NEXT.test(e.excerpt));
  const sensitive = agent.find((e) => SENSITIVE_ASK.test(e.excerpt));
  const promise = agent.find((e) => REFUND_PROMISE.test(e.excerpt));
  const rude = agent.find((e) => RUDE.test(e.excerpt));
  const refundish = issue_labels.some((l) => l.category_code === 'refund' || l.category_code === 'replacement');
  const scoreFor = (code: string): { applicable: boolean; score: number; evidence_id: string; rationale: string } => {
    const ev = (e?: EvidenceItem) => e?.id ?? '';
    switch (code) {
      case 'greeting': return firstAgent ? { applicable: true, score: greeted ? 4 : 2, evidence_id: ev(firstAgent), rationale: greeted ? 'Greeting detected in the first agent turn.' : 'No greeting phrase detected in the first agent turn.' } : na();
      case 'empathy': return agent.length ? { applicable: true, score: rude ? 1 : empathetic ? 4 : 2, evidence_id: ev(rude ?? agent.find((e) => EMPATHY.test(e.excerpt)) ?? firstAgent), rationale: rude ? 'Possibly dismissive phrasing detected.' : empathetic ? 'Apology / acknowledgement detected.' : 'No acknowledgement phrase detected.' } : na();
      case 'next_steps': return agent.length ? { applicable: true, score: nextSteps ? 4 : 2, evidence_id: ev(agent.find((e) => NEXT.test(e.excerpt)) ?? lastAgent), rationale: nextSteps ? 'A timeline or follow-up was mentioned.' : 'No timeline or owner for next steps detected.' } : na();
      case 'closure': return lastAgent ? { applicable: true, score: closed ? 4 : 2, evidence_id: ev(lastAgent), rationale: closed ? 'Closing phrase detected.' : 'No closing phrase detected.' } : na();
      case 'privacy': return agent.length ? { applicable: true, score: sensitive ? 0 : 5, evidence_id: ev(sensitive), rationale: sensitive ? 'Agent appears to ask for sensitive data (OTP/CVV/PIN).' : 'No request for sensitive data detected.' } : na();
      case 'refund_replacement': return refundish ? { applicable: true, score: promise ? 1 : 3, evidence_id: ev(promise ?? agent[0]), rationale: promise ? 'Possible unapproved refund commitment.' : 'Keyword heuristic cannot verify policy compliance.' } : na();
      case 'escalation': return na();
      default: return agent.length ? { applicable: true, score: 3, evidence_id: '', rationale: 'Heuristic default — needs human or AI review.' } : na();
    }
  };
  const criterion_scores = input.criteria.map((c) => ({ code: c.code, ...scoreFor(c.code) }));

  // ── flags (only rules that exist & are active)
  const flags: AnalysisOutput['flags'] = [];
  const add = (rule: string, e: EvidenceItem | undefined, reason: string, criterion: string, confidence: number, fix: string, policy = '') => {
    if (e && input.ruleCodes.has(rule)) flags.push({ rule_code: rule, evidence_id: e.id, reason, criterion_code: criterion, policy_slug: policy, confidence, recommended_correction: fix });
  };
  add('sensitive_data_exposure', sensitive, 'Keyword match: the agent message appears to request OTP / card / PIN details.', 'privacy', 0.75,
    'Never ask for OTP, CVV, card number, UPI PIN or passwords. Use the UTR / transaction id for payment issues.', 'privacy-data-handling');
  add('unauthorized_refund_promise', promise, 'Keyword match: the agent may have committed to a refund/compensation timeline.', 'refund_replacement', 0.62,
    'Explain that refunds are processed after verification and approval, and share the approved timeline only.', 'refund-policy');
  add('unprofessional_behavior', rude, 'Keyword match: possibly dismissive phrasing.', 'empathy', 0.6, 'Acknowledge the issue and take ownership of the next step.', 'communication-standards');
  if (firstAgent && !greeted) add('greeting_closing', firstAgent, 'No greeting or introduction detected in the first agent reply.', 'greeting', 0.62,
    'Greet the customer and introduce yourself and Rosier Foods.', 'communication-standards');

  const sentiment = negative && positive ? 'mixed' : negative ? 'negative' : positive ? 'positive' : 'neutral';
  const primary = issue_labels[0];
  const questions = cust.filter((e) => e.excerpt.includes('?')).slice(0, 4).map((e) => ({ question: e.excerpt.slice(0, 300), agent_answer: '', answered: false, evidence_id: e.id }));
  const hindi = /[ऀ-ॿ]/.test(allText) || /\b(hai|nahi|kya|aap|mera|kab|kaise|bhai|ji)\b/i.test(allText);

  return {
    summary: `[Heuristic demo analysis — keyword based, not AI] ${primary ? `Customer contact about ${primary.subcategory_code.replace('.', ' → ').replace(/_/g, ' ')}` : 'Customer contact'}${products.length ? ` (${products.join(', ')})` : ''}. ${agent.length} agent ${input.channel === 'call' ? 'turns' : 'replies'}, ${cust.length} customer ${input.channel === 'call' ? 'turns' : 'messages'}. Connect Claude for a real analysis.`,
    customer_intent: primary ? primary.subcategory_code.split('.')[1].replace(/_/g, ' ') : 'unclear',
    language: hindi ? 'hi-en' : 'en',
    sentiment,
    products,
    customer_questions: questions,
    concerns: issue_labels.map((l) => l.customer_reason).slice(0, 4),
    requested_actions: primary?.resolution_requested ? [primary.resolution_requested] : [],
    speaker_labels: [],
    resolution_status_suggestion: positive && !negative ? 'resolved' : 'pending',
    issue_labels,
    criterion_scores,
    positives: [greeted && firstAgent ? { text: 'Greeted the customer.', evidence_id: firstAgent.id } : null, empathetic ? { text: 'Acknowledged the inconvenience.', evidence_id: agent.find((e) => EMPATHY.test(e.excerpt))!.id } : null].filter(Boolean) as AnalysisOutput['positives'],
    missed_opportunities: [!nextSteps && lastAgent ? { text: 'No clear next step or timeline detected.', evidence_id: lastAgent.id } : null].filter(Boolean) as AnalysisOutput['missed_opportunities'],
    incorrect_statements: [],
    policy_violations: [],
    frustration_indicators: negative ? cust.filter((e) => NEG.test(e.excerpt)).slice(0, 3).map((e) => ({ text: e.excerpt.slice(0, 200), evidence_id: e.id })) : [],
    improved_response: '',
    confidence: HEURISTIC_CONFIDENCE,
    policy_uncertain: true,
    policy_uncertainty_note: 'Heuristic demo analyzer cannot check policy compliance. Connect Claude on the Integrations page for an evidence-based evaluation.',
    flags,
    translation_en: '',
  };

  function na() { return { applicable: false, score: 0, evidence_id: '', rationale: 'Not applicable (heuristic).' }; }
}
