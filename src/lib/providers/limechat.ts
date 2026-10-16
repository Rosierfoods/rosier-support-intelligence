/**
 * LimeChat adapter (Chatwoot-compatible Application API + webhooks).
 *
 * Docs relied on:
 *  - LimeChat's own integration docs show its account API at
 *    https://app.limechat.ai/api/v1/accounts/{account_id}/... authenticated with the `api_access_token` header —
 *    the Chatwoot Application API pattern:
 *    https://moengage.com/docs/partner-guide/support-and-service/conversational-messaging/limechat
 *  - Chatwoot API (the API LimeChat's account endpoints follow):
 *    List conversations  GET /api/v1/accounts/{account_id}/conversations?status=all&page=N
 *      → data.meta.*_count, data.payload[] {id, status, created_at, last_activity_at, inbox_id, meta.sender, meta.assignee, meta.channel}
 *      https://developers.chatwoot.com/api-reference/conversations/conversations-list
 *    Conversation messages GET /api/v1/accounts/{account_id}/conversations/{id}/messages[?before=<message id>]
 *      → payload[] {id, content, message_type 0 incoming | 1 outgoing | 2 activity | 3 template, created_at (unix s),
 *        private, sender_type Contact|User|AgentBot, sender, attachments}
 *      https://developers.chatwoot.com/api-reference/messages/get-messages
 *  - Chatwoot webhooks (events message_created, message_updated, conversation_created, conversation_status_changed,
 *    conversation_updated; signature header X-Chatwoot-Signature = "sha256=" + HMAC-SHA256(secret, "{X-Chatwoot-Timestamp}.{raw body}")):
 *    https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks
 *
 * Assumptions (shown to admins in `limitations`): LimeChat accounts expose the Chatwoot-compatible endpoints above
 * (base URL configurable); conversation lists are returned most-recent-activity first (Chatwoot default), which the
 * incremental sync relies on to stop paging; if your LimeChat webhook does not sign requests, a shared key is used.
 */
import type { NormalizedInteraction, NormalizedMessage, ProviderContext, ProviderDefinition, WebhookInput, WebhookResult, FetchResult } from './types';
import { hmacSha256Hex, safeEqual, sha256Hex } from '@/lib/crypto';
import { checkSharedKey, errorMessage, httpJson, lowerHeaders, sleep, str, toDate, trimBase } from './http';

const DEFAULT_BASE = 'https://app.limechat.ai';
const MAX_MESSAGES_PER_CONVERSATION = 1000;

function base(ctx: ProviderContext) {
  return `${trimBase(ctx.config.baseUrl, DEFAULT_BASE)}/api/v1/accounts/${encodeURIComponent(String(ctx.config.accountId ?? ''))}`;
}
function headers(ctx: ProviderContext) {
  return { api_access_token: ctx.secrets.apiAccessToken ?? '' };
}

export function verifyChatwootSignature(secret: string, rawBody: string, sigHeader?: string, tsHeader?: string, nowMs = Date.now()): boolean {
  if (!secret || !sigHeader || !tsHeader) return false;
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false; // 5-minute replay window
  const expected = 'sha256=' + hmacSha256Hex(secret, `${tsHeader}.${rawBody}`);
  return safeEqual(sigHeader.trim(), expected);
}

function senderTypeOf(m: any): NormalizedMessage['senderType'] | null {
  if (m?.private) return null; // internal agent notes are not part of the customer conversation
  const t = m?.message_type;
  const st = String(m?.sender_type ?? m?.sender?.type ?? '').toLowerCase();
  if (t === 2 || t === 'activity') return 'system';
  if (t === 0 || t === 'incoming') return 'customer';
  if (st.includes('bot') || st.includes('captain')) return 'bot';
  if (t === 3 || t === 'template') return 'bot';
  if (t === 1 || t === 'outgoing') return m?.sender || m?.sender_id ? 'agent' : 'bot'; // outgoing without a user = automation
  if (st === 'contact') return 'customer';
  if (st === 'user') return 'agent';
  return null;
}

