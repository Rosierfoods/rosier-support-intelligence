import 'server-only';
import type { Db } from '@/lib/db';
import { SqlBuilder, escapeLike } from '@/lib/sql';
import type { Session } from '@/lib/auth/session';
import { scopeInteractions } from './scope';
import { parseRange, sp, type DateRange, type SP } from '@/lib/filters';
import { CHANNELS, type Channel } from '@/lib/constants';

/** Highlight markers returned by ts_headline; the UI splits on these (never rendered as HTML). */
export const HL_START = '\u0001';
export const HL_STOP = '\u0002';
const HEADLINE_OPTS = `StartSel=${HL_START}, StopSel=${HL_STOP}, MaxWords=28, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "`;

export interface SearchFilters { q: string; channel?: Channel; range: DateRange; belowThreshold: boolean; unresolved: boolean }

export function parseSearchFilters(searchParams: SP): SearchFilters {
  const ch = sp(searchParams, 'channel');
  return {
    q: (sp(searchParams, 'q') ?? '').trim().slice(0, 200),
    channel: (CHANNELS as readonly string[]).includes(ch ?? '') ? (ch as Channel) : undefined,
    range: parseRange(searchParams, 'all'),
    belowThreshold: sp(searchParams, 'below') === '1',
    unresolved: sp(searchParams, 'unresolved') === '1',
  };
}

function baseConds(s: Session, f: SearchFilters, b: SqlBuilder) {
  b.and(scopeInteractions(s, b, 'i'));
  b.and(`i.occurred_at >= ${b.p(f.range.from)} AND i.occurred_at <= ${b.p(f.range.to)}`);
  if (f.channel) b.and(`i.channel = ${b.p(f.channel)}`);
  if (f.belowThreshold) b.and(`i.quality_score < ${b.p(s.org.settings.reviewThreshold)}`);
  if (f.unresolved) b.and(`i.resolution_status IN ('open','pending','unresolved','escalated')`);
}

export interface InteractionHit {
  id: string; ref: string; channel: Channel; source_platform: string; source_record_id: string; occurred_at: string; is_demo: boolean;
  subject: string | null; agent_name: string | null; quality_score: string | null; resolution_status: string; sentiment: string | null;
  primary_issue: string | null; snippet: string | null; customer_match: string | null; rank: number;
}
export interface SegmentHit { interaction_id: string; ref: string; channel: Channel; is_demo: boolean; occurred_at: string; agent_name: string | null; seq: number; speaker: string; start_ms: number; snippet: string }
export interface MessageHit { interaction_id: string; ref: string; channel: Channel; is_demo: boolean; occurred_at: string; agent_name: string | null; seq: number; sender_type: string; sent_at: string; subject: string | null; snippet: string; kind: 'message' | 'email' }

