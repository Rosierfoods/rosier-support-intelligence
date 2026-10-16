/**
 * MyOperator (cloud telephony) adapter — call logs + recording references.
 *
 * Docs relied on (MyOperator's public docs are spread over several pages that describe DIFFERENT payload
 * generations; the mapper below accepts all of them):
 *  - REST API overview: base URL https://developers.myoperator.co, token passed as the `token` query parameter on
 *    every request, call-log search params from/to (UTC unix), log_from (offset), page_size (≤100), search_key,
 *    filters; recording links valid for 24 hours:  https://myoperator.com/api/
 *  - API quick start (rate limits 20/min, 100/h, 500/day per account → HTTP 429 + Retry-After; APIs not on Lite plans):
 *    https://support.myoperator.com/portal/en/kb/articles/what-are-apis-23-8-2025
 *  - After-call webhook (legacy short-key call log, posted as form field `myoperator` containing JSON; keys such as
 *    _ai, _cr, _cl, _st, _et, _dr, _ty, _su, _fn (recording file name), _fu (recording URL), _ld[] legs with _rr agent
 *    {_id,_na,_em,_ct}, _pm[] {ky:"ui"} = call UID; auth = Basic auth or custom headers you define):
 *    https://support.myoperator.com/portal/en/kb/articles/after-call-webhook
 *    https://support.myoperator.com/portal/en/kb/articles/in-call-webhook   (field meanings: _cl caller with country
 *    code, _cr caller, _ci company id, _pm.ui UID, _ri reference id; event type 1 incoming / 2 outgoing; status 1
 *    connected / 2 missed / 3 voicemail)
 *  - "call.completed" webhook (event_id, call_id, direction, from, to, status answered|missed|abandoned|voicemail,
 *    started_at/ended_at ISO, duration_seconds, recording_url, agent; X-Webhook-Token header or Basic auth; optional
 *    X-Webhook-Signature = HMAC-SHA256(body)):
 *    https://support.myoperator.com/portal/en/kb/articles/what-is-an-after-call-webhook-and-how-do-i-configure-it
 *  - Webhook v2 events (call.end: id, status, duration, recording_filename, legs[].agent{uuid,name,email};
 *    envelope session_id, customer_identifier; retries → dedupe):
 *    https://support.myoperator.com/portal/en/kb/articles/what-is-the-exact-payload-structure-for-every-myoperator-webhook-v2-event
 *
 * Assumptions (stated in `limitations`): the call-log search endpoint path is not published in a form we could
 * verify, so it is configurable (default "/search" on developers.myoperator.co, GET with the documented query
 * params). Webhooks are the primary, documented ingestion path.
 */
import type { NormalizedInteraction, ProviderContext, ProviderDefinition, WebhookInput, WebhookResult, FetchResult } from './types';
import { hmacSha256Hex, safeEqual, sha256Hex } from '@/lib/crypto';
import { checkSharedKey, errorMessage, httpJson, lowerHeaders, postForm, str, toDate, toSeconds, trimBase } from './http';

const DEFAULT_BASE = 'https://developers.myoperator.co';
const DEFAULT_LOGS_PATH = '/search';
const PAGE_SIZE = 100;

type CallStatus = NonNullable<NormalizedInteraction['call']>['status'];

export function mapCallStatus(v: unknown, durationSeconds?: number | null): CallStatus {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'answered', 'connected', 'answer', 'completed', 'success'].includes(s)) return 'answered';
  if (['3', 'voicemail', 'vm'].includes(s)) return 'voicemail';
  if (['2', 'missed', 'abandoned', 'noanswer', 'no_answer', 'not answered', 'unanswered', 'cancel', 'cancelled'].includes(s)) return 'missed';
  if (['failed', 'busy', 'congestion', 'chanunavail', 'error'].includes(s)) return 'failed';
  return durationSeconds && durationSeconds > 0 ? 'answered' : 'missed';
}

function kv(list: unknown, key: string): string | null {
  if (!Array.isArray(list)) return null;
  const hit = list.find((x: any) => x?.ky === key || x?.key === key);
  return hit ? str((hit as any).vl ?? (hit as any).value) : null;
}

