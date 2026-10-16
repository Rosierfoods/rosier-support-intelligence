import 'server-only';
import type { Db } from '@/lib/db';
import { isUuid } from '@/lib/db';
import { SqlBuilder, escapeLike } from '@/lib/sql';
import type { Session } from '@/lib/auth/session';
import { scopeAgents, scopeInteractions } from './scope';
import { parseRange, sp, spAll, type DateRange, type SP } from '@/lib/filters';
import {
  CHANNELS, PROCESSING_STATUSES, RESOLUTION_STATUSES, REVIEW_STATUSES, SENTIMENTS, SEVERITIES, type Channel,
} from '@/lib/constants';
import { maskEmail, maskPhone } from '@/lib/crypto';
import { auditAction } from '@/lib/auth/session';
import { bandFor, computeScore, weightsFor, type CriterionDef } from '@/lib/ai/scoring';
import { enqueueProcessing } from '@/lib/pipeline/jobs';
import type { RubricGroup } from '@/lib/constants';

// ───────────────────────── Filters ─────────────────────────

export const CALL_STATUSES = ['answered', 'missed', 'voicemail', 'failed'] as const;
export const SORT_FIELDS = { occurred_at: 'i.occurred_at', quality_score: 'i.quality_score', first_response_seconds: 'i.first_response_seconds' } as const;
type SortField = keyof typeof SORT_FIELDS;

export interface InteractionFilters {
  range: DateRange;
  /** Channels allowed by the page preset (e.g. chats page = chat + whatsapp). Empty = all. */
  channels: Channel[];
  platform?: string;
  agentId?: string;
  teamId?: string;
  product?: string;
  category?: string;
  subcategory?: string;
  severity?: string;
  sentiment?: string;
  scoreMin?: number;
  scoreMax?: number;
  resolution: string[];
  processing?: string;
  review: string[];
  complaints: boolean;
  callStatus?: string;
  q?: string;
  sort: { field: SortField; dir: 'asc' | 'desc' };
}

const oneOf = <T extends string>(v: string | undefined, list: readonly T[]): T | undefined =>
  v && (list as readonly string[]).includes(v) ? (v as T) : undefined;
const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Parse URL search params into validated filters. `presetChannels` restricts the channel set (channel pages). */
export function parseInteractionFilters(searchParams: SP, opts: { presetChannels?: Channel[]; defaultRange?: string } = {}): InteractionFilters {
  const preset = opts.presetChannels ?? [];
  const ch = oneOf(sp(searchParams, 'channel'), CHANNELS);
  let channels: Channel[] = preset;
  if (ch && (!preset.length || preset.includes(ch))) channels = [ch];
  const sortRaw = sp(searchParams, 'sort') ?? '';
  const [sf, sd] = sortRaw.split(':');
  const field = (sf in SORT_FIELDS ? sf : 'occurred_at') as SortField;
  const cat = sp(searchParams, 'category');
  let sub = sp(searchParams, 'subcategory');
  if (sub && cat) sub = sub.split(',').map((x) => (x.includes('.') ? x : `${cat}.${x}`)).join(',');
  const q = sp(searchParams, 'q')?.trim().slice(0, 200);
  return {
    range: parseRange(searchParams, opts.defaultRange ?? '30d'),
    channels,
    platform: sp(searchParams, 'platform')?.slice(0, 40),
    agentId: isUuid(sp(searchParams, 'agent')) ? sp(searchParams, 'agent') : undefined,
    teamId: isUuid(sp(searchParams, 'team')) ? sp(searchParams, 'team') : undefined,
    product: sp(searchParams, 'product')?.slice(0, 120),
    category: cat?.slice(0, 80),
    subcategory: sub?.slice(0, 120),
    severity: oneOf(sp(searchParams, 'severity'), SEVERITIES),
    sentiment: oneOf(sp(searchParams, 'sentiment'), SENTIMENTS),
    scoreMin: num(sp(searchParams, 'score_min')),
    scoreMax: num(sp(searchParams, 'score_max')),
    resolution: spAll(searchParams, 'resolution').filter((r) => (RESOLUTION_STATUSES as readonly string[]).includes(r)),
    processing: oneOf(sp(searchParams, 'processing'), PROCESSING_STATUSES),
    review: spAll(searchParams, 'review').filter((r) => (REVIEW_STATUSES as readonly string[]).includes(r)),
    complaints: sp(searchParams, 'complaints') === '1',
    callStatus: oneOf(sp(searchParams, 'call_status'), CALL_STATUSES),
    q: q || undefined,
    sort: { field, dir: sd === 'asc' ? 'asc' : 'desc' },
  };
}

