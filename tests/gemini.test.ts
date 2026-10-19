import { afterEach, describe, expect, it, vi } from 'vitest';
import { callGeminiTool, geminiConfigFrom } from '@/lib/providers/gemini';
import { callAiTool } from '@/lib/ai/provider';

const cfg = geminiConfigFrom({ model: 'gemini-2.5-flash' }, { apiKey: 'k' });
const tool = { name: 'submit', description: 'Submit it.', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } };
const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, modelVersion: 'gemini-2.5-flash' }));
afterEach(() => vi.unstubAllGlobals());

describe('Gemini provider', () => {
  it('sends schema in generationConfig and parses JSON', async () => {
    let body: any; let url = '';
    const f = vi.fn(async (u: string, init: any) => { url = u; body = JSON.parse(init.body); return ok('{"a":"x"}'); });
    const r = await callGeminiTool(cfg, { system: 'sys', messages: [{ role: 'user', content: 'hello' }], tool }, f as any);
    expect(url).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(body.generationConfig.responseJsonSchema).toEqual(tool.input_schema);
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(r.input).toEqual({ a: 'x' });
    expect(r.resp.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
  it('falls back to prompt-embedded schema when the schema is rejected', async () => {
    const bodies: any[] = [];
    const f = vi.fn(async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'schema too complex' } }), { status: 400 }) : ok('```json\n{"a":"y"}\n```');
    });
    const r = await callGeminiTool(cfg, { messages: [{ role: 'user', content: 'hi' }], tool }, f as any);
    expect(bodies[1].generationConfig.responseJsonSchema).toBeUndefined();
    expect(bodies[1].contents[0].parts[0].text).toContain('JSON Schema');
    expect(r).toMatchObject({ input: { a: 'y' }, strict: false });
  });
  it('maps an invalid key to a clear error', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' } }), { status: 400 }));
    await expect(callGeminiTool(cfg, { messages: [{ role: 'user', content: 'hi' }], tool }, f as any)).rejects.toThrow(/rejected the API key/);
  });
  it('callAiTool routes a gemini connection to Gemini', async () => {
    const f = vi.fn(async () => ok('{"a":"z"}'));
    const r = await callAiTool({ id: '1', orgId: 'o', provider: 'gemini', status: 'connected', config: {}, secrets: { apiKey: 'k' } }, { messages: [{ role: 'user', content: 'x' }], tool }, f as any);
    expect(r).toMatchObject({ provider: 'gemini', input: { a: 'z' } });
  });
});