function httpUrl(v: unknown): string | null {
  const s = str(v);
  return s && /^https?:\/\//i.test(s) ? s : null;
}

/** Legacy short-key call log (after-call webhook / call-log search document). */
function mapLegacy(d: any): NormalizedInteraction | null {
  const id = kv(d._pm, 'ui') ?? str(d._ai) ?? str(d._ri) ?? str(d.uid) ?? str(d.id);
  if (!id) return null;
  const type = String(d._ty ?? '1');
  const direction = type === '2' ? 'outbound' : 'inbound';
  const occurredAt = toDate(d._st) ?? toDate(d._ts) ?? toDate(d._ms) ?? new Date();
  const endedAt = toDate(d._et);
  const duration = toSeconds(d._dr) ?? (endedAt ? Math.max(0, Math.round((endedAt.getTime() - occurredAt.getTime()) / 1000)) : null);
  const legs: any[] = Array.isArray(d._ld) ? d._ld : [];
  const leg = legs.find((l) => l?._rr && (toSeconds(l._dr) ?? 0) > 0) ?? legs.find((l) => l?._rr) ?? null;
  const agent = leg?._rr ?? null;
  const caller = str(d._cl) ?? str(d._cr);
  const service = str(d._dn) ?? str(d._ss) ?? null;
  return {
    sourcePlatform: 'myoperator',
    sourceRecordId: id,
    channel: 'call',
    direction,
    occurredAt,
    endedAt,
    customer: { phone: caller, name: null, externalId: null },
    agent: agent ? { externalId: str(agent._id), name: str(agent._na), email: str(agent._em) } : undefined,
    call: {
      status: mapCallStatus(d._su, duration),
      durationSeconds: duration,
      ringSeconds: null,
      fromNumber: direction === 'inbound' ? caller : str(agent?._ct) ?? service,
      toNumber: direction === 'inbound' ? str(agent?._ct) ?? service : caller,
      recordingRef: httpUrl(d._fu) ?? (str(d._fn) ? `myoperator-file:${str(d._fn)}` : null),
    },
  };
}

/** "call.completed" style (full field names). */
function mapCompleted(d: any): NormalizedInteraction | null {
  const id = str(d.call_id) ?? str(d.id) ?? str(d.uid);
  if (!id) return null;
  const direction = String(d.direction ?? 'inbound').toLowerCase().startsWith('out') ? 'outbound' : 'inbound';
  const occurredAt = toDate(d.started_at) ?? toDate(d.start_time) ?? toDate(d.occurred_at) ?? new Date();
  const endedAt = toDate(d.ended_at) ?? toDate(d.end_time);
  const duration = toSeconds(d.duration_seconds ?? d.talk_time_seconds ?? d.duration);
  const agentRaw = d.agent ?? null;
  const agent = typeof agentRaw === 'string' ? { name: agentRaw } : agentRaw;
  const customerNumber = direction === 'inbound' ? str(d.from ?? d.caller_number ?? d.customer_number) : str(d.to ?? d.customer_number);
  const connected = toDate(d.connected_at);
  return {
    sourcePlatform: 'myoperator',
    sourceRecordId: id,
    channel: 'call',
    direction,
    occurredAt,
    endedAt,
    customer: { phone: customerNumber, name: str(d.customer_name ?? d.caller_name) },
    agent: agent ? { externalId: str(agent.id ?? agent.uuid), name: str(agent.name), email: str(agent.email) } : undefined,
    call: {
      status: mapCallStatus(d.status, duration),
      durationSeconds: duration,
      ringSeconds: connected ? Math.max(0, Math.round((connected.getTime() - occurredAt.getTime()) / 1000)) : toSeconds(d.ring_duration),
      fromNumber: str(d.from),
      toNumber: str(d.to),
      recordingRef: httpUrl(d.recording_url ?? d.recording_link) ?? (str(d.recording_filename) ? `myoperator-file:${str(d.recording_filename)}` : null),
    },
  };
}

