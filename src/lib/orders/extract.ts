/**
 * Order numbers as customers actually say or type them: "#54105", "order RF-54105", "mera order number 5 4 1 0 5 hai",
 * "paanch chaar ek shunya paanch", "ऑर्डर नंबर ५४१०५". Pure helpers; unit-tested.
 */

const DEVANAGARI = '०१२३४५६७८९';

// Single spoken digits (English, Hinglish, Hindi in Devanagari). Only runs of these are turned into numbers.
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  shunya: '0', sunya: '0', shoonya: '0', ek: '1', do: '2', teen: '3', tin: '3', char: '4', chaar: '4', chār: '4',
  panch: '5', paanch: '5', pach: '5', chhe: '6', che: '6', chhah: '6', chah: '6', saat: '7', sat: '7', aath: '8', ath: '8', nau: '9', no: '9',
  'शून्य': '0', 'ज़ीरो': '0', 'जीरो': '0', 'एक': '1', 'दो': '2', 'तीन': '3', 'चार': '4', 'पांच': '5', 'पाँच': '5', 'छह': '6', 'छः': '6', 'छे': '6',
  'सात': '7', 'आठ': '8', 'नौ': '9',
};
// Words that are also ordinary Hinglish words — only treated as digits inside a run that already has real digit words.
const AMBIGUOUS = new Set(['do', 'no', 'sat', 'oh', 'che', 'tin', 'ath']);

const KEYWORDS = /(order|ordr|odr|aadar|ardar|ऑर्डर|आर्डर|ऑडर|ओर्डर|ऑर्डर नंबर|order\s*id|order\s*no|order\s*number|#)/i;

/** Devanagari / Arabic-Indic digits → ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[०-९]/g, (d) => String(DEVANAGARI.indexOf(d))).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Replace runs of ≥3 spoken digit words with the digits ("five four one" → "541"). */
export function spokenDigitsToNumbers(s: string): string {
  const tokens = s.split(/(\s+|[,.-]+)/);
  const out: string[] = [];
  let run: string[] = [];
  let realInRun = 0;
  const flush = () => {
    if (run.length >= 3 && realInRun >= 2) out.push(run.map((w) => DIGIT_WORDS[w.toLowerCase()]).join(''));
    else out.push(...run.flatMap((w, i) => (i ? [' ', w] : [w])));
    run = []; realInRun = 0;
  };
  for (const t of tokens) {
    if (/^(\s+|[,.-]+)$/.test(t) || t === '') { if (!run.length) out.push(t); continue; }
    const w = t.toLowerCase();
    if (DIGIT_WORDS[w] !== undefined) { run.push(t); if (!AMBIGUOUS.has(w)) realInRun++; continue; }
    if (run.length) { flush(); out.push(' '); }
    out.push(t);
  }
  if (run.length) flush();
  return out.join('');
}

/** Normalised text for matching: ASCII digits, spoken digits as numbers. */
export function normaliseForOrders(s: string): string {
  return spokenDigitsToNumbers(asciiDigits(s ?? ''));
}

/** Digits with the separators between them removed ("5 4 1-0 5" → "54105"); other characters kept as breaks. */
function digitStream(s: string): string {
  return normaliseForOrders(s).replace(/(\d)[\s,.\-/]+(?=\d)/g, '$1');
}

/**
 * Was this order number really mentioned? Literal match, or its digits (≥4) appear in the conversation once spoken digits,
 * Hindi digits and spacing are normalised. Stops the AI inventing order numbers.
 */
export function orderMentioned(order: string | null | undefined, conversationText: string): boolean {
  const o = (order ?? '').trim();
  if (!o) return false;
  if (conversationText.toLowerCase().includes(o.toLowerCase())) return true;
  const digits = asciiDigits(o).replace(/\D/g, '');
  if (digits.length < 4) return false;
  return digitStream(conversationText).includes(digits);
}

/** Order-number candidates near an "order" keyword (or written as #12345 / RF12345). Up to 5, most likely first. */
export function extractOrderCandidates(text: string, max = 5): string[] {
  const t = normaliseForOrders(text ?? '');
  const out: string[] = [];
  const push = (v: string) => { const c = v.toUpperCase(); if (!out.includes(c) && out.length < max) out.push(c); };
  // Written forms: #54105, #RF54105, RF-54105
  for (const m of t.matchAll(/#\s?([A-Za-z]{0,4}-?\d{4,9})\b/g)) push(m[1].replace(/-/g, ''));
  for (const m of t.matchAll(/\b([A-Za-z]{2,4})-?(\d{4,9})\b/g)) if (/^(rf|ros|rsr|ord|od)$/i.test(m[1])) push(`${m[1]}${m[2]}`);
  // After a keyword: take the next ~40 characters and read the first 4–9 digit number (spaces between digits allowed).
  const re = new RegExp(KEYWORDS.source, 'gi');
  for (const m of t.matchAll(re)) {
    const tail = t.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
    const joined = tail.replace(/(\d)[\s,.\-/]+(?=\d)/g, '$1');
    const n = joined.match(/(₹\s?)?\b([A-Za-z]{0,3})(\d{4,9})\b(\s*(rs\b|rupees|rupay|rupaye|₹|\/-|रुपये|रुपए))?/i);
    // Skip amounts ("1500 rupees", "₹1500") and repeated digits ("0000").
    if (n && !n[1] && !n[4] && !/^(\d)\1+$/.test(n[3])) push(`${n[2]}${n[3]}`);
  }
  // Ignore phone numbers (10 digits starting 6–9) and pin codes said near "order".
  return out.filter((c) => !/^[6-9]\d{9}$/.test(c) && !/^91[6-9]\d{9}$/.test(c));
}
