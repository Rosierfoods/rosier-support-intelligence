/**
 * Microsoft 365 / Outlook mail adapter — Microsoft identity platform OAuth 2.0 (v2.0 endpoints) + Microsoft Graph.
 *
 * Docs relied on:
 *  - Authorization code flow (https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize and /token;
 *    scope offline_access returns a refresh token; refresh_token grant may return a new refresh token):
 *    https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 *  - List messages (GET /me/messages, /me/mailFolders/{id}/messages; $filter/$orderby/$top(≤1000)/$select;
 *    @odata.nextLink paging; Prefer: outlook.body-content-type="text"; delegated Mail.Read needed for body —
 *    Mail.ReadBasic excludes it): https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
 *  - Message resource (conversationId, receivedDateTime, sentDateTime, from, toRecipients, ccRecipients, subject, body,
 *    hasAttachments): https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
 *  - List attachments (GET /me/messages/{id}/attachments, $select=name,contentType,size):
 *    https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0
 *  - Throttling (HTTP 429 + Retry-After): https://learn.microsoft.com/en-us/graph/throttling
 */
import type { NormalizedEmail, NormalizedInteraction, ProviderContext, ProviderDefinition, FetchResult } from './types';
import { ensureAccessToken, errorMessage, httpJson, postForm, str, type TokenResponse } from './http';
import { htmlToText, stripQuoted } from './gmail';

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const M365_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.Read'];
const SELECT = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,hasAttachments,isDraft';

function tenant(ctx: ProviderContext) {
  return encodeURIComponent(str(ctx.config.tenant) ?? 'organizations');
}
function tokenUrl(ctx: ProviderContext) {
  return `https://login.microsoftonline.com/${tenant(ctx)}/oauth2/v2.0/token`;
}

function refresher(ctx: ProviderContext) {
  return (refreshToken: string) => postForm<TokenResponse>(tokenUrl(ctx), {
    client_id: String(ctx.config.clientId ?? ''), client_secret: ctx.secrets.clientSecret ?? '',
    refresh_token: refreshToken, grant_type: 'refresh_token', scope: M365_SCOPES.join(' '),
  }, 'Microsoft identity platform');
}

