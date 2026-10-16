/**
 * Gmail adapter (Google Workspace / Gmail mailbox) — OAuth 2.0 + Gmail API, polling.
 *
 * Docs relied on:
 *  - OAuth 2.0 for web server apps (authorize https://accounts.google.com/o/oauth2/v2/auth with access_type=offline,
 *    prompt=consent; token https://oauth2.googleapis.com/token, grant_type=authorization_code | refresh_token):
 *    https://developers.google.com/identity/protocols/oauth2/web-server
 *  - users.getProfile (emailAddress, historyId): https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
 *  - users.threads.list (q = Gmail search syntax incl. after:<unix seconds>, maxResults ≤500, pageToken, nextPageToken;
 *    scope gmail.readonly): https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list
 *  - users.threads.get (format=full → messages[].{id, threadId, internalDate (ms), labelIds, payload.headers, payload.parts}):
 *    https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get
 *  - Search operators (after:/before: accept epoch seconds): https://developers.google.com/workspace/gmail/api/guides/filtering
 *  - Usage limits (per-user quota units; 429 / 403 rateLimitExceeded → exponential backoff):
 *    https://developers.google.com/workspace/gmail/api/reference/quota
 */
import type { NormalizedEmail, NormalizedInteraction, ProviderContext, ProviderDefinition, FetchResult } from './types';
import { ensureAccessToken, errorMessage, httpJson, postForm, str, type TokenResponse } from './http';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'];
const DEFAULT_QUERY = 'in:inbox -category:promotions -category:social';

function refresher(ctx: ProviderContext) {
  return (refreshToken: string) => postForm<TokenResponse>(TOKEN_URL, {
    client_id: String(ctx.config.clientId ?? ''), client_secret: ctx.secrets.clientSecret ?? '',
    refresh_token: refreshToken, grant_type: 'refresh_token',
  }, 'Google OAuth');
}

async function api<T = any>(ctx: ProviderContext, path: string): Promise<T> {
  const token = await ensureAccessToken(ctx, refresher(ctx), 'Gmail');
  return httpJson<T>(`${API}${path}`, { provider: 'Gmail API', headers: { Authorization: `Bearer ${token}` } });
}

