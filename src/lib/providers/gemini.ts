/**
 * Google Gemini — alternative AI analysis provider (REST generateContent over fetch, no SDK).
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *     header x-goog-api-key
 *     body { systemInstruction:{parts:[{text}]}, contents:[{role:'user',parts:[{text}]}],
 *            generationConfig:{ responseMimeType:'application/json', responseJsonSchema, maxOutputTokens, temperature } }
 *     response { candidates:[{content:{parts:[{text}]}, finishReason}], usageMetadata:{promptTokenCount,candidatesTokenCount}, modelVersion }
 *   GET  https://generativelanguage.googleapis.com/v1beta/models/{model}   (Test connection — no tokens spent)
 *
 * If the JSON schema is rejected (400), we retry once in plain JSON mode with the schema embedded in the prompt;
 * the output is zod-validated by the caller either way.
 * NOTE: on Google's FREE tier, prompts/responses may be used to improve Google products — use a billed key for customer data.
 */
import type { ProviderContext, ProviderDefinition, TestResult } from './types';
import { ProviderError, parseRetryAfter } from '@/lib/ai/errors';
import { networkReason, type ClaudeMessageParam, type ClaudeTool } from './anthropic';

export const GEMINI_API_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_MODELS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (default — good balance)' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (lowest cost)' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (highest quality)' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
];

export interface GeminiConfig { apiKey: string; model: string; maxTokens: number; timeoutMs: number; baseUrl?: string }

export function geminiConfigFrom(config: Record<string, any>, secrets: Record<string, string>): GeminiConfig {
  const apiKey = (secrets.apiKey ?? '').trim();
  if (!apiKey) throw new ProviderError('gemini', 'Gemini API key is missing. Add it on the Integrations page.', { retryable: false });
  const custom = typeof config.customModel === 'string' ? config.customModel.trim() : '';
  const model = (custom || (typeof config.model === 'string' && config.model.trim()) || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
  if (!/^[a-z0-9][a-z0-9.\-_]{2,80}$/i.test(model)) throw new ProviderError('gemini', `Invalid Gemini model id "${model}".`, { retryable: false });
  const n = (v: unknown, min: number, max: number, d: number) => { const x = Math.round(Number(v)); return Number.isFinite(x) && x > 0 ? Math.max(min, Math.min(max, x)) : d; };
  return { apiKey, model, maxTokens: n(config.maxTokens, 1024, 65000, 8000), timeoutMs: n(config.timeoutSeconds, 15, 600, 180) * 1000 };
}

export function mapGeminiError(status: number, bodyText: string, headers: { get(n: string): string | null }): ProviderError {
  let msg = '', code = '';
  try { const j = JSON.parse(bodyText); msg = j?.error?.message ?? ''; code = j?.error?.status ?? ''; } catch { /* non-JSON */ }
  const safe = (msg || bodyText || '').replace(/AIza[0-9A-Za-z_\-]{20,}/g, '[redacted]').slice(0, 300);
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  if ((status === 400 && /api key/i.test(msg)) || status === 401) return new ProviderError('gemini', 'Gemini rejected the API key. Update it on the Integrations page.', { status, code });
  if (status === 403) return new ProviderError('gemini', `Gemini API key lacks permission (403). ${safe}`, { status, code });
  if (status === 404) return new ProviderError('gemini', `Gemini model not found (404) — check the model id. ${safe}`, { status, code });
  if (status === 429) return new ProviderError('gemini', `Gemini rate limit or quota reached (429). ${safe}`, { status, code, retryable: true, retryAfterMs: retryAfterMs ?? 60_000 });
  if (status >= 500 || status === 408) return new ProviderError('gemini', `Gemini API error (${status}). ${safe}`, { status, code, retryable: true, retryAfterMs: retryAfterMs ?? 30_000 });
  return new ProviderError('gemini', `Gemini request rejected (${status} ${code}). ${safe}`, { status, code });
}

interface GeminiResult { model: string; text: string; finishReason: string | null; usage: { inputTokens: number; outputTokens: number } }

async function generate(cfg: GeminiConfig, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<GeminiResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl ?? GEMINI_API_URL}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
  } catch (e: any) {
    throw new ProviderError('gemini', e?.name === 'AbortError' ? `Gemini request timed out after ${Math.round(cfg.timeoutMs / 1000)}s.` : `Could not reach the Gemini API (${networkReason(e)}).`, { retryable: true, retryAfterMs: 60_000 });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw mapGeminiError(res.status, text, res.headers);
  let j: any;
  try { j = JSON.parse(text); } catch { throw new ProviderError('gemini', 'Gemini returned a non-JSON response.', { retryable: true }); }
  const cand = j?.candidates?.[0];
  if (!cand) {
    const block = j?.promptFeedback?.blockReason;
    throw new ProviderError('gemini', block ? `Gemini blocked this conversation (${block}).` : 'Gemini returned no answer.', { retryable: !block });
  }
  return {
    model: j.modelVersion ?? cfg.model,
    text: (cand.content?.parts ?? []).map((p: any) => (typeof p.text === 'string' && !p.thought ? p.text : '')).join(''),
    finishReason: cand.finishReason ?? null,
    usage: { inputTokens: Number(j.usageMetadata?.promptTokenCount ?? 0), outputTokens: Number(j.usageMetadata?.candidatesTokenCount ?? 0) + Number(j.usageMetadata?.thoughtsTokenCount ?? 0) },
  };
}

