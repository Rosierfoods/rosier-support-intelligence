/**
 * Builds the analysable conversation text with stable evidence ids and resolves ids back to excerpts.
 *   [S<seq>] call transcript segment   → evidence_ref {segment_seq, start_ms}
 *   [M<seq>] chat / WhatsApp message   → evidence_ref {message_seq, sent_at, message_external_id}
 *   [E<seq>] email in a thread         → evidence_ref {email_seq, sent_at}
 * Pure functions — unit-tested in tests/analysis.test.ts.
 */
import { formatInTimeZone } from '@/lib/tz';

export interface SegmentIn { seq: number; speaker: string; start_ms: number; end_ms?: number; text: string; text_en?: string | null }
export interface MessageIn { seq: number; sender_type: string; sender_name?: string | null; body: string; sent_at: Date | string; external_message_id?: string | null }
export interface EmailIn { seq: number; sender_type: string; subject?: string | null; sent_at: Date | string; body_text: string; external_message_id?: string | null }

export interface EvidenceItem { id: string; excerpt: string; ref: Record<string, unknown>; speaker: string; at?: string }
export interface BuiltConversation { text: string; evidence: Map<string, EvidenceItem>; truncated: boolean; unknownSpeakers: boolean }

export function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const SPEAKER_LABEL: Record<string, string> = { agent: 'Agent', customer: 'Customer', bot: 'Bot', system: 'System', unknown: 'Unknown speaker' };

function stamp(d: Date | string, tz: string) {
  return formatInTimeZone(new Date(d), tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
}

/** Strip quoted replies / signatures from an email body to keep prompts focused. */
export function cleanEmailBody(body: string) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .{5,120} wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From: .+@.+/.test(l) && out.length > 3) break;
    if (l.startsWith('>')) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildConversation(
  input: { channel: string; segments?: SegmentIn[]; messages?: MessageIn[]; emails?: EmailIn[] },
  opts: { tz?: string; maxChars?: number } = {},
): BuiltConversation {
  const tz = opts.tz ?? 'Asia/Kolkata';
  const maxChars = opts.maxChars ?? 160_000;
  const evidence = new Map<string, EvidenceItem>();
  const lines: string[] = [];
  let unknownSpeakers = false;

  if (input.channel === 'call') {
    for (const s of [...(input.segments ?? [])].sort((a, b) => a.seq - b.seq)) {
      const id = `S${s.seq}`;
      if (s.speaker === 'unknown') unknownSpeakers = true;
      evidence.set(id, { id, excerpt: s.text, ref: { segment_seq: s.seq, start_ms: s.start_ms }, speaker: s.speaker });
      lines.push(`[${id}] ${mmss(s.start_ms)} ${SPEAKER_LABEL[s.speaker] ?? s.speaker}: ${s.text}${s.text_en ? `\n      (EN: ${s.text_en})` : ''}`);
    }
  } else if (input.channel === 'email') {
    for (const e of [...(input.emails ?? [])].sort((a, b) => a.seq - b.seq)) {
      const id = `E${e.seq}`;
      const body = cleanEmailBody(e.body_text).slice(0, 6000);
      const at = new Date(e.sent_at).toISOString();
      evidence.set(id, { id, excerpt: body.slice(0, 1500), ref: { email_seq: e.seq, sent_at: at }, speaker: e.sender_type, at });
      lines.push(`[${id}] ${stamp(e.sent_at, tz)} ${SPEAKER_LABEL[e.sender_type] ?? e.sender_type}${e.subject ? ` — Subject: ${e.subject}` : ''}\n${body}\n`);
    }
  } else {
    for (const m of [...(input.messages ?? [])].sort((a, b) => a.seq - b.seq)) {
      const id = `M${m.seq}`;
      const at = new Date(m.sent_at).toISOString();
      const ref: Record<string, unknown> = { message_seq: m.seq, sent_at: at };
      if (m.external_message_id) ref.message_external_id = m.external_message_id;
      evidence.set(id, { id, excerpt: m.body.slice(0, 1500), ref, speaker: m.sender_type, at });
      // Agent first names help the model; customer names are omitted to minimise personal data sent to the AI provider.
      const who = m.sender_type === 'agent' && m.sender_name ? `Agent (${m.sender_name.split(' ')[0]})` : SPEAKER_LABEL[m.sender_type] ?? m.sender_type;
      lines.push(`[${id}] ${stamp(m.sent_at, tz)} ${who}: ${m.body}`);
    }
  }

  let text = lines.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    // keep the beginning and the end (opening context + outcome)
    const head = text.slice(0, Math.floor(maxChars * 0.6));
    const tail = text.slice(text.length - Math.floor(maxChars * 0.4));
    text = `${head}\n…[middle of conversation omitted for length]…\n${tail}`;
    truncated = true;
  }
  return { text, evidence, truncated, unknownSpeakers };
}

/** Resolve a model-supplied evidence id ("S4", "[M3]", " e1 ") to an evidence item, or null. */
export function resolveEvidence(evidence: Map<string, EvidenceItem>, rawId: string | null | undefined): EvidenceItem | null {
  if (!rawId) return null;
  const id = rawId.trim().replace(/^\[|\]$/g, '').toUpperCase();
  return evidence.get(id) ?? null;
}

/** Stable key for de-duplicating flags on the same evidence. */
export function evidenceKey(ref: Record<string, unknown>): string {
  if (ref.segment_seq !== undefined) return `S${ref.segment_seq}`;
  if (ref.message_seq !== undefined) return `M${ref.message_seq}`;
  if (ref.email_seq !== undefined) return `E${ref.email_seq}`;
  return JSON.stringify(ref);
}
