/** AI provider selection: Claude when connected, otherwise Gemini. One call shape for both. */
import type { Db } from '@/lib/db';
import { findProviderConnection, type LoadedConnection } from './connections';
import { callClaudeTool, claudeConfigFrom, type ClaudeMessageParam, type ClaudeTool } from '@/lib/providers/anthropic';
import { callGeminiTool, geminiConfigFrom } from '@/lib/providers/gemini';

export const AI_PROVIDER_IDS = ['anthropic', 'gemini'] as const;

export async function findAiConnection(db: Db, orgId?: string): Promise<LoadedConnection | null> {
  for (const id of AI_PROVIDER_IDS) {
    const c = await findProviderConnection(db, id, orgId);
    if (c) return c;
  }
  return null;
}

export function aiModelName(conn: LoadedConnection): string {
  return String(conn.config.customModel || conn.config.model || (conn.provider === 'gemini' ? 'gemini-2.5-flash' : 'claude-sonnet-5-5'));
}

export interface AiToolRequest { system?: string; messages: ClaudeMessageParam[]; tool: ClaudeTool; maxTokens?: number; timeoutMs?: number }

export async function callAiTool(conn: LoadedConnection, req: AiToolRequest, fetchImpl: typeof fetch = fetch) {
  if (conn.provider === 'gemini') {
    const cfg = geminiConfigFrom(conn.config, conn.secrets);
    const c = { ...cfg, ...(req.maxTokens ? { maxTokens: Math.min(cfg.maxTokens, req.maxTokens) } : {}), ...(req.timeoutMs ? { timeoutMs: Math.min(cfg.timeoutMs, req.timeoutMs) } : {}) };
    const out = await callGeminiTool(c, req, fetchImpl);
    return { ...out, provider: 'gemini', model: out.resp.model || c.model };
  }
  const cfg = claudeConfigFrom(conn.config, conn.secrets);
  const c = { ...cfg, ...(req.maxTokens ? { maxTokens: Math.min(cfg.maxTokens, req.maxTokens) } : {}), ...(req.timeoutMs ? { timeoutMs: Math.min(cfg.timeoutMs, req.timeoutMs) } : {}) };
  const out = await callClaudeTool(c, { system: req.system, messages: req.messages, tool: req.tool }, fetchImpl);
  return { resp: { model: out.resp.model, usage: out.resp.usage }, input: out.input, strict: out.strict, provider: 'anthropic', model: out.resp.model || c.model };
}