function parseJsonOutput(r: GeminiResult): unknown {
  const t = r.text.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = m ? m[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  if (r.finishReason === 'MAX_TOKENS') throw new ProviderError('gemini', 'Gemini response was cut off (max tokens). Increase "Max output tokens" on the Gemini integration.', { retryable: false });
  if (r.finishReason === 'SAFETY' || r.finishReason === 'PROHIBITED_CONTENT') throw new ProviderError('gemini', `Gemini declined to analyse this conversation (${r.finishReason}).`, { retryable: false });
  throw new ProviderError('gemini', 'Gemini did not return valid JSON.', { retryable: true, retryAfterMs: 120_000 });
}

/** Same call shape as callClaudeTool: returns { resp:{model,usage}, input, strict }. */
export async function callGeminiTool(cfg: GeminiConfig, req: { system?: string; messages: ClaudeMessageParam[]; tool: ClaudeTool; maxTokens?: number; temperature?: number }, fetchImpl: typeof fetch = fetch) {
  const userText = req.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => c.text).join('\n'))).join('\n\n');
  const instr = `${req.tool.description}\nRespond with ONE JSON object only (no prose, no markdown).`;
  const base = {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: req.maxTokens ?? cfg.maxTokens, temperature: req.temperature ?? 0.2 },
  };
  try {
    const r = await generate(cfg, {
      ...base,
      contents: [{ role: 'user', parts: [{ text: `${userText}\n\n${instr}` }] }],
      generationConfig: { ...base.generationConfig, responseJsonSchema: req.tool.input_schema },
    }, fetchImpl);
    return { resp: { model: r.model, usage: r.usage }, input: parseJsonOutput(r), strict: true };
  } catch (e) {
    if (!(e instanceof ProviderError && e.status === 400 && !/api key/i.test(e.message))) throw e;
    // Schema not accepted: plain JSON mode, schema given in the prompt.
    const r = await generate(cfg, {
      ...base,
      contents: [{ role: 'user', parts: [{ text: `${userText}\n\n${instr}\nThe JSON must match this JSON Schema exactly:\n${JSON.stringify(req.tool.input_schema)}` }] }],
    }, fetchImpl);
    return { resp: { model: r.model, usage: r.usage }, input: parseJsonOutput(r), strict: false };
  }
}

async function testConnection(ctx: ProviderContext): Promise<TestResult> {
  let cfg: GeminiConfig;
  try { cfg = geminiConfigFrom(ctx.config, ctx.secrets); } catch (e: any) { return { ok: false, message: e.message }; }
  try {
    const res = await fetch(`${GEMINI_API_URL}/v1beta/models/${encodeURIComponent(cfg.model)}`, { headers: { 'x-goog-api-key': cfg.apiKey }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: mapGeminiError(res.status, text, res.headers).message };
    let display = cfg.model;
    try { display = JSON.parse(text)?.displayName ?? cfg.model; } catch { /* ignore */ }
    return { ok: true, message: `Connected. Model ${cfg.model} (${display}) is available to this key.`, details: { model: cfg.model } };
  } catch (e: any) {
    return { ok: false, message: e?.name === 'TimeoutError' ? 'Timed out contacting the Gemini API.' : `Could not reach the Gemini API (${networkReason(e)}).` };
  }
}

export const geminiProvider: ProviderDefinition = {
  id: 'gemini',
  name: 'Google Gemini',
  category: 'ai',
  description: 'Alternative to Claude for analysis: summaries, issue classification, rubric scoring, quality alerts and coaching drafts. Used only when Claude is not connected.',
  docsUrl: 'https://ai.google.dev/gemini-api/docs',
  authType: 'api_key',
  configFields: [
    { key: 'model', label: 'Model', type: 'select', required: true, options: GEMINI_MODELS, help: 'Default: Gemini 2.5 Flash.' },
    { key: 'customModel', label: 'Custom model id (optional)', type: 'text', placeholder: 'e.g. gemini-2.5-flash', help: 'Overrides the selection above (exact API model id).' },
    { key: 'maxTokens', label: 'Max output tokens', type: 'number', placeholder: '8000' },
    { key: 'timeoutSeconds', label: 'Request timeout (seconds)', type: 'number', placeholder: '180' },
  ],
  secretFields: [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, placeholder: 'AIza…', help: 'Create in Google AI Studio → Get API key. Stored encrypted.' },
  ],
  scopes: [],
  dataImported: ['Nothing is imported. Conversation text and approved KB articles are sent to Gemini for analysis; results are stored here.'],
  setupSteps: [
    'Open aistudio.google.com/apikey and create an API key. For real customer data, enable billing on the key\'s Google Cloud project (free-tier content may be used by Google to improve its products).',
    'Paste the key here, choose the model and save.',
    'Click "Test connection".',
    'If both Claude and Gemini are connected, Claude is used.',
  ],
  supportsWebhook: false,
  supportsPolling: false,
  limitations: [
    'Free-tier keys have low daily limits and Google may use free-tier content to improve its products.',
    'Rate limits (429) are retried automatically with backoff.',
    'Scores are recomputed server-side from criterion scores.',
  ],
  testConnection,
};