async function graph<T = any>(ctx: ProviderContext, urlOrPath: string): Promise<T> {
  const token = await ensureAccessToken(ctx, refresher(ctx), 'Microsoft 365');
  const url = urlOrPath.startsWith('https://') ? urlOrPath : `${GRAPH}${urlOrPath}`;
  if (!url.startsWith(`${GRAPH}/`)) throw new Error('Unexpected paging link from Microsoft Graph');
  return httpJson<T>(url, { provider: 'Microsoft Graph', headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
}

function addr(r: any): string | null {
  return str(r?.emailAddress?.address)?.toLowerCase() ?? null;
}

/** Group a page of Graph messages by conversationId → normalized email interactions. Pure. */
export function mapGraphMessages(messages: any[], supportAddresses: string[], attachments: Record<string, NonNullable<NormalizedEmail['attachments']>> = {}): NormalizedInteraction[] {
  const support = new Set(supportAddresses.map((a) => a.toLowerCase()));
  const groups = new Map<string, any[]>();
  for (const m of messages) {
    if (!m?.id || m.isDraft) continue;
    const conv = String(m.conversationId ?? m.id);
    if (!groups.has(conv)) groups.set(conv, []);
    groups.get(conv)!.push(m);
  }
  const out: NormalizedInteraction[] = [];
  for (const [conv, msgs] of groups) {
    const emails: NormalizedEmail[] = msgs.map((m) => {
      const from = addr(m.from);
      const isAgent = !!from && support.has(from);
      const raw = String(m.body?.content ?? '');
      const text = String(m.body?.contentType ?? 'text').toLowerCase() === 'html' ? htmlToText(raw) : raw;
      return {
        externalId: String(m.id),
        senderType: isAgent ? 'agent' : 'customer',
        subject: str(m.subject),
        from: m.from?.emailAddress ? `${m.from.emailAddress.name ?? ''} <${m.from.emailAddress.address ?? ''}>`.trim() : null,
        to: (m.toRecipients ?? []).map(addr).filter(Boolean),
        cc: (m.ccRecipients ?? []).map(addr).filter(Boolean),
        sentAt: new Date(m.sentDateTime ?? m.receivedDateTime ?? Date.now()),
        bodyText: stripQuoted(text).slice(0, 100_000),
        attachments: attachments[String(m.id)] ?? [],
      } as NormalizedEmail;
    }).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    const firstCustomer = msgs.find((m) => { const f = addr(m.from); return f && !support.has(f); });
    const firstAgent = msgs.find((m) => { const f = addr(m.from); return f && support.has(f); });
    const customerEmail = firstCustomer ? addr(firstCustomer.from) : emails.flatMap((e) => e.to ?? []).find((a) => !support.has(a)) ?? null;
    out.push({
      sourcePlatform: 'm365',
      sourceRecordId: conv,
      channel: 'email',
      direction: emails[0]?.senderType === 'agent' ? 'outbound' : 'inbound',
      occurredAt: emails[0]?.sentAt ?? new Date(),
      subject: emails[0]?.subject ?? null,
      customer: { email: customerEmail, name: str(firstCustomer?.from?.emailAddress?.name) },
      agent: firstAgent ? { email: addr(firstAgent.from), name: str(firstAgent.from?.emailAddress?.name), externalId: addr(firstAgent.from) } : undefined,
      emails,
    });
  }
  return out;
}

function supportAddrs(ctx: ProviderContext): string[] {
  const list = String(ctx.config.supportAddresses ?? '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ctx.config.accountEmail) list.push(String(ctx.config.accountEmail).toLowerCase());
  return list;
}

async function testConnection(ctx: ProviderContext) {
  if (!str(ctx.config.clientId) || !ctx.secrets.clientSecret) return { ok: false, message: 'Enter the Entra app (client) ID and client secret, Save, then click "Connect with Microsoft".' };
  if (!ctx.secrets.refreshToken) return { ok: false, message: 'Not authorised yet — click "Connect with Microsoft" and approve read-only mail access.', details: { pending: true } };
  try {
    const me = await graph<any>(ctx, '/me?$select=displayName,mail,userPrincipalName');
    await graph<any>(ctx, '/me/messages?$top=1&$select=id');
    return { ok: true, message: `Connected to ${me?.mail ?? me?.userPrincipalName ?? 'mailbox'}.`, details: { account: me?.mail ?? me?.userPrincipalName } };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

/** Checkpoint: { since: ISO, next?: @odata.nextLink, high?: ISO }. */
async function fetchSince(ctx: ProviderContext, cp: Record<string, any>, opts: { from?: Date }): Promise<FetchResult> {
  const since = String(cp.since ?? (opts.from ?? new Date(Date.now() - 7 * 86400_000)).toISOString());
  const folder = str(ctx.config.mailFolder) ?? 'all';
  const basePath = folder === 'all' ? '/me/messages' : `/me/mailFolders/${encodeURIComponent(folder)}/messages`;
  const first = `${basePath}?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$orderby=receivedDateTime asc&$top=50&$select=${SELECT}`;
  const r = await graph<any>(ctx, cp.next ? String(cp.next) : first);
  const msgs: any[] = Array.isArray(r?.value) ? r.value : [];
  const attachments: Record<string, NonNullable<NormalizedEmail['attachments']>> = {};
  for (const m of msgs.filter((x) => x.hasAttachments).slice(0, 25)) {
    try {
      const a = await graph<any>(ctx, `/me/messages/${encodeURIComponent(m.id)}/attachments?$select=name,contentType,size`);
      attachments[m.id] = (a?.value ?? []).map((x: any) => ({ fileName: str(x.name), mimeType: str(x.contentType), sizeBytes: Number(x.size) || null, sourceRef: `m365-attachment:${m.id}/${x.id}` }));
    } catch { /* metadata only; skip on error */ }
  }
  let high = String(cp.high ?? since);
  for (const m of msgs) if (m.receivedDateTime && m.receivedDateTime > high) high = m.receivedDateTime;
  const records = mapGraphMessages(msgs, supportAddrs(ctx), attachments);
  if (r?.['@odata.nextLink']) return { records, hasMore: true, checkpoint: { since, next: r['@odata.nextLink'], high } };
  const overlap = new Date(new Date(high).getTime() - 120_000).toISOString();
  return { records, hasMore: false, checkpoint: { since: overlap > since ? overlap : since } };
}

export const m365Provider: ProviderDefinition = {
  id: 'm365',
  name: 'Microsoft 365 / Outlook',
  category: 'email',
  description: 'Import support email conversations from an Exchange Online / Outlook mailbox (read-only).',
  docsUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0',
  authType: 'oauth2',
  configFields: [
    { key: 'clientId', label: 'Application (client) ID', type: 'text', required: true },
    { key: 'tenant', label: 'Tenant', type: 'text', placeholder: 'organizations', help: 'Your Directory (tenant) ID, or "organizations" for any work account.' },
    { key: 'mailFolder', label: 'Mail folder', type: 'select', options: [{ value: 'all', label: 'All folders (includes Sent Items — recommended)' }, { value: 'inbox', label: 'Inbox only' }] },
    { key: 'supportAddresses', label: 'Support team addresses', type: 'text', placeholder: 'support@rosierfoods.com', help: 'Messages from these addresses are agent replies (the connected mailbox is included automatically).' },
  ],
  secretFields: [
    { key: 'clientSecret', label: 'Client secret (value)', type: 'password', required: true },
  ],
  scopes: [
    { key: 'Mail.Read', label: 'Mail.Read (delegated)', description: 'Read mail in the connected mailbox. Cannot send or delete.' },
    { key: 'User.Read', label: 'User.Read', description: 'Identify which mailbox was connected.' },
    { key: 'offline_access', label: 'offline_access', description: 'Keep syncing without re-signing in (refresh token, stored encrypted).' },
  ],
  dataImported: [
    'Messages grouped into conversations: subject, sender, recipients, timestamps, plain-text body (quoted history removed)',
    'Attachment metadata (name, type, size) — contents are not downloaded',
    'Replies from the support addresses are attributed as agent messages',
  ],
  setupSteps: [
    'In Microsoft Entra admin center → App registrations → New registration (accounts in this organisational directory).',
    'Add a Web redirect URI: the Authorised redirect URI shown on this card.',
    'API permissions → Microsoft Graph → Delegated: Mail.Read, User.Read, offline_access (grant admin consent if required).',
    'Certificates & secrets → New client secret; paste its Value and the Application (client) ID here, set the tenant, Save.',
    'Click "Connect with Microsoft" and sign in as the support mailbox. Then enable scheduled sync / historical import.',
  ],
  supportsWebhook: false,
  supportsPolling: true,
  limitations: [
    'Polling only (Graph change notifications need a public HTTPS endpoint and subscription renewal; not set up by this connector).',
    'Agent identity is the sending address: a shared mailbox is attributed to the mailbox, not an individual agent.',
    'Microsoft Graph throttles per mailbox; HTTP 429 responses are retried after Retry-After.',
  ],
  testConnection,
  fetchSince,
  oauth: {
    authorizeUrl(ctx, state, redirectUri) {
      const p = new URLSearchParams({
        client_id: String(ctx.config.clientId ?? ''), response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
        scope: M365_SCOPES.join(' '), state, prompt: 'select_account',
      });
      return `https://login.microsoftonline.com/${tenant(ctx)}/oauth2/v2.0/authorize?${p.toString()}`;
    },
    async exchangeCode(ctx, code, redirectUri) {
      const t = await postForm<TokenResponse>(tokenUrl(ctx), {
        client_id: String(ctx.config.clientId ?? ''), client_secret: ctx.secrets.clientSecret ?? '', code,
        redirect_uri: redirectUri, grant_type: 'authorization_code', scope: M365_SCOPES.join(' '),
      }, 'Microsoft identity platform');
      if (!t.refresh_token) throw new Error('Microsoft did not return a refresh token (offline_access missing).');
      const expiresAt = new Date(Date.now() + (t.expires_in ?? 3600) * 1000);
      let account: string | undefined;
      try {
        const me = await httpJson<any>(`${GRAPH}/me?$select=mail,userPrincipalName`, { provider: 'Microsoft Graph', headers: { Authorization: `Bearer ${t.access_token}` } });
        account = me?.mail ?? me?.userPrincipalName;
      } catch { /* reported by test */ }
      return { secrets: { accessToken: t.access_token, refreshToken: t.refresh_token, accessTokenExpiresAt: String(expiresAt.getTime()) }, expiresAt, account };
    },
  },
};
