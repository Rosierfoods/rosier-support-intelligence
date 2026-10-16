/**
 * Server-side HTTP helper for provider adapters.
 *
 * - Timeouts on every request.
 * - Errors never contain secrets: query strings are stripped from URLs in messages (MyOperator puts its
 *   token in the query string) and response bodies are trimmed.
 * - HTTP 429 / 5xx become RetryableError (with Retry-After honoured) so the job queue backs off.
 * - Network failures become a readable message, e.g. "Could not reach api.example.com: ENOTFOUND".
 */
import { safeEqual as _safeEqual } from '@/lib/crypto';

export class ProviderHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

/** Temporary failure: the caller should retry later (rate limit, provider outage, network blip). */
export class RetryableError extends Error {
  retryable = true as const;
  retryAfterMs: number;
  constructor(message: string, retryAfterMs = 60_000) {
    super(message);
    this.name = 'RetryableError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the provider';
  }
}

/** URL without query string / credentials, safe to show in an error. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return 'the provider URL';
  }
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(1, n) * 1000;
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.max(1000, d - Date.now());
}

/** Strip anything that looks like a token from a provider error body before showing it. */
export function scrubText(s: string, max = 300): string {
  return s
    .replace(/(access_token|refresh_token|api_access_token|token|client_secret|password|apikey|api_key)(["'=:\s]+)[^"'&\s,}]+/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function providerMessage(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return scrubText(body, 200);
  const b = body as any;
  const m = b?.error?.message ?? b?.error_description ?? b?.message ?? b?.error ?? b?.errors?.[0]?.message ?? b?.errors?.[0];
  return typeof m === 'string' ? scrubText(m, 200) : '';
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  /** Human name used in error messages, e.g. "LimeChat". */
  provider?: string;
}

/** Fetch JSON with timeout + friendly errors. Throws ProviderHttpError / RetryableError. */
export async function httpJson<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  const name = opts.provider ?? safeHost(url);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { Accept: 'application/json', ...(opts.headers ?? {}) },
      body: opts.body,
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    throw new RetryableError(networkMessage(url, e), 120_000);
  }
  const text = await res.text().catch(() => '');
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (res.ok) return body as T;
  const detail = providerMessage(body);
  if (res.status === 429) {
    throw new RetryableError(`${name} rate limit reached (HTTP 429)${detail ? `: ${detail}` : ''}. Will retry later.`,
      parseRetryAfter(res.headers.get('retry-after')) ?? 60_000);
  }
  if (res.status >= 500) {
    throw new RetryableError(`${name} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}.`, parseRetryAfter(res.headers.get('retry-after')) ?? 120_000);
  }
  const hint = res.status === 401 ? ' — the credentials were rejected (check the token / re-authorise).'
    : res.status === 403 ? ' — the credentials lack the required permission/scope.'
    : res.status === 404 ? ` — endpoint or account not found (${safeUrl(url)}). Check the base URL and account ID.` : '.';
  throw new ProviderHttpError(`${name} returned HTTP ${res.status}${detail ? ` (${detail})` : ''}${hint}`, res.status);
}

export function networkMessage(url: string, e: unknown): string {
  const err = e as any;
  const code = err?.cause?.code ?? err?.code ?? (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timed out' : null);
  const reason = code ?? scrubText(String(err?.cause?.message ?? err?.message ?? 'network error'), 120);
  return `Could not reach ${safeHost(url)}: ${reason}`;
}

/** Turn any thrown value into a short, secret-free message for UI / logs. */
export function errorMessage(e: unknown, max = 500): string {
  if (e instanceof ProviderHttpError || e instanceof RetryableError) return e.message.slice(0, max);
  const msg = (e as any)?.message ?? String(e);
  return scrubText(String(msg), max);
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────── OAuth helpers (Google / Microsoft) ─────────────────────────

export interface TokenResponse { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }

export async function postForm<T = any>(url: string, form: Record<string, string>, provider: string): Promise<T> {
  return httpJson<T>(url, {
    method: 'POST',
    provider,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

/**
 * Return a valid access token, refreshing with the stored refresh token when it is missing or about to expire.
 * Refreshed tokens are persisted (encrypted) via ctx.updateSecrets.
 */
export async function ensureAccessToken(
  ctx: { secrets: Record<string, string>; updateSecrets?: (patch: Record<string, string>, exp?: Date | null) => Promise<void> },
  refresh: (refreshToken: string) => Promise<TokenResponse>,
  provider: string,
): Promise<string> {
  const exp = Number(ctx.secrets.accessTokenExpiresAt ?? 0);
  if (ctx.secrets.accessToken && exp - Date.now() > 90_000) return ctx.secrets.accessToken;
  if (!ctx.secrets.refreshToken) {
    throw new ProviderHttpError(`${provider} is not authorised yet (no refresh token). Click "Connect" to sign in.`, 401);
  }
  const t = await refresh(ctx.secrets.refreshToken);
  const expiresAt = new Date(Date.now() + (t.expires_in ?? 3600) * 1000);
  const patch: Record<string, string> = { accessToken: t.access_token, accessTokenExpiresAt: String(expiresAt.getTime()) };
  if (t.refresh_token) patch.refreshToken = t.refresh_token; // Microsoft may rotate refresh tokens
  Object.assign(ctx.secrets, patch);
  if (ctx.updateSecrets) await ctx.updateSecrets(patch, expiresAt);
  return t.access_token;
}

// ───────────────────────── Small parsing helpers shared by adapters ─────────────────────────

/** Accepts unix seconds, unix ms, ISO strings and "YYYY-MM-DD HH:mm:ss" (assumed IST when no zone). */
export function toDate(v: unknown, assumeTz = '+05:30'): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,13}(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    let s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = s.replace(' ', 'T') + assumeTz;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** "00:03:12" | "3:12" | 192 | "192" → seconds. */
export function toSeconds(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
  return null;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function trimBase(url: string | undefined | null, fallback: string): string {
  return (str(url) ?? fallback).replace(/\/+$/, '');
}

export function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

// ───────────────────────── Webhook shared-key check (providers without signing) ─────────────────────────

/**
 * Checks a shared secret supplied either as a header (name configurable) or as the `key` query parameter.
 * Constant-time comparison. Returns false when no expected key is configured.
 */
export function checkSharedKey(
  input: { headers: Record<string, string>; query: Record<string, string> },
  expected: string | undefined | null,
  headerNames: string[] = ['x-rsi-webhook-key'],
): boolean {
  if (!expected) return false;
  const h = lowerHeaders(input.headers);
  const candidates = [...headerNames.map((n) => h[n.toLowerCase()]), input.query.key];
  return candidates.some((c) => typeof c === 'string' && c.length > 0 && _safeEqual(c, expected));
}
