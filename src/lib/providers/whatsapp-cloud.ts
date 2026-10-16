/**
 * WhatsApp Business Platform — Cloud API (Meta) adapter. Webhook-only.
 *
 * Docs relied on:
 *  - Webhooks getting started (GET hub.mode / hub.verify_token / hub.challenge; POST X-Hub-Signature-256 =
 *    "sha256=" + HMAC-SHA256(app secret, raw payload); retries for up to 36 h, so deduplicate):
 *    https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *  - WhatsApp webhooks overview / messages webhook reference (object=whatsapp_business_account,
 *    entry[].changes[].field="messages", value.metadata.{display_phone_number,phone_number_id},
 *    value.contacts[].{profile.name,wa_id}, value.messages[].{from,id,timestamp,type,text.body}, value.statuses[]):
 *    https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
 *    https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages.md
 *  - Phone number node (used by "Test connection": GET /{phone-number-id}?fields=display_phone_number,verified_name):
 *    https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account-to-number-current-status/
 *
 * Capability notes: the Cloud API has NO message-history endpoint — only messages received after the webhook is
 * subscribed are imported. Messages your business sends through the API are reported back only as delivery
 * statuses (no text), so agent replies are not visible here unless they come through another connected tool.
 */
import type { NormalizedInteraction, NormalizedMessage, ProviderContext, ProviderDefinition, WebhookInput, WebhookResult } from './types';
import { hmacSha256Hex, safeEqual, sha256Hex } from '@/lib/crypto';
import { errorMessage, httpJson, lowerHeaders, str, toDate } from './http';

const DEFAULT_GRAPH_VERSION = 'v21.0';

export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | undefined | null): boolean {
  if (!appSecret || !header) return false;
  const sig = header.trim();
  if (!sig.startsWith('sha256=')) return false;
  return safeEqual(sig.slice(7), hmacSha256Hex(appSecret, rawBody));
}

/** IST calendar day — WhatsApp messages from one customer on one day form one conversation thread. */
function istDay(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;

function messageBody(m: any): string {
  switch (m?.type) {
    case 'text': return String(m.text?.body ?? '');
    case 'button': return String(m.button?.text ?? m.button?.payload ?? '');
    case 'interactive': return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[interactive reply]');
    case 'location': return `[location] ${m.location?.name ?? ''} ${m.location?.address ?? ''}`.trim();
    case 'contacts': return '[shared contact]';
    case 'reaction': return `[reaction] ${m.reaction?.emoji ?? ''}`.trim();
    case 'unsupported': return '[unsupported message type]';
    default: {
      const media = m?.[m?.type];
      if (media) return String(media.caption ?? `[${m.type}]`);
      return `[${m?.type ?? 'message'}]`;
    }
  }
}

/** Map one parsed webhook body to normalized interactions (one per customer per IST day). Pure function. */
export function parseWhatsAppPayload(body: any, opts: { phoneNumberId?: string | null } = {}): { key: string; records: NormalizedInteraction[] }[] {
  const out: { key: string; records: NormalizedInteraction[] }[] = [];
  if (!body || typeof body !== 'object') return out;
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const v = change.value ?? {};
      const pnid = str(v.metadata?.phone_number_id);
      if (opts.phoneNumberId && pnid && pnid !== opts.phoneNumberId) continue; // another number on the same app
      const contacts = new Map<string, string | null>();
      for (const c of Array.isArray(v.contacts) ? v.contacts : []) if (c?.wa_id) contacts.set(String(c.wa_id), str(c.profile?.name));
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        if (!m?.id || !m?.from) continue;
        const sentAt = toDate(m.timestamp) ?? new Date();
        const waId = String(m.from);
        const attachments: NonNullable<NormalizedMessage['attachments']> = [];
        if ((MEDIA_TYPES as readonly string[]).includes(m.type) && m[m.type]) {
          const media = m[m.type];
          attachments.push({ fileName: str(media.filename), mimeType: str(media.mime_type), sizeBytes: null, sourceRef: media.id ? `whatsapp-media:${media.id}` : null });
        }
        const rec: NormalizedInteraction = {
          sourcePlatform: 'whatsapp_cloud',
          sourceRecordId: `${pnid ?? 'unknown'}:${waId}:${istDay(sentAt)}`,
          channel: 'whatsapp',
          direction: 'inbound',
          occurredAt: sentAt,
          customer: { name: contacts.get(waId) ?? null, phone: waId, externalId: waId },
          messages: [{ externalId: String(m.id), senderType: 'customer', senderName: contacts.get(waId) ?? null, body: messageBody(m), sentAt, attachments }],
        };
        out.push({ key: `wamid:${m.id}`, records: [rec] });
      }
      // statuses[] (sent/delivered/read for business-sent messages) carry no message text → not imported.
    }
  }
  return out;
}