/** Human-readable summary (used in the export audit log). */
export function describeFilters(f: InteractionFilters): Record<string, unknown> {
  const out: Record<string, unknown> = { range: f.range.preset === 'custom' ? f.range.label : f.range.preset };
  const keys: (keyof InteractionFilters)[] = ['channels', 'platform', 'agentId', 'teamId', 'product', 'category', 'subcategory', 'severity',
    'sentiment', 'scoreMin', 'scoreMax', 'resolution', 'processing', 'review', 'complaints', 'callStatus', 'q'];
  for (const k of keys) {
    const v = f[k];
    if (v === undefined || v === false || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  return out;
}

/** Shared WHERE builder for list, export and counts. Always applies role scope. */
export function applyInteractionFilters(s: Session, f: InteractionFilters, b: SqlBuilder, alias = 'i') {
  const i = alias;
  b.and(scopeInteractions(s, b, i));
  b.and(`${i}.occurred_at >= ${b.p(f.range.from)} AND ${i}.occurred_at <= ${b.p(f.range.to)}`);
  if (f.channels.length) b.and(`${i}.channel = ANY(${b.p(f.channels)})`);
  if (f.platform) b.and(`${i}.source_platform = ${b.p(f.platform)}`);
  if (f.agentId) b.and(`${i}.agent_id = ${b.p(f.agentId)}`);
  if (f.teamId) b.and(`${i}.team_id = ${b.p(f.teamId)}`);
  if (f.product) b.and(`(${i}.product = ${b.p(f.product)} OR EXISTS (SELECT 1 FROM interaction_issue_labels pl WHERE pl.interaction_id = ${i}.id AND pl.is_active AND pl.product = ${b.p(f.product)}))`);
  if (f.category || f.subcategory) {
    const conds = ['l.interaction_id = ' + i + '.id', 'l.is_active'];
    if (f.category) conds.push(`c.code = ${b.p(f.category)}`);
    if (f.subcategory) conds.push(`sc.code = ANY(${b.p(f.subcategory.split(',').map((x) => x.trim()).filter(Boolean))})`);
    b.and(`EXISTS (SELECT 1 FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
             LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id WHERE ${conds.join(' AND ')})`);
  }
  if (f.complaints) {
    b.and(`EXISTS (SELECT 1 FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
             WHERE l.interaction_id = ${i}.id AND l.is_active AND c.code NOT IN ('product_info','other'))`);
  }
  if (f.severity) b.and(`EXISTS (SELECT 1 FROM quality_flags qf WHERE qf.interaction_id = ${i}.id AND qf.severity = ${b.p(f.severity)} AND qf.status <> 'false_positive')`);
  if (f.sentiment) b.and(`${i}.sentiment = ${b.p(f.sentiment)}`);
  if (f.scoreMin !== undefined) b.and(`${i}.quality_score >= ${b.p(f.scoreMin)}`);
  if (f.scoreMax !== undefined) b.and(`${i}.quality_score <= ${b.p(f.scoreMax)}`);
  if (f.resolution.length) b.and(`${i}.resolution_status = ANY(${b.p(f.resolution)})`);
  if (f.processing) b.and(`${i}.processing_status = ${b.p(f.processing)}`);
  if (f.review.length) b.and(`${i}.review_status = ANY(${b.p(f.review)})`);
  if (f.callStatus) b.and(`EXISTS (SELECT 1 FROM calls cs WHERE cs.interaction_id = ${i}.id AND cs.call_status = ${b.p(f.callStatus)})`);
  if (f.q) {
    const like = b.p(`%${escapeLike(f.q)}%`);
    const tsq = b.p(f.q);
    const ors = [
      `${i}.search_tsv @@ websearch_to_tsquery('simple', ${tsq})`,
      `${i}.search_text ILIKE ${like}`,
      `${i}.ref ILIKE ${like}`,
      `${i}.subject ILIKE ${like}`,
      `${i}.preview ILIKE ${like}`,
      `EXISTS (SELECT 1 FROM agents qa WHERE qa.id = ${i}.agent_id AND qa.name ILIKE ${like})`,
    ];
    if (s.permissions.has('customer_pii.view')) {
      const digits = f.q.replace(/\D/g, '');
      const idConds = [`qc.email ILIKE ${like}`, `qc.name ILIKE ${like}`];
      if (digits.length >= 4) idConds.push(`regexp_replace(coalesce(qc.phone, ''), '\\D', '', 'g') LIKE ${b.p(`%${digits}%`)}`);
      ors.push(`EXISTS (SELECT 1 FROM customers qc WHERE qc.id = ${i}.customer_id AND (${idConds.join(' OR ')}))`);
    }
    b.and(`(${ors.join(' OR ')})`);
  }
}

// ───────────────────────── List ─────────────────────────

export interface InteractionRow {
  id: string; ref: string; is_demo: boolean; occurred_at: string; channel: Channel; source_platform: string;
  subject: string | null; preview: string | null; product: string | null; sentiment: string | null;
  quality_score: string | null; quality_band: string | null; resolution_status: string; processing_status: string; review_status: string;
  first_response_seconds: number | null; customer_name: string | null; customer_contact: string | null;
  agent_id: string | null; agent_name: string | null; team_name: string | null;
  primary_category: string | null; primary_sub: string | null; label_count: number;
  open_flags: number; max_severity: string | null;
  call_status: string | null; duration_seconds: number | null; recording_available: boolean | null; transcript_status: string | null;
}

const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

const LIST_SELECT = `
  SELECT i.id, i.ref, i.is_demo, i.occurred_at, i.channel, i.source_platform, i.subject, i.preview, i.product, i.sentiment,
         i.quality_score, i.quality_band, i.resolution_status, i.processing_status, i.review_status, i.first_response_seconds,
         cu.name AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email,
         a.id AS agent_id, a.name AS agent_name, t.name AS team_name,
         lab.primary_category, lab.primary_sub, coalesce(lab.label_count, 0) AS label_count,
         coalesce(fl.open_flags, 0) AS open_flags, fl.max_severity,
         cl.call_status, cl.duration_seconds, cl.recording_available, tr.status AS transcript_status
    FROM interactions i
    LEFT JOIN customers cu ON cu.id = i.customer_id
    LEFT JOIN agents a ON a.id = i.agent_id
    LEFT JOIN teams t ON t.id = i.team_id
    LEFT JOIN calls cl ON cl.interaction_id = i.id
    LEFT JOIN LATERAL (SELECT ct.status FROM call_transcripts ct WHERE ct.interaction_id = i.id AND ct.is_current
                        ORDER BY ct.created_at DESC LIMIT 1) tr ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS label_count,
                              (array_agg(c.name ORDER BY l.is_primary DESC, l.created_at))[1] AS primary_category,
                              (array_agg(sc.name ORDER BY l.is_primary DESC, l.created_at))[1] AS primary_sub
                         FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
                         LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
                        WHERE l.interaction_id = i.id AND l.is_active) lab ON true
    LEFT JOIN LATERAL (SELECT count(*)::int AS open_flags, (array_agg(f.severity ORDER BY ${SEVERITY_RANK.replace(/severity/g, 'f.severity')}))[1] AS max_severity
                         FROM quality_flags f WHERE f.interaction_id = i.id AND f.status IN ('new','under_review','confirmed')) fl ON true`;

function maskRow<T extends { customer_phone?: string | null; customer_email?: string | null }>(r: T, canPii: boolean) {
  const { customer_phone, customer_email, ...rest } = r;
  const contact = canPii ? (customer_phone || customer_email || null)
    : customer_phone ? maskPhone(customer_phone) : customer_email ? maskEmail(customer_email) : null;
  return { ...rest, customer_contact: contact };
}

export async function listInteractions(db: Db, s: Session, f: InteractionFilters, page: { pageSize: number; offset: number }) {
  const b = new SqlBuilder();
  applyInteractionFilters(s, f, b);
  const where = b.whereSql();
  const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM interactions i ${where}`, b.params);
  const order = `${SORT_FIELDS[f.sort.field]} ${f.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, i.occurred_at DESC, i.id`;
  const rows = await db.query(`${LIST_SELECT} ${where} ORDER BY ${order} LIMIT ${Number(page.pageSize)} OFFSET ${Number(page.offset)}`, b.params);
  const canPii = s.permissions.has('customer_pii.view');
  return { total: total?.n ?? 0, rows: rows.map((r) => maskRow(r, canPii)) as InteractionRow[] };
}

// ───────────────────────── Export ─────────────────────────

export const EXPORT_MAX_ROWS = 10_000;

export async function exportInteractions(db: Db, s: Session, f: InteractionFilters) {
  const b = new SqlBuilder();
  applyInteractionFilters(s, f, b);
  const order = `${SORT_FIELDS[f.sort.field]} ${f.sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, i.occurred_at DESC`;
  const rows = await db.query(
    `SELECT i.ref, i.occurred_at, i.source_platform, i.channel, i.direction, i.source_record_id, i.subject, i.ai_summary, i.customer_intent,
            i.product, i.sentiment, i.quality_score, i.quality_band, i.resolution_status, i.review_status, i.processing_status, i.is_demo,
            i.first_response_seconds, i.resolution_seconds,
            cu.name AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email,
            a.name AS agent_name, t.name AS team_name, tk.external_id AS ticket_ref,
            cl.call_status, cl.duration_seconds, cl.recording_available,
            (SELECT string_agg(c.name || coalesce(' › ' || sc.name, ''), '; ' ORDER BY l.is_primary DESC, l.created_at)
               FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
               LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
              WHERE l.interaction_id = i.id AND l.is_active) AS issue_labels,
            (SELECT c.name FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
              WHERE l.interaction_id = i.id AND l.is_active ORDER BY l.is_primary DESC, l.created_at LIMIT 1) AS issue_category,
            (SELECT sc.name FROM interaction_issue_labels l JOIN issue_categories sc ON sc.id = l.subcategory_id
              WHERE l.interaction_id = i.id AND l.is_active ORDER BY l.is_primary DESC, l.created_at LIMIT 1) AS issue_subcategory,
            (SELECT string_agg(f.severity || ': ' || f.title || ' [' || f.status || ']', '; ' ORDER BY f.created_at)
               FROM quality_flags f WHERE f.interaction_id = i.id AND f.status <> 'false_positive') AS detected_errors,
            (SELECT qe.improved_response FROM quality_evaluations qe WHERE qe.interaction_id = i.id AND qe.is_current
              ORDER BY qe.created_at DESC LIMIT 1) AS recommended_improvement
       FROM interactions i
       LEFT JOIN customers cu ON cu.id = i.customer_id
       LEFT JOIN agents a ON a.id = i.agent_id
       LEFT JOIN teams t ON t.id = i.team_id
       LEFT JOIN support_tickets tk ON tk.id = i.ticket_id
       LEFT JOIN calls cl ON cl.interaction_id = i.id
       ${b.whereSql()} ORDER BY ${order} LIMIT ${EXPORT_MAX_ROWS + 1}`,
    b.params,
  );
  const canPii = s.permissions.has('customer_pii.view');
  const truncated = rows.length > EXPORT_MAX_ROWS;
  const out = rows.slice(0, EXPORT_MAX_ROWS).map((r) => ({
    ...r,
    customer_phone: canPii ? r.customer_phone : r.customer_phone ? maskPhone(r.customer_phone) : null,
    customer_email: canPii ? r.customer_email : r.customer_email ? maskEmail(r.customer_email) : null,
  }));
  return { rows: out, truncated };
}

// ───────────────────────── Filter options ─────────────────────────

export interface CategoryOption { code: string; name: string; parent_code: string | null }

export async function getFilterOptions(db: Db, s: Session) {
  const ab = new SqlBuilder();
  ab.and(scopeAgents(s, ab, 'a.id'));
  const agents = await db.query<{ id: string; name: string; team_id: string | null }>(
    `SELECT a.id, a.name, a.team_id FROM agents a ${ab.whereSql()} ORDER BY a.is_active DESC, a.name`, ab.params);
  const teams = await db.query<{ id: string; name: string }>(
    s.scope === 'all' ? 'SELECT id, name FROM teams ORDER BY name' : 'SELECT id, name FROM teams WHERE id = $1',
    s.scope === 'all' ? [] : [s.user.teamId ?? '00000000-0000-0000-0000-000000000000']);
  const products = await db.query<{ product: string }>(
    `SELECT DISTINCT product FROM (SELECT product FROM interactions WHERE product IS NOT NULL
       UNION SELECT product FROM interaction_issue_labels WHERE product IS NOT NULL AND is_active) p ORDER BY product`);
  const platforms = await db.query<{ source_platform: string }>('SELECT DISTINCT source_platform FROM interactions ORDER BY 1');
  const categories = await getCategories(db);
  return { agents, teams, products: products.map((p) => p.product), platforms: platforms.map((p) => p.source_platform), categories };
}

export async function getCategories(db: Db): Promise<(CategoryOption & { id: string })[]> {
  return db.query(
    `SELECT c.id, c.code, c.name, p.code AS parent_code FROM issue_categories c
       LEFT JOIN issue_categories p ON p.id = c.parent_id
      WHERE c.is_active ORDER BY coalesce(p.sort, c.sort), coalesce(p.name, c.name), c.parent_id NULLS FIRST, c.sort, c.name`);
}

// ───────────────────────── Detail ─────────────────────────

export interface TranscriptSegment { seq: number; speaker: string; start_ms: number; end_ms: number; text: string; text_en: string | null }
export interface ThreadMessage { seq: number; sender_type: string; sender_name: string | null; body: string; sent_at: string; attachments: AttachmentRow[] }
export interface EmailMessage {
  seq: number; sender_type: string; subject: string | null; from_address: string; to_addresses: string[]; cc_addresses: string[];
  sent_at: string; body_text: string; attachments: AttachmentRow[];
}
export interface AttachmentRow { id: string; file_name: string | null; mime_type: string | null; size_bytes: number | null; conversation_message_id: string | null; email_message_id: string | null }
export interface CriterionScoreRow { code: string; score: number | null; na: boolean; evidence?: string; rationale?: string; reviewer_note?: string }
export interface EvaluationRow {
  id: string; evaluator_type: 'ai' | 'human'; evaluator_name: string | null; provider: string | null; model: string | null; prompt_version: string | null;
  overall_score: string | null; band: string | null; criterion_scores: CriterionScoreRow[];
  group_scores: Record<string, { score: number | null; weight: number; applicable: boolean }>;
  positives: string[]; missed_opportunities: string[]; incorrect_statements: string[]; policy_violations: string[]; frustration_indicators: string[];
  improved_response: string | null; confidence: string | null; policy_uncertain: boolean; policy_uncertainty_note: string | null;
  kb_version_ids: string[]; notes: string | null; is_current: boolean; created_at: string;
}
export interface FlagRow {
  id: string; severity: string; rule_code: string; rule_name: string | null; title: string; reason: string; excerpt: string;
  evidence_ref: { segment_seq?: number; start_ms?: number; message_seq?: number; email_seq?: number; sent_at?: string };
  criterion_code: string | null; criterion_name: string | null; policy_article_id: string | null; policy_title: string | null; policy_version: number | null;
  confidence: string | null; recommended_correction: string | null; status: string; assigned_to: string | null; assignee_name: string | null;
  escalated: boolean; acknowledged_at: string | null; resolved_at: string | null; is_demo: boolean; created_at: string; agent_id: string | null;
}
export interface LabelRow {
  id: string; category_id: string; category_code: string; category_name: string; subcategory_code: string | null; subcategory_name: string | null;
  is_primary: boolean; product: string | null; variant: string | null; customer_reason: string | null; agent_reason: string | null; severity: string | null;
  resolution_requested: string | null; resolution_provided: string | null; order_ref: string | null; refund_amount: string | null;
  refund_amount_source: string | null; replacement_status: string | null; escalated: boolean; confidence: string | null; evidence: string | null;
  source: 'ai' | 'human'; is_active: boolean; created_by_name: string | null; created_at: string;
  root_causes: { id: string; cause: string; status: string; is_ai_inference: boolean; evidence: string | null; confirmed_by_name: string | null; confirmed_at: string | null }[];
}

export async function getInteractionDetail(db: Db, s: Session, id: string) {
  if (!isUuid(id)) return null;
  const b = new SqlBuilder();
  b.and(`i.id = ${b.p(id)}`);
  b.and(scopeInteractions(s, b, 'i'));
  const base = await db.one(
    `SELECT i.*, a.name AS agent_name, t.name AS team_name,
            cu.name AS customer_name, cu.phone AS customer_phone, cu.email AS customer_email,
            tk.external_id AS ticket_ref, tk.subject AS ticket_subject, tk.status AS ticket_status, tk.order_ref AS ticket_order_ref
       FROM interactions i
       LEFT JOIN agents a ON a.id = i.agent_id
       LEFT JOIN teams t ON t.id = i.team_id
       LEFT JOIN customers cu ON cu.id = i.customer_id
       LEFT JOIN support_tickets tk ON tk.id = i.ticket_id
       ${b.whereSql()}`,
    b.params,
  );
  if (!base) return null;
  const canPii = s.permissions.has('customer_pii.view');
  const { customer_phone, customer_email, search_text: _st, search_tsv: _tsv, ...interaction } = base;
  const customer = {
    name: base.customer_name as string | null,
    phone: canPii ? customer_phone : customer_phone ? maskPhone(customer_phone) : null,
    email: canPii ? customer_email : customer_email ? maskEmail(customer_email) : null,
  };

  const [call, transcript, segments, messages, emails, attachments, analysis, evaluations, criteria, labels, rootCauses, flags, decisions, feedback] = await Promise.all([
    db.one(`SELECT call_status, duration_seconds, ring_seconds, from_number_masked, to_number_masked, recording_available,
                   (recording_source_ref LIKE 'demo://%') AS demo_recording, recording_mime, language_hint
              FROM calls WHERE interaction_id = $1`, [id]),
    db.one(`SELECT id, provider, model, language, status, error, attempt, diarized, translation_en, created_at, updated_at
              FROM call_transcripts WHERE interaction_id = $1 AND is_current ORDER BY created_at DESC LIMIT 1`, [id]),
    db.query<TranscriptSegment>(`SELECT s.seq, s.speaker, s.start_ms, s.end_ms, s.text, s.text_en FROM transcript_segments s
              JOIN call_transcripts t ON t.id = s.transcript_id AND t.is_current WHERE s.interaction_id = $1 ORDER BY s.seq`, [id]),
    db.query(`SELECT id, seq, sender_type, sender_name, body, sent_at FROM conversation_messages WHERE interaction_id = $1 ORDER BY sent_at, seq`, [id]),
    db.query(`SELECT id, seq, sender_type, subject, from_address, to_addresses, cc_addresses, sent_at, body_text
                FROM email_messages WHERE interaction_id = $1 ORDER BY sent_at, seq`, [id]),
    db.query<AttachmentRow>(`SELECT id, file_name, mime_type, size_bytes, conversation_message_id, email_message_id FROM attachments WHERE interaction_id = $1 ORDER BY created_at`, [id]),
    db.one(`SELECT id, provider, model, prompt_version, status, error, output, kb_version_ids, created_at FROM ai_analyses
              WHERE interaction_id = $1 AND kind = 'full' AND is_current ORDER BY created_at DESC LIMIT 1`, [id]),
    db.query<EvaluationRow>(`SELECT e.id, e.evaluator_type, u.name AS evaluator_name, an.provider, an.model, an.prompt_version,
                   e.overall_score, e.band, e.criterion_scores, e.group_scores, e.positives, e.missed_opportunities, e.incorrect_statements,
                   e.policy_violations, e.frustration_indicators, e.improved_response, e.confidence, e.policy_uncertain, e.policy_uncertainty_note,
                   e.kb_version_ids, e.notes, e.is_current, e.created_at
              FROM quality_evaluations e LEFT JOIN users u ON u.id = e.evaluator_user_id LEFT JOIN ai_analyses an ON an.id = e.analysis_id
             WHERE e.interaction_id = $1 ORDER BY e.is_current DESC, e.created_at DESC`, [id]),
    db.query<{ code: string; name: string; description: string; group_code: string; channels: string[]; sort: number; is_active: boolean }>(
      `SELECT code, name, description, group_code, channels, sort, is_active FROM quality_criteria ORDER BY sort, name`),
    db.query(`SELECT l.*, c.code AS category_code, c.name AS category_name, sc.code AS subcategory_code, sc.name AS subcategory_name,
                     u.name AS created_by_name
                FROM interaction_issue_labels l JOIN issue_categories c ON c.id = l.category_id
                LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id LEFT JOIN users u ON u.id = l.created_by
               WHERE l.interaction_id = $1 ORDER BY l.is_active DESC, l.is_primary DESC, l.created_at`, [id]),
    db.query(`SELECT r.id, r.label_id, r.cause, r.status, r.is_ai_inference, r.evidence, u.name AS confirmed_by_name, r.confirmed_at
                FROM issue_root_causes r LEFT JOIN users u ON u.id = r.confirmed_by WHERE r.interaction_id = $1 ORDER BY r.created_at`, [id]),
    db.query<FlagRow>(`SELECT f.id, f.severity, f.rule_code, ar.name AS rule_name, f.title, f.reason, f.excerpt, f.evidence_ref, f.criterion_code,
                     qc.name AS criterion_name, f.policy_article_id, ka.title AS policy_title, kv.version AS policy_version, f.confidence,
                     f.recommended_correction, f.status, f.assigned_to, u.name AS assignee_name, f.escalated, f.acknowledged_at, f.resolved_at,
                     f.is_demo, f.created_at, f.agent_id
                FROM quality_flags f
                LEFT JOIN alert_rules ar ON ar.code = f.rule_code
                LEFT JOIN quality_criteria qc ON qc.code = f.criterion_code
                LEFT JOIN knowledge_base_articles ka ON ka.id = f.policy_article_id
                LEFT JOIN knowledge_base_versions kv ON kv.id = f.policy_version_id
                LEFT JOIN users u ON u.id = f.assigned_to
               WHERE f.interaction_id = $1
               ORDER BY ${SEVERITY_RANK.replace(/severity/g, 'f.severity')}, f.created_at`, [id]),
    db.query(`SELECT d.id, d.target_type, d.target_id, d.decision, d.before_state, d.after_state, d.notes, d.created_at, u.name AS reviewer_name
                FROM reviewer_decisions d LEFT JOIN users u ON u.id = d.reviewer_id
               WHERE d.interaction_id = $1 ORDER BY d.created_at DESC LIMIT 100`, [id]),
    db.query(`SELECT csat, nps, comment, source, received_at FROM customer_feedback WHERE interaction_id = $1 ORDER BY received_at DESC`, [id]),
  ]);

  const attFor = (key: 'conversation_message_id' | 'email_message_id', mid: string) => attachments.filter((a) => a[key] === mid);
  const threadMessages: ThreadMessage[] = messages.map((m: any) => ({ ...m, attachments: attFor('conversation_message_id', m.id) }));
  const emailMessages: EmailMessage[] = emails.map((e: any) => ({
    ...e,
    from_address: canPii || e.sender_type !== 'customer' ? e.from_address : maskEmail(e.from_address),
    to_addresses: (e.to_addresses ?? []).map((a: string) => (canPii || e.sender_type === 'customer' ? a : maskEmail(a))),
    cc_addresses: (e.cc_addresses ?? []).map((a: string) => (canPii ? a : maskEmail(a))),
    attachments: attFor('email_message_id', e.id),
  }));

  const kbIds = Array.from(new Set(evaluations.flatMap((e) => e.kb_version_ids ?? []).concat(analysis?.kb_version_ids ?? [])));
  const kbVersions = kbIds.length
    ? await db.query<{ id: string; version: number; article_id: string; title: string; is_placeholder: boolean; status: string }>(
      `SELECT v.id, v.version, v.article_id, a.title, v.is_placeholder, v.status FROM knowledge_base_versions v
         JOIN knowledge_base_articles a ON a.id = v.article_id WHERE v.id = ANY($1)`, [kbIds])
    : [];

  const labelRows: LabelRow[] = labels.map((l: any) => ({ ...l, root_causes: rootCauses.filter((r: any) => r.label_id === l.id) }));

  return {
    interaction: { ...interaction, customer } as any,
    call: call as null | {
      call_status: string; duration_seconds: number | null; ring_seconds: number | null; from_number_masked: string | null; to_number_masked: string | null;
      recording_available: boolean; demo_recording: boolean; recording_mime: string | null; language_hint: string | null;
    },
    transcript: transcript as null | { id: string; provider: string; model: string | null; language: string | null; status: string; error: string | null; attempt: number; diarized: boolean; translation_en: string | null },
    segments,
    messages: threadMessages,
    emails: emailMessages,
    attachments,
    analysis: analysis as null | { id: string; provider: string; model: string; prompt_version: string; status: string; error: string | null; output: Record<string, any> | null; created_at: string },
    evaluations,
    criteria,
    kbVersions,
    labels: labelRows,
    flags,
    decisions,
    feedback,
  };
}
export type InteractionDetail = NonNullable<Awaited<ReturnType<typeof getInteractionDetail>>>;

/** Light scoped lookup used by mutations: ensures the interaction exists and is within the session's scope. */
export async function getScopedInteraction(db: Db, s: Session, id: string) {
  if (!isUuid(id)) return null;
  const b = new SqlBuilder();
  b.and(`i.id = ${b.p(id)}`);
  b.and(scopeInteractions(s, b, 'i'));
  return db.one<{ id: string; ref: string; channel: Channel; processing_status: string; resolution_status: string; review_status: string;
    quality_score: string | null; quality_band: string | null; agent_id: string | null }>(
    `SELECT i.id, i.ref, i.channel, i.processing_status, i.resolution_status, i.review_status, i.quality_score, i.quality_band, i.agent_id
       FROM interactions i ${b.whereSql()}`, b.params);
}

// ───────────────────────── Review mutations ─────────────────────────
// Each mutation: scope check → change → reviewer_decisions row → audit log. Callers check permissions first.


export class ReviewError extends Error {}

async function decision(db: Db, s: Session, d: {
  targetType: 'flag' | 'evaluation' | 'issue_label' | 'root_cause' | 'interaction'; targetId: string; interactionId: string;
  decision: string; before?: unknown; after?: unknown; notes?: string | null;
}) {
  await db.exec(
    `INSERT INTO reviewer_decisions (org_id, target_type, target_id, interaction_id, reviewer_id, decision, before_state, after_state, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [s.org.id, d.targetType, d.targetId, d.interactionId, s.user.id, d.decision,
      d.before === undefined ? null : JSON.stringify(d.before), d.after === undefined ? null : JSON.stringify(d.after), d.notes ?? null],
  );
}
export { decision as recordReviewerDecision };

async function mustGet(db: Db, s: Session, id: string) {
  const row = await getScopedInteraction(db, s, id);
  if (!row) throw new ReviewError('Interaction not found or outside your data scope.');
  return row;
}

export async function updateInteractionStatus(db: Db, s: Session, id: string, input: { resolution?: string; review?: string; note?: string | null }) {
  const cur = await mustGet(db, s, id);
  const after = { resolution_status: input.resolution ?? cur.resolution_status, review_status: input.review ?? cur.review_status };
  const before = { resolution_status: cur.resolution_status, review_status: cur.review_status };
  if (after.resolution_status === before.resolution_status && after.review_status === before.review_status && !input.note) return;
  await db.exec(`UPDATE interactions SET resolution_status = $2, review_status = $3 WHERE id = $1`, [id, after.resolution_status, after.review_status]);
  await decision(db, s, { targetType: 'interaction', targetId: id, interactionId: id, decision: 'status_changed', before, after, notes: input.note });
  await auditAction(db, s, 'interaction.status_updated', 'interaction', id, { ref: cur.ref, before, after });
}

export async function addReviewerNote(db: Db, s: Session, id: string, note: string) {
  const cur = await mustGet(db, s, id);
  await decision(db, s, { targetType: 'interaction', targetId: id, interactionId: id, decision: 'comment', notes: note });
  await auditAction(db, s, 'interaction.note_added', 'interaction', id, { ref: cur.ref });
}

export async function retryInteractionProcessing(db: Db, s: Session, id: string) {
  const cur = await mustGet(db, s, id);
  const jobId = await enqueueProcessing(db, s.org.id, id, { force: true, reason: 'manual_retry' });
  await auditAction(db, s, 'processing.retry', 'interaction', id, { ref: cur.ref, previous_status: cur.processing_status, job_id: jobId });
  return jobId;
}

export interface CriterionInput { code: string; score: number | null; na: boolean; note?: string }

/** Manual QA assessment / correction → new human evaluation row becomes current. */
export async function correctEvaluation(db: Db, s: Session, id: string, input: { scores: CriterionInput[]; notes: string }) {
  const cur = await mustGet(db, s, id);
  const prev = await db.one<EvaluationRow & { analysis_id: string | null; rubric_snapshot: any }>(
    `SELECT * FROM quality_evaluations WHERE interaction_id = $1 AND is_current ORDER BY created_at DESC LIMIT 1`, [id]);
  const criteria = await db.query<{ code: string; name: string; group_code: string; channels: string[] }>(
    `SELECT code, name, group_code, channels FROM quality_criteria WHERE is_active ORDER BY sort`);
  const defs: CriterionDef[] = criteria.map((c) => ({ code: c.code, name: c.name, group: c.group_code as RubricGroup, channels: c.channels }));
  const known = new Set(defs.map((d) => d.code));
  const prevByCode = new Map((prev?.criterion_scores ?? []).map((c) => [c.code, c]));
  const scores: CriterionScoreRow[] = input.scores.filter((x) => known.has(x.code)).map((x) => {
    const p = prevByCode.get(x.code);
    const na = x.na || x.score === null;
    return {
      code: x.code, na, score: na ? null : Math.max(0, Math.min(5, Math.round(Number(x.score)))),
      evidence: p?.evidence, rationale: p?.rationale,
      ...(x.note ? { reviewer_note: x.note } : {}),
    };
  });
  if (!scores.length) throw new ReviewError('Score at least one criterion.');
  const weights = weightsFor(s.org.settings, cur.channel);
  const { overall, groups } = computeScore(scores, defs, weights);
  const band = bandFor(overall, s.org.settings.scoreBands)?.label ?? null;

  if (prev) await db.exec(`UPDATE quality_evaluations SET is_current = false WHERE interaction_id = $1 AND is_current`, [id]);
  const row = await db.one<{ id: string }>(
    `INSERT INTO quality_evaluations (org_id, interaction_id, analysis_id, evaluator_type, evaluator_user_id, overall_score, band, criterion_scores,
        group_scores, positives, missed_opportunities, incorrect_statements, policy_violations, frustration_indicators, improved_response,
        confidence, policy_uncertain, policy_uncertainty_note, rubric_snapshot, kb_version_ids, notes, is_current)
     VALUES ($1,$2,$3,'human',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$16,$17,$18,$19,true) RETURNING id`,
    [s.org.id, id, prev?.analysis_id ?? null, s.user.id, overall, band, JSON.stringify(scores), JSON.stringify(groups),
      JSON.stringify(prev?.positives ?? []), JSON.stringify(prev?.missed_opportunities ?? []), JSON.stringify(prev?.incorrect_statements ?? []),
      JSON.stringify(prev?.policy_violations ?? []), JSON.stringify(prev?.frustration_indicators ?? []), prev?.improved_response ?? null,
      prev?.policy_uncertain ?? false, prev?.policy_uncertainty_note ?? null,
      JSON.stringify({ weights, corrected_from: prev?.id ?? null, criteria: defs.map((d) => ({ code: d.code, group: d.group })) }),
      prev?.kb_version_ids ?? [], input.notes],
  );
  await db.exec(`UPDATE interactions SET quality_score = $2, quality_band = $3, review_status = 'corrected' WHERE id = $1`, [id, overall, band]);
  const before = prev ? { evaluation_id: prev.id, evaluator_type: prev.evaluator_type, overall_score: prev.overall_score === null ? null : Number(prev.overall_score), band: prev.band, criterion_scores: prev.criterion_scores } : null;
  const after = { evaluation_id: row!.id, evaluator_type: 'human', overall_score: overall, band, criterion_scores: scores };
  await decision(db, s, { targetType: 'evaluation', targetId: row!.id, interactionId: id, decision: prev ? 'corrected' : 'manual_assessment', before, after, notes: input.notes });
  await auditAction(db, s, 'evaluation.corrected', 'interaction', id, {
    ref: cur.ref, evaluation_id: row!.id, previous_evaluation_id: prev?.id ?? null,
    score_before: before?.overall_score ?? null, score_after: overall,
  });
  return { evaluationId: row!.id, overall, band };
}

export async function addIssueLabel(db: Db, s: Session, id: string, input: {
  categoryId: string; subcategoryId?: string | null; product?: string | null; severity?: string | null; customerReason?: string | null; note?: string | null;
}) {
  const cur = await mustGet(db, s, id);
  const cat = await db.one<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM issue_categories WHERE id = $1 AND parent_id IS NULL`, [input.categoryId]);
  if (!cat) throw new ReviewError('Unknown issue category.');
  let sub: { id: string; code: string; name: string } | null = null;
  if (input.subcategoryId) {
    sub = await db.one(`SELECT id, code, name FROM issue_categories WHERE id = $1 AND parent_id = $2`, [input.subcategoryId, cat.id]);
    if (!sub) throw new ReviewError('Subcategory does not belong to the selected category.');
  }
  const hasPrimary = await db.one<{ x: boolean }>(`SELECT EXISTS (SELECT 1 FROM interaction_issue_labels WHERE interaction_id = $1 AND is_active AND is_primary) AS x`, [id]);
  const row = await db.one<{ id: string }>(
    `INSERT INTO interaction_issue_labels (org_id, interaction_id, category_id, subcategory_id, is_primary, product, severity, customer_reason,
        source, is_active, created_by, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'human',true,$9,NULL) RETURNING id`,
    [s.org.id, id, cat.id, sub?.id ?? null, !hasPrimary?.x, input.product || null, input.severity || null, input.customerReason || null, s.user.id],
  );
  const after = { category: cat.code, subcategory: sub?.code ?? null, product: input.product || null, severity: input.severity || null };
  await decision(db, s, { targetType: 'issue_label', targetId: row!.id, interactionId: id, decision: 'added', after, notes: input.note });
  await auditAction(db, s, 'issue_label.added', 'interaction', id, { ref: cur.ref, label_id: row!.id, ...after });
  await db.exec('SELECT rsi_refresh_search_text($1)', [id]);
}

export async function removeIssueLabel(db: Db, s: Session, id: string, labelId: string, note: string | null) {
  const cur = await mustGet(db, s, id);
  const l = await db.one(`SELECT l.id, l.is_primary, l.source, c.code AS category, sc.code AS subcategory FROM interaction_issue_labels l
      JOIN issue_categories c ON c.id = l.category_id LEFT JOIN issue_categories sc ON sc.id = l.subcategory_id
     WHERE l.id = $1 AND l.interaction_id = $2 AND l.is_active`, [labelId, id]);
  if (!l) throw new ReviewError('Label not found.');
  await db.exec(`UPDATE interaction_issue_labels SET is_active = false, is_primary = false WHERE id = $1`, [labelId]);
  if (l.is_primary) {
    await db.exec(`UPDATE interaction_issue_labels SET is_primary = true WHERE id = (
        SELECT id FROM interaction_issue_labels WHERE interaction_id = $1 AND is_active ORDER BY created_at LIMIT 1)`, [id]);
  }
  await decision(db, s, { targetType: 'issue_label', targetId: labelId, interactionId: id, decision: 'removed',
    before: { category: l.category, subcategory: l.subcategory, source: l.source, is_active: true }, after: { is_active: false }, notes: note });
  await auditAction(db, s, 'issue_label.removed', 'interaction', id, { ref: cur.ref, label_id: labelId, category: l.category, subcategory: l.subcategory });
  await db.exec('SELECT rsi_refresh_search_text($1)', [id]);
}

export async function setRootCauseStatus(db: Db, s: Session, id: string, rootCauseId: string, status: 'confirmed' | 'rejected' | 'suspected', note: string | null) {
  const cur = await mustGet(db, s, id);
  const rc = await db.one<{ id: string; status: string; cause: string }>(`SELECT id, status, cause FROM issue_root_causes WHERE id = $1 AND interaction_id = $2`, [rootCauseId, id]);
  if (!rc) throw new ReviewError('Root cause not found.');
  await db.exec(
    `UPDATE issue_root_causes SET status = $2,
        confirmed_by = CASE WHEN $2 = 'suspected' THEN NULL ELSE $3::uuid END,
        confirmed_at = CASE WHEN $2 = 'suspected' THEN NULL ELSE now() END
      WHERE id = $1`, [rootCauseId, status, s.user.id]);
  await decision(db, s, { targetType: 'root_cause', targetId: rootCauseId, interactionId: id, decision: status,
    before: { status: rc.status }, after: { status }, notes: note });
  await auditAction(db, s, `root_cause.${status}`, 'interaction', id, { ref: cur.ref, root_cause_id: rootCauseId, cause: rc.cause });
  await db.exec('SELECT rsi_refresh_search_text($1)', [id]);
}