export function mapChatwootMessage(m: any): NormalizedMessage | null {
  if (!m || m.id === undefined || m.id === null) return null;
  const senderType = senderTypeOf(m);
  if (!senderType) return null;
  const atts = Array.isArray(m.attachments) ? m.attachments : m.attachment ? [m.attachment] : [];
  return {
    externalId: String(m.id),
    senderType,
    senderName: str(m.sender?.available_name ?? m.sender?.name),
    body: String(m.content ?? (atts.length ? `[${atts[0]?.file_type ?? 'attachment'}]` : '')),
    sentAt: toDate(m.created_at) ?? new Date(),
    attachments: atts.map((a: any) => ({
      fileName: str(a?.file_name ?? (a?.data_url ? String(a.data_url).split('/').pop()?.split('?')[0] : null)),
      mimeType: str(a?.content_type ?? (a?.file_type && a?.extension ? `${a.file_type}/${a.extension}` : a?.file_type)),
      sizeBytes: Number.isFinite(Number(a?.file_size)) ? Number(a.file_size) : null,
      sourceRef: str(a?.data_url),
    })),
  };
}

function resolutionOf(status: unknown): NormalizedInteraction['resolutionStatus'] | undefined {
  switch (String(status ?? '').toLowerCase()) {
    case 'resolved': return 'resolved';
    case 'pending': case 'snoozed': return 'pending';
    case 'open': return 'open';
    default: return undefined;
  }
}

/** Conversation object (list item / webhook conversation) + messages → normalized interaction. Pure. */
export function mapChatwootConversation(conv: any, messages: any[]): NormalizedInteraction | null {
  const id = conv?.display_id ?? conv?.id; // display_id is the account-scoped id used in API URLs
  if (id === undefined || id === null) return null;
  const sender = conv.meta?.sender ?? conv.contact ?? {};
  const assignee = conv.meta?.assignee ?? null;
  const channel = String(conv.meta?.channel ?? conv.channel ?? '').toLowerCase().includes('whatsapp') ? 'whatsapp' : 'chat';
  const msgs = messages.map(mapChatwootMessage).filter((m): m is NormalizedMessage => !!m).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const created = toDate(conv.created_at) ?? toDate(conv.timestamp) ?? msgs[0]?.sentAt ?? new Date();
  const status = str(conv.status);
  const resolution = resolutionOf(status);
  const firstReal = msgs.find((m) => m.senderType === 'customer' || m.senderType === 'agent');
  return {
    sourcePlatform: 'limechat',
    sourceRecordId: String(id),
    channel,
    direction: firstReal && firstReal.senderType === 'agent' ? 'outbound' : 'inbound',
    occurredAt: created,
    endedAt: resolution === 'resolved' ? toDate(conv.last_activity_at) ?? toDate(conv.timestamp) : null,
    customer: {
      name: str(sender.name),
      phone: str(sender.phone_number),
      email: str(sender.email),
      externalId: sender.id !== undefined && sender.id !== null ? String(sender.id) : null,
    },
    agent: assignee ? { externalId: assignee.id !== undefined ? String(assignee.id) : null, name: str(assignee.available_name ?? assignee.name), email: str(assignee.email) } : undefined,
    status,
    resolutionStatus: resolution,
    messages: msgs,
  };
}

async function fetchAllMessages(ctx: ProviderContext, convId: string): Promise<any[]> {
  const all: any[] = [];
  let before: number | null = null;
  for (let i = 0; i < 60 && all.length < MAX_MESSAGES_PER_CONVERSATION; i++) {
    const url = `${base(ctx)}/conversations/${encodeURIComponent(convId)}/messages${before !== null ? `?before=${before}` : ''}`;
    const r = await httpJson<any>(url, { provider: 'LimeChat', headers: headers(ctx) });
    const page: any[] = Array.isArray(r?.payload) ? r.payload : [];
    if (!page.length) break;
    all.push(...page);
    const minId = Math.min(...page.map((m) => Number(m.id)).filter(Number.isFinite));
    if (!Number.isFinite(minId) || (before !== null && minId >= before)) break;
    before = minId;
    if (page.length < 20) break; // `before` pages return up to 20; fewer means we reached the start
  }
  return all;
}