/** Webhook v2 "call.end" / "call.summary" (data nested under data/payload, envelope carries session_id). */
function mapV2(env: any): NormalizedInteraction | null {
  const d = env.data ?? env.payload ?? env;
  const id = str(env.session_id) ?? str(d.session_id) ?? str(d.id);
  if (!id) return null;
  const legs: any[] = Array.isArray(d.legs) ? d.legs : [];
  const answered = legs.find((l) => String(l?.dial_status ?? '').toUpperCase() === 'ANSWER') ?? legs.find((l) => l?.agent) ?? null;
  const agent = answered?.agent ?? null;
  const duration = toSeconds(d.duration ?? d.talk_duration ?? answered?.talk_duration);
  const occurredAt = toDate(d.started_at ?? env.started_at ?? env.timestamp ?? env.created_at) ?? new Date();
  const direction = String(d.direction ?? env.direction ?? 'inbound').toLowerCase().startsWith('out') ? 'outbound' : 'inbound';
  return {
    sourcePlatform: 'myoperator',
    sourceRecordId: id,
    channel: 'call',
    direction,
    occurredAt,
    endedAt: toDate(d.ended_at ?? env.ended_at),
    customer: { phone: str(env.customer_identifier ?? d.customer_identifier) },
    agent: agent ? { externalId: str(agent.uuid ?? agent.id), name: str(agent.name), email: str(agent.email) } : undefined,
    call: {
      status: mapCallStatus(d.status, duration),
      durationSeconds: duration,
      ringSeconds: toSeconds(answered?.ring_duration),
      fromNumber: direction === 'inbound' ? str(env.customer_identifier) : str(agent?.contact),
      toNumber: direction === 'inbound' ? str(agent?.contact) : str(env.customer_identifier),
      recordingRef: httpUrl(d.recording_url) ?? (str(d.recording_filename) ? `myoperator-file:${str(d.recording_filename)}` : null),
    },
  };
}

/**
 * Search Logs document (POST developers.myoperator.co/search → data.hits[]._source), as returned by the live API:
 * allcaller_id (per-caller id), caller_number, start_time/end_time (unix s), duration "hh:mm:ss", type (1 in / 2 out),
 * status, filename/fileurl, additional_parameters[{ky:"unique_id",vl}], log_details[] (agent legs).
 */
function mapSearchDoc(d: any): NormalizedInteraction | null {
  const occurredAt = toDate(d.start_time) ?? toDate(d._ms);
  const id = kv(d.additional_parameters, 'unique_id') ?? (str(d.allcaller_id) && occurredAt ? `${str(d.allcaller_id)}-${Math.floor(occurredAt.getTime() / 1000)}` : null);
  if (!id || !occurredAt) return null;
  const direction = String(d.type ?? '1') === '2' ? 'outbound' : 'inbound';
  const endedAt = toDate(d.end_time);
  const duration = toSeconds(d.duration) ?? (endedAt ? Math.max(0, Math.round((endedAt.getTime() - occurredAt.getTime()) / 1000)) : null);
  const legs: any[] = Array.isArray(d.log_details) ? d.log_details : [];
  const pickAgent = (l: any) => {
    const r = Array.isArray(l?.received_by) ? l.received_by[0] : l?.received_by ?? l?.agent ?? l?._rr ?? null;
    if (!r || typeof r !== 'object') return null;
    return { id: str(r.id ?? r._id ?? r.uuid), name: str(r.name ?? r._na), email: str(r.email ?? r._em), contact: str(r.contact ?? r._ct) };
  };
  const leg = legs.find((l) => pickAgent(l) && (toSeconds(l?.duration ?? l?._dr) ?? 0) > 0) ?? legs.find((l) => pickAgent(l)) ?? null;
  const agent = leg ? pickAgent(leg) : null;
  const caller = str(d.caller_number) ?? str(d.caller_number_raw);
  return {
    sourcePlatform: 'myoperator',
    sourceRecordId: id,
    channel: 'call',
    direction,
    occurredAt,
    endedAt,
    customer: { phone: caller, name: str(d.caller_name ?? d.name), externalId: str(d.allcaller_id) },
    agent: agent ? { externalId: agent.id, name: agent.name, email: agent.email } : undefined,
    status: str(d.department_name),
    call: {
      status: mapCallStatus(d.status, duration),
      durationSeconds: duration,
      ringSeconds: null,
      fromNumber: direction === 'inbound' ? caller : agent?.contact ?? null,
      toNumber: direction === 'inbound' ? agent?.contact ?? null : caller,
      recordingRef: str(d.filename) ? `myoperator-file:${str(d.filename)}` : httpUrl(d.fileurl),
    },
  };
}