export async function globalSearch(db: Db, s: Session, f: SearchFilters, limit = 25) {
  if (!f.q) return { interactions: [] as InteractionHit[], total: 0, segments: [] as SegmentHit[], messages: [] as MessageHit[] };
  const canPii = s.permissions.has('customer_pii.view');

  // ── interactions (full text over the indexed search_text; ILIKE fallback for partial words / IDs)
  const b = new SqlBuilder();
  baseConds(s, f, b);
  const tsq = b.p(f.q);
  const like = b.p(`%${escapeLike(f.q)}%`);
  const ors = [`i.search_tsv @@ websearch_to_tsquery('simple', ${tsq})`, `i.search_text ILIKE ${like}`];
  const digits = f.q.replace(/\D/g, '');
  if (canPii) {
    const idc = [`cu.email ILIKE ${like}`, `cu.name ILIKE ${like}`];
    if (digits.length >= 4) idc.push(`regexp_replace(coalesce(cu.phone, ''), '\\D', '', 'g') LIKE ${b.p(`%${digits}%`)}`);
    ors.push(`(${idc.join(' OR ')})`);
  }
  b.and(`(${ors.join(' OR ')})`);
  const from = `FROM interactions i LEFT JOIN customers cu ON cu.id = i.customer_id LEFT JOIN agents a ON a.id = i.agent_id`;
  const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n ${from} ${b.whereSql()}`, b.params);
  const rows = await db.query(
    `SELECT i.id, i.ref, i.channel, i.source_platform, i.source_record_id, i.occurred_at, i.is_demo, i.subject, a.name AS agent_name,
            i.quality_score, i.resolution_status, i.sentiment, cu.name AS cu_name, cu.phone AS cu_phone, cu.email AS cu_email,
            ts_rank(i.search_tsv, websearch_to_tsquery('simple', ${tsq})) AS rank,
            ts_headline('simple', left(i.search_text, 60000), websearch_to_tsquery('simple', ${tsq}), '${HEADLINE_OPTS}') AS snippet,
            substr(i.search_text, greatest(1, strpos(lower(i.search_text), lower(${tsq})) - 120), 320) AS raw_ctx,
            (SELECT c.name || coalesce(' › ' || sc.name, '') FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
               LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
              WHERE l.interaction_id = i.id AND l.is_active ORDER BY l.is_primary DESC, l.created_at LIMIT 1) AS primary_issue
       ${from} ${b.whereSql()}
      ORDER BY rank DESC, i.occurred_at DESC LIMIT ${Number(limit)}`,
    b.params,
  );
  const ql = f.q.toLowerCase();
  const interactions: InteractionHit[] = rows.map((r: any) => {
    let customer_match: string | null = null;
    if (canPii) {
      if (r.cu_email && String(r.cu_email).toLowerCase().includes(ql)) customer_match = r.cu_email;
      else if (digits.length >= 4 && r.cu_phone && String(r.cu_phone).replace(/\D/g, '').includes(digits)) customer_match = r.cu_phone;
      else if (r.cu_name && String(r.cu_name).toLowerCase().includes(ql)) customer_match = r.cu_name;
    }
    const { cu_name: _n, cu_phone: _p, cu_email: _e, raw_ctx, ...rest } = r;
    return { ...rest, customer_match, snippet: r.snippet?.includes(HL_START) ? r.snippet : fallbackSnippet(raw_ctx, f.q) };
  });

  // ── transcript segments
  const sb = new SqlBuilder();
  baseConds(s, f, sb);
  const stsq = sb.p(f.q);
  const slike = sb.p(`%${escapeLike(f.q)}%`);
  sb.and(`(to_tsvector('simple', ts.text) @@ websearch_to_tsquery('simple', ${stsq}) OR ts.text ILIKE ${slike} OR coalesce(ts.text_en, '') ILIKE ${slike})`);
  const segments = await db.query<SegmentHit & { raw: string }>(
    `SELECT * FROM (SELECT i.id AS interaction_id, i.ref, i.channel, i.is_demo, i.occurred_at, a.name AS agent_name, ts.seq, ts.speaker, ts.start_ms, ts.text AS raw,
            ts_rank(to_tsvector('simple', ts.text), websearch_to_tsquery('simple', ${stsq})) AS rank,
            row_number() OVER (PARTITION BY i.id ORDER BY ts_rank(to_tsvector('simple', ts.text), websearch_to_tsquery('simple', ${stsq})) DESC, ts.seq) AS rn,
            ts_headline('simple', ts.text, websearch_to_tsquery('simple', ${stsq}), '${HEADLINE_OPTS}') AS snippet
       FROM transcript_segments ts
       JOIN call_transcripts t ON t.id = ts.transcript_id AND t.is_current
       JOIN interactions i ON i.id = ts.interaction_id
       LEFT JOIN agents a ON a.id = i.agent_id
       ${sb.whereSql()}) x
      WHERE rn <= 3 ORDER BY rank DESC, occurred_at DESC, seq LIMIT 20`,
    sb.params,
  );

  // ── chat / WhatsApp messages and email messages
  const mb = new SqlBuilder();
  baseConds(s, f, mb);
  const mtsq = mb.p(f.q);
  const mlike = mb.p(`%${escapeLike(f.q)}%`);
  const where = mb.whereSql();
  const messages = await db.query<MessageHit & { raw: string }>(
    `SELECT * FROM (SELECT x0.*, row_number() OVER (PARTITION BY kind, interaction_id ORDER BY rank DESC, seq) AS rn FROM (
       SELECT i.id AS interaction_id, i.ref, i.channel, i.is_demo, i.occurred_at, a.name AS agent_name, m.seq, m.sender_type, m.sent_at,
              NULL::text AS subject, 'message' AS kind, m.body AS raw,
              ts_headline('simple', m.body, websearch_to_tsquery('simple', ${mtsq}), '${HEADLINE_OPTS}') AS snippet,
              ts_rank(to_tsvector('simple', m.body), websearch_to_tsquery('simple', ${mtsq})) AS rank
         FROM conversation_messages m JOIN interactions i ON i.id = m.interaction_id LEFT JOIN agents a ON a.id = i.agent_id
         ${where} AND (to_tsvector('simple', m.body) @@ websearch_to_tsquery('simple', ${mtsq}) OR m.body ILIKE ${mlike})
       UNION ALL
       SELECT i.id, i.ref, i.channel, i.is_demo, i.occurred_at, a.name, e.seq, e.sender_type, e.sent_at, e.subject, 'email', coalesce(e.subject, '') || ' — ' || e.body_text,
              ts_headline('simple', coalesce(e.subject, '') || ' — ' || e.body_text, websearch_to_tsquery('simple', ${mtsq}), '${HEADLINE_OPTS}'),
              ts_rank(to_tsvector('simple', coalesce(e.subject, '') || ' ' || e.body_text), websearch_to_tsquery('simple', ${mtsq}))
         FROM email_messages e JOIN interactions i ON i.id = e.interaction_id LEFT JOIN agents a ON a.id = i.agent_id
         ${where} AND (to_tsvector('simple', coalesce(e.subject, '') || ' ' || e.body_text) @@ websearch_to_tsquery('simple', ${mtsq})
                       OR e.body_text ILIKE ${mlike} OR e.subject ILIKE ${mlike})
     ) x0 ) x WHERE rn <= 2 ORDER BY rank DESC, occurred_at DESC, seq LIMIT 20`,
    mb.params,
  );

  return {
    interactions, total: total?.n ?? 0,
    segments: segments.map(({ raw, ...r }) => ({ ...r, snippet: r.snippet.includes(HL_START) ? r.snippet : fallbackSnippet(raw, f.q) ?? r.snippet })),
    messages: messages.map(({ raw, ...r }) => ({ ...r, snippet: r.snippet.includes(HL_START) ? r.snippet : fallbackSnippet(raw, f.q) ?? r.snippet })),
  };
}

/** When only the ILIKE fallback matched, mark the literal substring so the user still sees why it matched. */
function fallbackSnippet(text: string | null, q: string): string | null {
  if (!text) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 220);
  const start = Math.max(0, idx - 90);
  const end = Math.min(text.length, idx + q.length + 110);
  return (start > 0 ? '… ' : '') + text.slice(start, idx) + HL_START + text.slice(idx, idx + q.length) + HL_STOP + text.slice(idx + q.length, end) + (end < text.length ? ' …' : '');
}