function b64url(s: string | undefined | null): string {
  if (!s) return '';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Parse "Name <a@b.com>, c@d.com" → lowercased addresses. */
export function parseAddresses(v: string | null | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const m of v.matchAll(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) out.push(m[0].toLowerCase());
  return out;
}

function displayName(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

function walkParts(part: any, acc: { text: string[]; html: string[]; attachments: NonNullable<NormalizedEmail['attachments']> }) {
  if (!part) return;
  const mime = String(part.mimeType ?? '');
  if (part.filename && (part.body?.attachmentId || part.body?.size)) {
    acc.attachments.push({ fileName: part.filename, mimeType: mime || null, sizeBytes: Number(part.body?.size ?? 0) || null, sourceRef: part.body?.attachmentId ? `gmail-attachment:${part.body.attachmentId}` : null });
  } else if (mime === 'text/plain' && part.body?.data) acc.text.push(b64url(part.body.data));
  else if (mime === 'text/html' && part.body?.data) acc.html.push(b64url(part.body.data));
  for (const p of Array.isArray(part.parts) ? part.parts : []) walkParts(p, acc);
}

/** Strip quoted history ("On … wrote:" and ">" lines) so each email keeps only its own text. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || /^From: .+/.test(line.trim()) && out.length > 3) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Map a Gmail thread (format=full) to one normalized email interaction. Pure. */
export function mapGmailThread(thread: any, supportAddresses: string[]): NormalizedInteraction | null {
  const msgs: any[] = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!thread?.id || !msgs.length) return null;
  const support = new Set(supportAddresses.map((a) => a.toLowerCase()));
  const emails: NormalizedEmail[] = [];
  let customer: { name: string | null; email: string | null } | null = null;
  let agent: { name: string | null; email: string | null } | null = null;
  for (const m of msgs) {
    const headers: any[] = Array.isArray(m.payload?.headers) ? m.payload.headers : [];
    const hv = (n: string) => str(headers.find((h) => String(h.name).toLowerCase() === n)?.value);
    const fromRaw = hv('from');
    const from = parseAddresses(fromRaw)[0] ?? null;
    const isAgent = (from && support.has(from)) || (Array.isArray(m.labelIds) && m.labelIds.includes('SENT'));
    const acc = { text: [] as string[], html: [] as string[], attachments: [] as NonNullable<NormalizedEmail['attachments']> };
    walkParts(m.payload, acc);
    const body = acc.text.length ? acc.text.join('\n') : acc.html.length ? htmlToText(acc.html.join('\n')) : String(m.snippet ?? '');
    const sentAt = m.internalDate ? new Date(Number(m.internalDate)) : new Date(hv('date') ?? Date.now());
    emails.push({
      externalId: String(m.id),
      senderType: isAgent ? 'agent' : 'customer',
      subject: hv('subject'),
      from: fromRaw,
      to: parseAddresses(hv('to')),
      cc: parseAddresses(hv('cc')),
      sentAt,
      bodyText: stripQuoted(body).slice(0, 100_000),
      attachments: acc.attachments,
    });
    if (!isAgent && !customer) customer = { name: displayName(fromRaw), email: from };
    if (isAgent && !agent) agent = { name: displayName(fromRaw), email: from };
  }
  emails.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  if (!customer) {
    // Outbound-only thread: the customer is the first non-support recipient.
    const rcpt = emails.flatMap((e) => e.to ?? []).find((a) => !support.has(a)) ?? null;
    customer = { name: null, email: rcpt };
  }
  return {
    sourcePlatform: 'gmail',
    sourceRecordId: String(thread.id),
    channel: 'email',
    direction: emails[0].senderType === 'agent' ? 'outbound' : 'inbound',
    occurredAt: emails[0].sentAt,
    subject: emails[0].subject ?? null,
    customer: { name: customer.name, email: customer.email },
    agent: agent ? { email: agent.email, name: agent.name ?? agent.email, externalId: agent.email } : undefined,
    emails,
  };
}

function supportAddrs(ctx: ProviderContext): string[] {
  const list = String(ctx.config.supportAddresses ?? '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (ctx.config.accountEmail) list.push(String(ctx.config.accountEmail).toLowerCase());
  return list;
}

async function testConnection(ctx: ProviderContext) {
  if (!str(ctx.config.clientId) || !ctx.secrets.clientSecret) return { ok: false, message: 'Enter the Google OAuth client ID and client secret, Save, then click "Connect with Google".' };
  if (!ctx.secrets.refreshToken) return { ok: false, message: 'Not authorised yet — click "Connect with Google" and approve read-only Gmail access.', details: { pending: true } };
  try {
    const p = await api<any>(ctx, '/profile');
    return { ok: true, message: `Connected to ${p?.emailAddress ?? 'Gmail'} (${p?.threadsTotal ?? '?'} threads).`, details: { account: p?.emailAddress } };
  } catch (e) {
    return { ok: false, message: errorMessage(e) };
  }
}

/** Checkpoint: { after: unix s, pageToken?, runStart? }. */
async function fetchSince(ctx: ProviderContext, cp: Record<string, any>, opts: { from?: Date }): Promise<FetchResult> {
  const runStart = Number(cp.runStart ?? Math.floor(Date.now() / 1000));
  const after = Number(cp.after ?? (opts.from ? Math.floor(opts.from.getTime() / 1000) : runStart - 7 * 86400));
  const q = `${str(ctx.config.query) ?? DEFAULT_QUERY} after:${after}`;
  const list = await api<any>(ctx, `/threads?maxResults=25&q=${encodeURIComponent(q)}${cp.pageToken ? `&pageToken=${encodeURIComponent(cp.pageToken)}` : ''}`);
  const records: NormalizedInteraction[] = [];
  const support = supportAddrs(ctx);
  for (const t of Array.isArray(list?.threads) ? list.threads : []) {
    const full = await api<any>(ctx, `/threads/${encodeURIComponent(t.id)}?format=full`);
    const rec = mapGmailThread(full, support);
    if (rec) records.push(rec);
  }
  if (list?.nextPageToken) return { records, hasMore: true, checkpoint: { after, pageToken: list.nextPageToken, runStart } };
  return { records, hasMore: false, checkpoint: { after: runStart - 3600 } }; // 1-hour overlap; idempotent ingestion
}

export const gmailProvider: ProviderDefinition = {
  id: 'gmail',
  name: 'Gmail / Google Workspace',
  category: 'email',
  description: 'Import support email threads from a Gmail or Google Workspace mailbox (read-only).',
  docsUrl: 'https://developers.google.com/workspace/gmail/api/guides',
  authType: 'oauth2',
  configFields: [
    { key: 'clientId', label: 'OAuth client ID', type: 'text', required: true, placeholder: '…apps.googleusercontent.com' },
    { key: 'query', label: 'Mailbox filter (Gmail search)', type: 'text', placeholder: DEFAULT_QUERY, help: 'Which threads to import, in Gmail search syntax. A date filter is added automatically.' },
    { key: 'supportAddresses', label: 'Support team addresses', type: 'text', placeholder: 'support@rosierfoods.com, care@rosierfoods.com', help: 'Messages from these addresses are treated as agent replies (the connected mailbox is included automatically).' },
  ],
  secretFields: [
    { key: 'clientSecret', label: 'OAuth client secret', type: 'password', required: true },
  ],
  scopes: [
    { key: 'https://www.googleapis.com/auth/gmail.readonly', label: 'gmail.readonly', description: 'Read messages and threads. The app cannot send, delete or modify mail.' },
    { key: 'openid email', label: 'openid, email', description: 'Identify which mailbox was connected.' },
  ],
  dataImported: [
    'Email threads matching the mailbox filter: subject, sender, recipients, timestamps, plain-text body (quoted history removed)',
    'Attachment metadata (file name, type, size) — attachment contents are not downloaded',
    'Replies from the support addresses are attributed as agent messages',
  ],
  setupSteps: [
    'In Google Cloud Console, create (or pick) a project and enable the Gmail API.',
    'Configure the OAuth consent screen (Internal for Workspace) and add the scope …/auth/gmail.readonly.',
    'Create an OAuth client ID of type "Web application". Add the Authorised redirect URI shown on this card.',
    'Paste the client ID and secret here, Save, then click "Connect with Google" and sign in as the support mailbox.',
    'Test connection runs automatically after sign-in. Then enable scheduled sync and/or run a historical import.',
  ],
  supportsWebhook: false,
  supportsPolling: true,
  limitations: [
    'Polling only (Gmail push notifications require Google Cloud Pub/Sub, which is not set up by this connector). Default sync every 30 minutes.',
    'Agent identity is the sending address: replies from a shared mailbox are attributed to that mailbox, not to an individual agent.',
    'Google limits per-user API quota; the sync backs off automatically on rate-limit responses.',
  ],
  testConnection,
  fetchSince,
  oauth: {
    authorizeUrl(ctx, state, redirectUri) {
      const p = new URLSearchParams({
        client_id: String(ctx.config.clientId ?? ''), redirect_uri: redirectUri, response_type: 'code',
        scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      });
      return `${AUTH_URL}?${p.toString()}`;
    },
    async exchangeCode(ctx, code, redirectUri) {
      const t = await postForm<TokenResponse>(TOKEN_URL, {
        code, client_id: String(ctx.config.clientId ?? ''), client_secret: ctx.secrets.clientSecret ?? '',
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }, 'Google OAuth');
      if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
      const expiresAt = new Date(Date.now() + (t.expires_in ?? 3600) * 1000);
      let account: string | undefined;
      try {
        const p = await httpJson<any>(`${API}/profile`, { provider: 'Gmail API', headers: { Authorization: `Bearer ${t.access_token}` } });
        account = p?.emailAddress;
      } catch { /* test connection will report */ }
      return { secrets: { accessToken: t.access_token, refreshToken: t.refresh_token, accessTokenExpiresAt: String(expiresAt.getTime()) }, expiresAt, account };
    },
  },
};