async function testConnection(ctx: ProviderContext) {
  if (!str(ctx.config.accountId)) return { ok: false, message: 'Account ID is required (the number in your LimeChat dashboard URL: /app/accounts/<id>/...).' };
  if (!ctx.secrets.apiAccessToken) return { ok: false, message: 'API access token is required.' };
  try {
    const r = await httpJson<any>(`${base(ctx)}/conversations?status=all&page=1`, { provider: 'LimeChat', headers: headers(ctx) });
    const total = r?.data?.meta?.all_count;
    if (!r?.data || !Array.isArray(r.data.payload)) {
      return { ok: false, message: 'LimeChat responded, but not in the expected Chatwoot-compatible format. Check the base URL, or ask LimeChat support which API your account uses.' };
    }
    return { ok: true, message: `Connected to LimeChat account ${ctx.config.accountId}${total !== undefined ? ` · ${total} conversations visible` : ''}.` };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

/**
 * Incremental sync. Checkpoint: { since: unix seconds, page?: n, high?: unix seconds }.
 * Walks the conversation list (most recent activity first) until conversations are older than `since`.
 */
async function fetchSince(ctx: ProviderContext, cp: Record<string, any>, opts: { from?: Date }): Promise<FetchResult> {
  const since = Number(cp.since ?? (opts.from ? Math.floor(opts.from.getTime() / 1000) : Math.floor(Date.now() / 1000) - 7 * 86400));
  const page = Number(cp.page ?? 1);
  const inbox = str(ctx.config.inboxId);
  const url = `${base(ctx)}/conversations?status=all&assignee_type=all&page=${page}${inbox ? `&inbox_id=${encodeURIComponent(inbox)}` : ''}`;
  const r = await httpJson<any>(url, { provider: 'LimeChat', headers: headers(ctx) });
  const convs: any[] = Array.isArray(r?.data?.payload) ? r.data.payload : [];
  let high = Number(cp.high ?? since);
  let reachedOld = convs.length === 0;
  const records: NormalizedInteraction[] = [];
  for (const c of convs) {
    const activity = Number(c.last_activity_at ?? c.timestamp ?? c.created_at ?? 0);
    if (activity && activity < since) { reachedOld = true; continue; }
    high = Math.max(high, activity);
    const msgs = await fetchAllMessages(ctx, String(c.id));
    const rec = mapChatwootConversation(c, msgs);
    if (rec) records.push(rec);
    await sleep(150); // be gentle with the account's API rate limit
  }
  if (reachedOld || page >= 400) {
    // Done: next run starts from the newest activity seen, with a 2-minute overlap (ingestion is idempotent).
    return { records, hasMore: false, checkpoint: { since: Math.max(since, high - 120) } };
  }
  return { records, hasMore: true, checkpoint: { since, page: page + 1, high } };
}

function verify(ctx: ProviderContext, input: WebhookInput): boolean {
  const h = lowerHeaders(input.headers);
  if (ctx.secrets.webhookSecret && h['x-chatwoot-signature']) {
    return verifyChatwootSignature(ctx.secrets.webhookSecret, input.rawBody, h['x-chatwoot-signature'], h['x-chatwoot-timestamp']);
  }
  return checkSharedKey(input, ctx.secrets.webhookKey, ['x-rsi-webhook-key']);
}

/** Parse a Chatwoot-style webhook body into normalized records. Pure. */
export function parseLimeChatWebhook(body: any): NormalizedInteraction[] {
  const event = String(body?.event ?? '');
  if (event === 'message_created' || event === 'message_updated') {
    const conv = body.conversation ?? {};
    const contactSender = String(body.sender?.type ?? '').toLowerCase() === 'contact' ? body.sender : null;
    const convObj = { ...conv, id: conv.display_id ?? conv.id, meta: conv.meta ?? { sender: body.contact ?? contactSender ?? {} } };
    const rec = mapChatwootConversation(convObj, [body]);
    return rec ? [rec] : [];
  }
  if (event.startsWith('conversation_')) {
    if (event === 'conversation_typing_on' || event === 'conversation_typing_off') return [];
    const conv = body.conversation ?? body;
    const rec = mapChatwootConversation(conv, Array.isArray(conv.messages) ? conv.messages : []);
    return rec ? [rec] : [];
  }
  return [];
}

async function handleWebhook(ctx: ProviderContext, input: WebhookInput): Promise<WebhookResult> {
  if (input.method !== 'POST') return { verified: false, response: { status: 405, body: 'Method not allowed' }, events: [] };
  if (!verify(ctx, input)) return { verified: false, events: [] };
  let body: any;
  try { body = JSON.parse(input.rawBody); } catch { return { verified: true, events: [] }; }
  const h = lowerHeaders(input.headers);
  const records = parseLimeChatWebhook(body);
  const key = h['x-chatwoot-delivery']
    ? `delivery:${h['x-chatwoot-delivery']}`
    : body?.event && body?.id !== undefined
      ? `${body.event}:${body.id}:${body.updated_at ?? body.created_at ?? sha256Hex(input.rawBody).slice(0, 16)}`
      : `body:${sha256Hex(input.rawBody)}`;
  return { verified: true, events: [{ key, records }] };
}

export const limechatProvider: ProviderDefinition = {
  id: 'limechat',
  name: 'LimeChat',
  category: 'conversations',
  description: 'Import LimeChat chat and WhatsApp conversations — full threads with agent assignment and status.',
  docsUrl: 'https://developers.chatwoot.com/api-reference/introduction',
  authType: 'api_key',
  configFields: [
    { key: 'baseUrl', label: 'API base URL', type: 'url', placeholder: DEFAULT_BASE, help: 'Default https://app.limechat.ai. Change only if LimeChat gave you a different host.' },
    { key: 'accountId', label: 'Account ID', type: 'text', required: true, placeholder: '12345', help: 'The number after /accounts/ in your LimeChat dashboard URL.' },
    { key: 'inboxId', label: 'Inbox ID (optional)', type: 'text', help: 'Limit polling to one inbox. Leave blank for all inboxes.' },
  ],
  secretFields: [
    { key: 'apiAccessToken', label: 'API access token', type: 'password', required: true, help: 'LimeChat → Profile settings → Access token (sent as the api_access_token header).' },
    { key: 'webhookSecret', label: 'Webhook signing secret (if shown)', type: 'password', help: 'Shown when the webhook is created in Settings → Integrations → Webhooks (verifies X-Chatwoot-Signature).' },
    { key: 'webhookKey', label: 'Webhook shared key (if no signing secret)', type: 'password', help: 'Any long random string; append ?key=<value> to the webhook URL you register in LimeChat.' },
  ],
  scopes: [
    { key: 'conversations.read', label: 'Read conversations', description: 'Conversation list with contact, assignee, inbox and status.' },
    { key: 'messages.read', label: 'Read messages', description: 'All public messages in each conversation (private agent notes are skipped).' },
    { key: 'webhook', label: 'Webhook events', description: 'message_created, message_updated, conversation_created, conversation_status_changed, conversation_updated.' },
  ],
  dataImported: [
    'Complete conversation threads in order, with timestamps and sender (customer / agent / bot)',
    'Assigned agent (LimeChat user id, name, email) and conversation status (open / pending / resolved)',
    'Customer name, phone and email from the LimeChat contact',
    'Attachment metadata (type, size, link reference) — files are not downloaded',
  ],
  setupSteps: [
    'In LimeChat, open Profile settings and copy your Access token. Use an administrator/agent account that can see all inboxes you want analysed.',
    'Copy the Account ID from the dashboard URL (…/app/accounts/<id>/…). Enter both here and Save, then Test connection.',
    'For real-time updates: Settings → Integrations → Webhooks → Add new webhook. Paste the Webhook URL from this card and tick message_created, message_updated, conversation_created and conversation_status_changed.',
    'If LimeChat shows a webhook secret, paste it into "Webhook signing secret". Otherwise set a "Webhook shared key" here and add ?key=<that value> to the URL you register.',
    'Enable scheduled sync (catches anything a webhook missed) and optionally run a historical import.',
  ],
  supportsWebhook: true,
  supportsPolling: true,
  limitations: [
    'Implemented against the Chatwoot-compatible Application API that LimeChat\'s account endpoints follow (/api/v1/accounts/{id}/…, api_access_token header). If your LimeChat plan uses a different API host, change the base URL; if the API is not enabled for your account, Test connection will say so.',
    'The conversation list has no "updated since" filter; incremental sync pages through conversations by most recent activity and stops at the last checkpoint.',
    'Private notes are not imported. Attachments are referenced, not copied.',
    'If webhooks are not signed for your account, requests are authenticated with a shared key in the URL instead.',
  ],
  testConnection,
  fetchSince,
  handleWebhook,
};
