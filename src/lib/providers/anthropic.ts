/**
 * Anthropic Claude — AI analysis provider (Messages API over fetch, no SDK).
 *
 * Verified against the official docs (Oct 2026):
 *   - Messages API:   https://platform.claude.com/docs/en/api/messages
 *       POST https://api.anthropic.com/v1/messages
 *       headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
 *       body: model, max_tokens, system, messages[], tools[], tool_choice
 *       response: content[] (text | tool_use{id,name,input}), stop_reason, usage{input_tokens, output_tokens}
 *   - Errors:         https://platform.claude.com/docs/en/api/errors
 *       400 invalid_request_error, 401 authentication_error, 403 permission_error, 404 not_found_error,
 *       413 request_too_large, 429 rate_limit_error (honour retry-after), 500 api_error, 529 overloaded_error;
 *       body {type:"error", error:{type,message}, request_id}; header request-id.
 *   - Models:         https://platform.claude.com/docs/en/about-claude/models/overview
 *       claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1.
 *       GET https://api.anthropic.com/v1/models/{model_id} (used for "Test connection" — no tokens spent).
 *   - Tool use:       https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use
 *       IMPORTANT: forced tool use (tool_choice {type:"tool"} / {type:"any"}) returns HTTP 400 on Claude Opus 5.5,
 *       Sonnet 5.5 and Fable 5.1. We therefore send tool_choice {type:"auto"} + `strict: true` on the tool + an explicit
 *       instruction to call it, and fall back to parsing a JSON text block if the model answers in text.
 *   - Strict tools:   https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
 *   - Schema limits:  https://platform.claude.com/docs/en/build-with-claude/structured-outputs (JSON Schema limitations:
 *       additionalProperties must be false; no minimum/maximum/minLength; ≤24 optional params; ≤16 union-typed params).
 *       A 400 "Schema is too complex" response is retried once without `strict`.
 */
import type { ProviderContext, ProviderDefinition, TestResult } from './types';
import { ProviderError, parseRetryAfter } from '@/lib/ai/errors';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export const CLAUDE_MODELS = [
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (default — speed + quality)' },
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (highest quality)' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, lowest cost)' },
  { value: 'claude-fable-5-1', label: 'Claude Fable 5.1 (demanding reasoning)' },
];

// ───────────────────────── Types ─────────────────────────
export interface ClaudeConfig {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  baseUrl?: string;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

export interface ClaudeMessageParam { role: 'user' | 'assistant'; content: string | { type: 'text'; text: string }[] }

export interface ClaudeRequest {
  system?: string;
  messages: ClaudeMessageParam[];
  tools?: ClaudeTool[];
  toolChoice?: { type: 'auto' | 'none' };
  maxTokens?: number;
  temperature?: number;
}

export interface ClaudeResponse {
  id: string;
  model: string;
  content: ClaudeContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  requestId: string | null;
}

// ───────────────────────── Config ─────────────────────────
export function claudeConfigFrom(config: Record<string, any>, secrets: Record<string, string>): ClaudeConfig {
  const apiKey = (secrets.apiKey ?? '').trim();
  if (!apiKey) throw new ProviderError('anthropic', 'Claude API key is missing. Add it on the Integrations page.', { retryable: false });
  const custom = typeof config.customModel === 'string' ? config.customModel.trim() : '';
  const model = custom || (typeof config.model === 'string' && config.model.trim()) || DEFAULT_CLAUDE_MODEL;
  if (!/^[a-z0-9][a-z0-9.\-_:]{2,80}$/i.test(model)) throw new ProviderError('anthropic', `Invalid Claude model id "${model}".`, { retryable: false });
  const maxTokens = clampInt(config.maxTokens, 1024, 32000, 8000);
  const timeoutMs = clampInt(config.timeoutSeconds, 15, 600, 180) * 1000;
  return { apiKey, model, maxTokens, timeoutMs };
}

function clampInt(v: unknown, min: number, max: number, dflt: number) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : dflt;
}

// ───────────────────────── Request building (pure; unit-tested) ─────────────────────────
export function buildMessagesRequest(cfg: ClaudeConfig, req: ClaudeRequest): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens,
    messages: req.messages,
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, ...(t.strict ? { strict: true } : {}) }));
    // Forced tool choice is rejected by Opus/Sonnet 5.5 — always 'auto' (see header).
    body.tool_choice = req.toolChoice ?? { type: 'auto' };
  }
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  return {
    url: `${cfg.baseUrl ?? ANTHROPIC_API_URL}/v1/messages`,
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body,
  };
}

