import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeChunked, startBatchJob, type SarvamConfig } from '@/lib/providers/sarvam';

const cfg: SarvamConfig = { apiKey: 'k', model: 'saaras:v4', languageCode: 'unknown', diarization: true, numSpeakers: 2, syncMaxSeconds: 30, translation: 'none' };
afterEach(() => vi.unstubAllGlobals());

describe('Sarvam fallbacks', () => {
  it('transcribes a long MP3 in pieces with correct time offsets', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => { n++; return new Response(JSON.stringify({ transcript: `part ${n}`, language_code: 'hi-IN', timestamps: { words: [`part ${n}`], start_time_seconds: [1], end_time_seconds: [2] } })); });
    const r = (await transcribeChunked(cfg, readFileSync('tests/fixtures/tone-70s.mp3'), { fileName: 'call.mp3', mime: 'audio/mpeg' }))!;
    expect(n).toBe(3);
    expect(r.fullText).toBe('part 1 part 2 part 3');
    expect(r.segments.map((s) => s.startMs)).toEqual([1000, 25984, 50968]);
  });
  it('retries the batch start after a 502', async () => {
    const calls: string[] = []; let starts = 0;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.stubGlobal('fetch', async (u: string) => {
      calls.push(u);
      if (u.endsWith('/job/v1')) return new Response(JSON.stringify({ job_id: 'j1' }));
      if (u.endsWith('/upload-files')) return new Response(JSON.stringify({ upload_urls: { 'a.mp3': { file_url: 'https://blob/x' } } }));
      if (u === 'https://blob/x') return new Response('');
      if (u.endsWith('/start')) return ++starts < 2 ? new Response('bad gateway', { status: 502 }) : new Response('{}');
      return new Response('{}');
    });
    const p = startBatchJob(cfg, Buffer.alloc(2000), { fileName: 'a.mp3', mime: 'audio/mpeg' });
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).jobId).toBe('j1');
    expect(starts).toBe(2);
    vi.useRealTimers();
  });
});