/** Accepts any of the documented MyOperator call-log shapes. Pure. */
export function mapMyOperatorCall(d: any): NormalizedInteraction | null {
  if (!d || typeof d !== 'object') return null;
  if ('_ai' in d || '_cr' in d || '_cl' in d || '_pm' in d || '_ld' in d) return mapLegacy(d);
  if ('allcaller_id' in d || ('caller_number' in d && 'start_time' in d && ('fileurl' in d || 'log_details' in d))) return mapSearchDoc(d);
  const ev = String(d.event ?? d.event_type ?? '');
  if (ev.startsWith('call.') && ev !== 'call.completed') {
    if (ev !== 'call.end' && ev !== 'call.summary') return null; // initiated / answered etc. — wait for the end event
    return mapV2(d);
  }
  if ('session_id' in d && (d.data || d.payload)) return mapV2(d);
  return mapCompleted(d);
}

/** Decode the webhook body: JSON, form-encoded `myoperator=<json>`, or form fields. */
export function decodeMyOperatorBody(rawBody: string, contentType: string | undefined, query: Record<string, string> = {}): any {
  const ct = (contentType ?? '').toLowerCase();
  const tryJson = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  if (!ct.includes('x-www-form-urlencoded')) {
    const j = tryJson(rawBody);
    if (j) return typeof j.myoperator === 'string' ? tryJson(j.myoperator) ?? j : j.myoperator ?? j;
  }
  const form = new URLSearchParams(rawBody);
  const mo = form.get('myoperator') ?? query.myoperator;
  if (mo) return tryJson(mo);
  const obj: Record<string, string> = {};
  form.forEach((v, k) => { obj[k] = v; });
  return Object.keys(obj).length ? obj : tryJson(rawBody);
}

/** Extract call-log documents from a search response, tolerating the shapes seen in docs/integrations. */
export function extractLogDocs(r: any): any[] {
  const candidates = [r?.data?.hits, r?.hits?.hits, r?.data?.data, r?.data?.logs, r?.data, r?.logs, r?.result, r];
  for (const c of candidates) {
    if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && x._source ? x._source : x));
  }
  return [];
}

function logsUrl(ctx: ProviderContext) {
  const path = str(ctx.config.logsPath) ?? DEFAULT_LOGS_PATH;
  const u = new URL(`${trimBase(ctx.config.apiBaseUrl, DEFAULT_BASE)}${path.startsWith('/') ? path : `/${path}`}`);
  u.searchParams.set('token', (ctx.secrets.apiToken ?? '').trim());
  return u.toString();
}

/**
 * "Search Logs" is documented as POST (MyOperator Postman collection → Call APIs), with the Calling API token
 * accepted as a query or body parameter. We send it in both, with the search params as a form body.
 */
async function searchLogs(ctx: ProviderContext, params: Record<string, string | number>) {
  const form: Record<string, string> = { token: (ctx.secrets.apiToken ?? '').trim() };
  for (const [k, v] of Object.entries(params)) form[k] = String(v);
  return postForm<any>(logsUrl(ctx), form, 'MyOperator');
}