/** Map an HTTP error response to a ProviderError (retryable for 408/409/429/5xx/529). Pure; unit-tested. */
export function mapAnthropicError(status: number, bodyText: string, headers: { get(n: string): string | null }): ProviderError {
  let type = '', msg = '';
  try {
    const j = JSON.parse(bodyText);
    type = j?.error?.type ?? '';
    msg = j?.error?.message ?? '';
  } catch { /* non-JSON */ }
  const requestId = headers.get('request-id') ?? undefined;
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  const safe = (msg || bodyText || '').replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted]').slice(0, 300);
  if (status === 401) return new ProviderError('anthropic', 'Claude rejected the API key (401). Update the key on the Integrations page.', { status, code: type, requestId });
  if (status === 403) return new ProviderError('anthropic', `Claude API key lacks permission for this model/resource (403). ${safe}`, { status, code: type, requestId });
  if (status === 404) return new ProviderError('anthropic', `Claude model or endpoint not found (404) — check the model id. ${safe}`, { status, code: type, requestId });
  if (status === 413) return new ProviderError('anthropic', 'Conversation is too large for one Claude request (413).', { status, code: type, requestId });
  if (status === 429) return new ProviderError('anthropic', `Claude rate limit or spend cap reached (429). ${safe}`, { status, code: type, requestId, retryable: true, retryAfterMs: retryAfterMs ?? 60_000 });
  if (status === 529) return new ProviderError('anthropic', 'Claude API is temporarily overloaded (529).', { status, code: type, requestId, retryable: true, retryAfterMs: retryAfterMs ?? 30_000 });
  if (status >= 500 || status === 408 || status === 409) return new ProviderError('anthropic', `Claude API error (${status}). ${safe}`, { status, code: type, requestId, retryable: true, retryAfterMs });
  if (status === 402) return new ProviderError('anthropic', `Claude billing error (402). ${safe}`, { status, code: type, requestId });
  return new ProviderError('anthropic', `Claude request rejected (${status} ${type}). ${safe}`, { status, code: type, requestId });
}

// ───────────────────────── HTTP ─────────────────────────
export async function createMessage(cfg: ClaudeConfig, req: ClaudeRequest, fetchImpl: typeof fetch = fetch): Promise<ClaudeResponse> {
  const { url, headers, body } = buildMessagesRequest(cfg, req);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    throw new ProviderError('anthropic', aborted ? `Claude request timed out after ${Math.round(cfg.timeoutMs / 1000)}s.` : `Could not reach the Claude API (${networkReason(e)}).`, { retryable: true, retryAfterMs: 60_000 });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw mapAnthropicError(res.status, text, res.headers);
  let j: any;
  try { j = JSON.parse(text); } catch { throw new ProviderError('anthropic', 'Claude returned a non-JSON response.', { retryable: true }); }
  return {
    id: j.id, model: j.model ?? cfg.model, content: Array.isArray(j.content) ? j.content : [],
    stopReason: j.stop_reason ?? null,
    usage: { inputTokens: Number(j.usage?.input_tokens ?? 0), outputTokens: Number(j.usage?.output_tokens ?? 0) },
    requestId: res.headers.get('request-id'),
  };
}

export function networkReason(e: any): string {
  const c = e?.cause?.code ?? e?.code;
  return c ? String(c) : (e?.message ? String(e.message).slice(0, 120) : 'network error');
}

/** Find the tool_use input for `toolName`, else try to parse a JSON object from text blocks. */
export function extractToolInput(resp: Pick<ClaudeResponse, 'content' | 'stopReason'>, toolName: string): unknown {
  for (const b of resp.content) if (b.type === 'tool_use' && (b as any).name === toolName) return (b as any).input;
  const text = resp.content.filter((b) => b.type === 'text').map((b) => (b as any).text as string).join('\n');
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (candidate && candidate.trim().startsWith('{')) {
    try { return JSON.parse(candidate); } catch { /* fall through */ }
  }
  if (resp.stopReason === 'max_tokens') throw new ProviderError('anthropic', 'Claude response was cut off (max_tokens). Increase "Max output tokens" on the Claude integration.', { retryable: false });
  if (resp.stopReason === 'refusal') throw new ProviderError('anthropic', 'Claude declined to analyse this conversation (refusal).', { retryable: false });
  throw new ProviderError('anthropic', `Claude did not return the ${toolName} tool output.`, { retryable: true, retryAfterMs: 120_000 });
}