async function testConnection(ctx: ProviderContext) {
  const missing = ['appSecret', 'verifyToken'].filter((k) => !ctx.secrets[k]);
  if (missing.length) return { ok: false, message: `Missing ${missing.join(' and ')}. Both are needed to verify Meta webhooks.` };
  if (!ctx.secrets.accessToken || !ctx.config.phoneNumberId) {
    return {
      ok: false,
      message: 'Webhook secrets saved. Add the Phone number ID and a system-user access token to test against the Graph API — or register the webhook in Meta; the connection is marked connected after the first signed webhook is verified.',
      details: { pending: true },
    };
  }
  const ver = str(ctx.config.graphVersion) ?? DEFAULT_GRAPH_VERSION;
  try {
    const r = await httpJson<any>(`https://graph.facebook.com/${encodeURIComponent(ver)}/${encodeURIComponent(ctx.config.phoneNumberId)}?fields=display_phone_number,verified_name`, {
      provider: 'Meta Graph API', headers: { Authorization: `Bearer ${ctx.secrets.accessToken}` },
    });
    return { ok: true, message: `Connected to ${r?.verified_name ?? 'WhatsApp number'} (${r?.display_phone_number ?? ctx.config.phoneNumberId}).` };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

async function handleWebhook(ctx: ProviderContext, input: WebhookInput): Promise<WebhookResult> {
  if (input.method === 'GET') {
    const mode = input.query['hub.mode'];
    const token = input.query['hub.verify_token'] ?? '';
    const challenge = input.query['hub.challenge'] ?? '';
    const ok = mode === 'subscribe' && !!ctx.secrets.verifyToken && safeEqual(token, ctx.secrets.verifyToken);
    return ok
      ? { verified: true, response: { status: 200, body: challenge, contentType: 'text/plain' }, events: [] }
      : { verified: false, response: { status: 403, body: 'Verification failed', contentType: 'text/plain' }, events: [] };
  }
  const h = lowerHeaders(input.headers);
  if (!verifyMetaSignature(ctx.secrets.appSecret ?? '', input.rawBody, h['x-hub-signature-256'])) {
    return { verified: false, events: [] };
  }
  let body: any;
  try { body = JSON.parse(input.rawBody); } catch { return { verified: true, events: [] }; }
  const events = parseWhatsAppPayload(body, { phoneNumberId: str(ctx.config.phoneNumberId) });
  if (!events.length) return { verified: true, events: [{ key: `body:${sha256Hex(input.rawBody)}`, records: [] }] };
  return { verified: true, events };
}

export const whatsappCloudProvider: ProviderDefinition = {
  id: 'whatsapp_cloud',
  name: 'WhatsApp Business Platform (Cloud API)',
  category: 'conversations',
  description: 'Receive WhatsApp messages sent to your business number directly from Meta, via signed webhooks.',
  docsUrl: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview',
  authType: 'token',
  configFields: [
    { key: 'phoneNumberId', label: 'Phone number ID', type: 'text', placeholder: '1234567890', help: 'WhatsApp Manager → API Setup. Only messages for this number are imported (leave blank to accept all numbers on the app).' },
    { key: 'graphVersion', label: 'Graph API version', type: 'text', placeholder: DEFAULT_GRAPH_VERSION, help: 'Used only for Test connection.' },
  ],
  secretFields: [
    { key: 'appSecret', label: 'App secret', type: 'password', required: true, help: 'Meta App Dashboard → App settings → Basic → App secret. Used to verify X-Hub-Signature-256.' },
    { key: 'verifyToken', label: 'Webhook verify token', type: 'password', required: true, help: 'Any long random string. Enter the same value in Meta → WhatsApp → Configuration → Verify token.' },
    { key: 'accessToken', label: 'System-user access token (optional)', type: 'password', help: 'Only used to test the connection (whatsapp_business_management / whatsapp_business_messaging).' },
  ],
  scopes: [
    { key: 'messages_webhook', label: 'Webhook field: messages', description: 'Subscribe the app to the "messages" webhook field for your WhatsApp Business Account.' },
    { key: 'whatsapp_business_messaging', label: 'whatsapp_business_messaging (token)', description: 'Optional, read-only use: lets "Test connection" read the phone number name.' },
  ],
  dataImported: [
    'Inbound customer messages (text, button/list replies, captions) with timestamps',
    'Customer WhatsApp number and profile name',
    'Attachment metadata (type, file name, media id) — media files are not downloaded',
  ],
  setupSteps: [
    'In Meta App Dashboard, open your app with the WhatsApp product added.',
    'Copy the App secret (App settings → Basic) into "App secret" here, invent a long verify token and paste it into "Webhook verify token", then Save.',
    'In WhatsApp → Configuration → Webhook, paste the Webhook URL shown on this card and the same verify token, then click "Verify and save" — this card shows "Verified" once Meta\'s handshake succeeds.',
    'Click "Manage" next to Webhook fields and subscribe to "messages".',
    'Optional: add the Phone number ID and a system-user token, then Test connection.',
  ],
  supportsWebhook: true,
  supportsPolling: false,
  limitations: [
    'The Cloud API has no message-history API: only messages received after the webhook is set up are imported (no historical import).',
    'Messages sent by your business through the API arrive only as delivery statuses without text, so agent replies are not captured by this connector. If agents reply via LimeChat, connect LimeChat for full threads.',
    'WhatsApp has no conversation ID for inbound messages: messages from one customer on one IST calendar day are grouped into one interaction.',
    'Meta retries failed deliveries for up to 36 hours; duplicates are ignored by message id.',
  ],
  testConnection,
  handleWebhook,
};