async function testConnection(ctx: ProviderContext) {
  if (!ctx.secrets.apiToken) {
    if (ctx.secrets.webhookKey || ctx.secrets.webhookSigningSecret) {
      return { ok: false, message: 'No API token saved, so the API cannot be tested (webhook-only mode). Register the webhook in MyOperator and place a test call — the connection is marked connected after the first authenticated webhook arrives.', details: { pending: true } };
    }
    return { ok: false, message: 'Add the MyOperator API token (Manage → API integration → Public API token) and/or a webhook shared key.' };
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    const r = await searchLogs(ctx, { from: now - 86400, to: now, page_size: 1, log_from: 0 });
    if (r && (r.status === 'error' || r.status === 'fail')) return { ok: false, message: `MyOperator rejected the request: ${String(r.message ?? r.code ?? 'unknown error').slice(0, 200)}` };
    return { ok: true, message: `MyOperator API reachable · ${extractLogDocs(r).length ? 'call logs returned' : 'no calls in the last 24 h'}.` };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

/** Checkpoint: { from: unix s, offset: n, high: unix s }. */
async function fetchSince(ctx: ProviderContext, cp: Record<string, any>, opts: { from?: Date }): Promise<FetchResult> {
  if (!ctx.secrets.apiToken) return { records: [], hasMore: false, checkpoint: cp }; // webhook-only
  const now = Math.floor(Date.now() / 1000);
  const from = Number(cp.from ?? (opts.from ? Math.floor(opts.from.getTime() / 1000) : now - 86400));
  const offset = Number(cp.offset ?? 0);
  const to = Number(cp.to ?? now);
  const r = await searchLogs(ctx, { from, to, page_size: PAGE_SIZE, log_from: offset });
  if (r && (r.status === 'error' || r.status === 'fail')) throw new Error(`MyOperator rejected the request: ${String(r.message ?? r.code ?? '').slice(0, 200)}`);
  const docs = extractLogDocs(r);
  const records = docs.map(mapMyOperatorCall).filter((x): x is NormalizedInteraction => !!x);
  let high = Number(cp.high ?? from);
  for (const rec of records) high = Math.max(high, Math.floor(rec.occurredAt.getTime() / 1000));
  if (docs.length >= PAGE_SIZE) return { records, hasMore: true, checkpoint: { from, to, offset: offset + docs.length, high } };
  return { records, hasMore: false, checkpoint: { from: Math.max(from, Math.min(high, to) - 300) } }; // 5-min overlap
}

function verify(ctx: ProviderContext, input: WebhookInput): boolean {
  const h = lowerHeaders(input.headers);
  if (ctx.secrets.webhookSigningSecret && h['x-webhook-signature']) {
    const sig = h['x-webhook-signature'].replace(/^sha256=/, '').trim();
    return safeEqual(sig, hmacSha256Hex(ctx.secrets.webhookSigningSecret, input.rawBody));
  }
  const headerName = (str(ctx.config.webhookHeader) ?? 'X-Webhook-Token').toLowerCase();
  if (checkSharedKey(input, ctx.secrets.webhookKey, [headerName, 'x-rsi-webhook-key'])) return true;
  // Basic auth configured in MyOperator's webhook "Credentials": password = shared key.
  const auth = h.authorization ?? '';
  if (ctx.secrets.webhookKey && auth.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
    const pw = decoded.slice(decoded.indexOf(':') + 1);
    return safeEqual(pw, ctx.secrets.webhookKey);
  }
  return false;
}

async function handleWebhook(ctx: ProviderContext, input: WebhookInput): Promise<WebhookResult> {
  if (!verify(ctx, input)) return { verified: false, events: [] };
  const h = lowerHeaders(input.headers);
  const raw = input.method === 'GET' ? '' : input.rawBody;
  const body = input.method === 'GET' ? (input.query.myoperator ? decodeMyOperatorBody('', undefined, input.query) : input.query) : decodeMyOperatorBody(raw, h['content-type'], input.query);
  const rec = mapMyOperatorCall(body);
  const eventId = str(body?.event_id) ?? str(body?.id && body?.event ? `${body.event}:${body.id}` : null);
  const key = eventId ? `event:${eventId}` : rec ? `call:${rec.sourceRecordId}:${rec.call?.status}:${rec.call?.recordingRef ? 'rec' : 'norec'}` : `body:${sha256Hex(raw || JSON.stringify(input.query))}`;
  return { verified: true, response: { status: 200, body: 'ok', contentType: 'text/plain' }, events: [{ key, records: rec ? [rec] : [] }] };
}

export const myoperatorProvider: ProviderDefinition = {
  id: 'myoperator',
  name: 'MyOperator',
  category: 'calls',
  description: 'Import MyOperator call logs and recording links for transcription and quality analysis.',
  docsUrl: 'https://myoperator.com/api/',
  authType: 'token',
  configFields: [
    { key: 'apiBaseUrl', label: 'API base URL', type: 'url', placeholder: DEFAULT_BASE, help: 'Default https://developers.myoperator.co.' },
    { key: 'logsPath', label: 'Call-log search path', type: 'text', placeholder: DEFAULT_LOGS_PATH, help: 'Path of the call-log search endpoint on your account (confirm in MyOperator → API integration docs).' },
    { key: 'webhookHeader', label: 'Webhook auth header name', type: 'text', placeholder: 'X-Webhook-Token', help: 'The custom header you add to the after-call webhook in MyOperator; its value must equal the shared key.' },
  ],
  secretFields: [
    { key: 'apiToken', label: 'Calling API token', type: 'password', help: 'MyOperator panel → Manage → API Integration → Calling API Token (not the WhatsApp/WABA key or the OBD x-api-key). Needed for scheduled sync / historical import.' },
    { key: 'webhookKey', label: 'Webhook shared key', type: 'password', help: 'Long random string. Send it as the custom header above, as ?key=… on the URL, or as the Basic-auth password.' },
    { key: 'webhookSigningSecret', label: 'Webhook signing secret (optional)', type: 'password', help: 'Only if HMAC signing (X-Webhook-Signature) is enabled for your webhook.' },
  ],
  scopes: [
    { key: 'call_logs.read', label: 'Call logs (read)', description: 'Call id, direction, caller number, agent, start/end time, duration and status.' },
    { key: 'recordings.read', label: 'Call recording links', description: 'Recording URL / file name when recording is enabled on your plan (links expire after 24 h).' },
    { key: 'after_call_webhook', label: 'After-call webhook', description: 'Real-time call log delivered when each call ends.' },
  ],
  dataImported: [
    'Call metadata: direction, start/end time, duration, answered / missed / voicemail',
    'Customer phone number (stored hashed for matching; shown masked) and handling agent',
    'Recording link or file reference for authorised transcription (recordings are fetched server-side only)',
  ],
  setupSteps: [
    'Generate a webhook shared key (any long random string), paste it into "Webhook shared key" here and Save.',
    'In MyOperator → Webhooks (after-call / Call logs), add a webhook with the Webhook URL from this card, method POST, and a custom header named as in "Webhook auth header name" (default X-Webhook-Token) whose value is the shared key. Map "Recording URL" if your panel offers field mapping.',
    'For scheduled sync and historical import, copy the Public API token from Manage → API integration and Save. APIs are not available on Lite plans.',
    'Click Test connection. In webhook-only mode, place a test call — the card turns Connected once the first authenticated webhook is received.',
  ],
  supportsWebhook: true,
  supportsPolling: true,
  limitations: [
    'MyOperator documents several webhook payload generations (legacy short-key call log, "call.completed", Webhook v2 "call.end"); all three are accepted. In-progress events (call.initiated / answered) are ignored until the call ends.',
    'Call logs are read with Search Logs (POST https://developers.myoperator.co/search, Calling API token = "Authentication" on the APIs & Webhook page). GET is not supported by MyOperator.',
    'API rate limits are low (documented 20 requests/min, 100/hour, 500/day); syncs pace themselves and back off on HTTP 429.',
    'Recording links expire after 24 hours. If only a recording file name is supplied, transcription cannot fetch it and the call is marked as having no available recording.',
    'Agents are matched by MyOperator user id/email; unknown agents are created automatically and can be assigned to a team in Team Management.',
  ],
  testConnection,
  fetchSince,
  handleWebhook,
};