/**
 * Call Claude with a single strict tool and return its validated-later input.
 * If the strict schema is rejected as too complex (400), retries once without `strict` (output is zod-validated by the caller anyway).
 */
export async function callClaudeTool(cfg: ClaudeConfig, req: Omit<ClaudeRequest, 'tools' | 'toolChoice'> & { tool: ClaudeTool }, fetchImpl: typeof fetch = fetch) {
  const tool = { ...req.tool, strict: req.tool.strict ?? true };
  try {
    const resp = await createMessage(cfg, { ...req, tools: [tool], toolChoice: { type: 'auto' } }, fetchImpl);
    return { resp, input: extractToolInput(resp, tool.name), strict: tool.strict };
  } catch (e) {
    if (e instanceof ProviderError && e.status === 400 && tool.strict && /schema|strict|grammar|compil/i.test(e.message)) {
      const resp = await createMessage(cfg, { ...req, tools: [{ ...tool, strict: false }], toolChoice: { type: 'auto' } }, fetchImpl);
      return { resp, input: extractToolInput(resp, tool.name), strict: false };
    }
    throw e;
  }
}

// ───────────────────────── Provider card ─────────────────────────
async function testConnection(ctx: ProviderContext): Promise<TestResult> {
  let cfg: ClaudeConfig;
  try { cfg = claudeConfigFrom(ctx.config, ctx.secrets); } catch (e: any) { return { ok: false, message: e.message }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${ANTHROPIC_API_URL}/v1/models/${encodeURIComponent(cfg.model)}`, {
      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION }, signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: mapAnthropicError(res.status, text, res.headers).message };
    let display = cfg.model;
    try { display = JSON.parse(text)?.display_name ?? cfg.model; } catch { /* ignore */ }
    return { ok: true, message: `Connected. Model ${cfg.model} (${display}) is available to this key.`, details: { model: cfg.model } };
  } catch (e: any) {
    return { ok: false, message: e?.name === 'AbortError' ? 'Timed out contacting api.anthropic.com.' : `Could not reach api.anthropic.com (${networkReason(e)}).` };
  } finally {
    clearTimeout(timer);
  }
}

export const anthropicProvider: ProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  category: 'ai',
  description: 'Analyses transcripts and conversations: summaries, issue classification, rubric scoring, evidence-linked quality alerts and coaching drafts. Uses only published knowledge-base policies.',
  docsUrl: 'https://platform.claude.com/docs/en/api/messages',
  authType: 'api_key',
  configFields: [
    { key: 'model', label: 'Model', type: 'select', required: true, options: CLAUDE_MODELS, help: 'Default: Claude Sonnet 5.5. Changing the model affects new analyses only — use AI Configuration → Reprocess to re-run older ones.' },
    { key: 'customModel', label: 'Custom model id (optional)', type: 'text', placeholder: 'e.g. claude-opus-5-5', help: 'Overrides the selection above (exact API model id).' },
    { key: 'maxTokens', label: 'Max output tokens', type: 'number', placeholder: '8000', help: '1024–32000. Long email threads may need more.' },
    { key: 'timeoutSeconds', label: 'Request timeout (seconds)', type: 'number', placeholder: '180' },
  ],
  secretFields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'sk-ant-…', help: 'Create in the Claude Console → API keys. Stored encrypted; never shown again.' },
  ],
  scopes: [],
  dataImported: ['Nothing is imported. Conversation text and approved KB articles are sent to Claude for analysis; results are stored here.'],
  setupSteps: [
    'In the Claude Console (platform.claude.com) create an API key for a workspace with sufficient rate limits.',
    'Paste the key here, choose the model and save.',
    'Click "Test connection" — this checks the key and model without spending tokens.',
    'New interactions are analysed automatically when "Auto-analyse" is on in AI Configuration.',
  ],
  supportsWebhook: false,
  supportsPolling: false,
  limitations: [
    'Rate limits (429) and overload (529) are retried automatically with backoff.',
    'Demo records may be analysed offline by the built-in heuristic when Claude is not connected; live records always require Claude.',
    'Scores are recomputed server-side from criterion scores; the model’s own arithmetic is never trusted.',
  ],
  testConnection,
};
