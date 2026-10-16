/**
 * Sarvam AI — speech-to-text for Hindi / English / Hinglish call recordings.
 *
 * Verified against the official docs (Oct 2026):
 *   - REST (sync):  https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
 *       POST https://api.sarvam.ai/speech-to-text   (multipart/form-data)
 *       header: api-subscription-key
 *       fields: file, model (saaras:v4 default | saaras:v3), mode (transcribe|translate|verbatim|translit|codemix),
 *               language_code (BCP-47 e.g. hi-IN, en-IN, or "unknown" = auto-detect), with_timestamps (bool)
 *       response: { request_id, transcript, language_code, language_probability,
 *                   timestamps?: { words[] (phrase chunks), start_time_seconds[], end_time_seconds[] } }
 *       The REST API is documented for "quick responses under 30 seconds" and does NOT support diarization.
 *   - Batch (long audio, diarization): https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/batch-api
 *       POST /speech-to-text/job/v1                       {job_parameters:{model,mode,language_code,with_timestamps,with_diarization,num_speakers}}
 *            → {job_id, job_state, storage_container_type}   (https://docs.sarvam.ai/api-reference/speech-to-text/stt/job/initiate)
 *       POST /speech-to-text/job/v1/upload-files          {job_id, files:[name]} → {upload_urls:{name:{file_url}}}
 *            then HTTP PUT the bytes to file_url with headers `x-ms-blob-type: BlockBlob` + Content-Type
 *            (Azure blob presigned URL — upload headers taken from the official sarvamai SDK, speech_to_text_job/job.py)
 *       POST /speech-to-text/job/v1/{job_id}/start
 *       GET  /speech-to-text/job/v1/{job_id}/status       → {job_state: Accepted|Pending|Running|Completed|Failed,
 *                                                            job_details:[{inputs:[{file_name}],outputs:[{file_name}],state,error_message}]}
 *       POST /speech-to-text/job/v1/download-files        {job_id, files:[output names]} → {download_urls:{name:{file_url}}}; GET file_url → JSON
 *       Output JSON: {transcript, language_code, timestamps:{chunks|words, start_time_seconds, end_time_seconds},
 *                     diarized_transcript:{entries:[{transcript,start_time_seconds,end_time_seconds,speaker_id}]}}
 *       Limits: up to 2 h audio per file, 20 files per job.
 *   Errors: 400, 403 (invalid key), 422, 429 (quota), 500, 503 (overloaded) with body {error:{message,code,request_id}}.
 *
 * Audio is never logged. Demo recordings (demo://) must never be sent here — enforced by pipeline/transcribe.ts.
 */
import type { ProviderContext, ProviderDefinition, TestResult } from './types';
import { ProviderError, parseRetryAfter } from '@/lib/ai/errors';
import { networkReason } from './anthropic';
import { splitMp3 } from './mp3-chunks';

export const SARVAM_API_URL = 'https://api.sarvam.ai';
export const SARVAM_SYNC_MAX_SECONDS = 30;

export interface SarvamConfig {
  apiKey: string;
  model: string;               // saaras:v4 | saaras:v3
  languageCode: string;        // unknown | hi-IN | en-IN | ...
  diarization: boolean;
  numSpeakers: number;
  syncMaxSeconds: number;
  translation: 'none' | 'sarvam';
  baseUrl?: string;
}

export interface SttSegment { speakerId: string | null; startMs: number; endMs: number; text: string }
export interface SttResult {
  provider: 'sarvam';
  model: string;
  mode: 'sync' | 'batch';
  language: string | null;
  diarized: boolean;
  fullText: string;
  segments: SttSegment[];
  translationEn: string | null;
  requestId: string | null;
  jobId?: string | null;
}

export function sarvamConfigFrom(config: Record<string, any>, secrets: Record<string, string>): SarvamConfig {
  const apiKey = (secrets.apiKey ?? '').trim();
  if (!apiKey) throw new ProviderError('sarvam', 'Sarvam API subscription key is missing. Add it on the Integrations page.', { retryable: false });
  const model = ['saaras:v4', 'saaras:v3'].includes(config.model) ? config.model : 'saaras:v4';
  const languageCode = typeof config.languageCode === 'string' && /^(unknown|[a-z]{2,3}-IN)$/.test(config.languageCode) ? config.languageCode : 'unknown';
  const ns = Math.round(Number(config.numSpeakers));
  const sm = Math.round(Number(config.syncMaxSeconds));
  return {
    apiKey, model, languageCode,
    diarization: config.diarization !== 'off' && config.diarization !== false,
    numSpeakers: Number.isFinite(ns) && ns >= 1 && ns <= 20 ? ns : 2,
    syncMaxSeconds: Number.isFinite(sm) && sm > 0 ? Math.min(sm, SARVAM_SYNC_MAX_SECONDS) : SARVAM_SYNC_MAX_SECONDS,
    translation: config.translation === 'sarvam' ? 'sarvam' : 'none',
  };
}

function mapSarvamError(status: number, bodyText: string, headers: { get(n: string): string | null }, step: string): ProviderError {
  let msg = '';
  let code = '';
  try { const j = JSON.parse(bodyText); msg = j?.error?.message ?? j?.message ?? ''; code = j?.error?.code ?? ''; } catch { /* ignore */ }
  const safe = (msg || '').slice(0, 300);
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));
  if (status === 401 || status === 403) return new ProviderError('sarvam', `Sarvam rejected the API key (${status}) during ${step}. Update it on the Integrations page.`, { status, code });
  if (status === 429) return new ProviderError('sarvam', `Sarvam rate limit / quota exceeded (429) during ${step}. ${safe}`, { status, code, retryable: true, retryAfterMs: retryAfterMs ?? 120_000 });
  if (status >= 500) return new ProviderError('sarvam', `Sarvam service error (${status}) during ${step}. ${safe}`, { status, code, retryable: true, retryAfterMs: retryAfterMs ?? 60_000 });
  return new ProviderError('sarvam', `Sarvam rejected the request (${status}) during ${step}. ${safe}`, { status, code });
}

async function sarvamFetch(cfg: SarvamConfig, path: string, init: RequestInit & { timeoutMs?: number }, step: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl ?? SARVAM_API_URL}${path}`, {
      ...init, signal: ctrl.signal,
      headers: { 'api-subscription-key': cfg.apiKey, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (e: any) {
    throw new ProviderError('sarvam', e?.name === 'AbortError' ? `Sarvam ${step} timed out.` : `Could not reach the Sarvam API during ${step} (${networkReason(e)}).`, { retryable: true, retryAfterMs: 60_000 });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw mapSarvamError(res.status, text, res.headers, step);
  try { return text ? JSON.parse(text) : {}; } catch { throw new ProviderError('sarvam', `Sarvam returned a non-JSON response during ${step}.`, { retryable: true }); }
}

// ───────────────────────── Output mapping (pure; unit-testable) ─────────────────────────
/** Normalise either the REST or batch output JSON into segments. */
export function mapSarvamOutput(j: any): { fullText: string; language: string | null; diarized: boolean; segments: SttSegment[] } {
  const fullText = String(j?.transcript ?? '').trim();
  const language = j?.language_code ?? null;
  const entries = j?.diarized_transcript?.entries;
  if (Array.isArray(entries) && entries.length) {
    return {
      fullText, language, diarized: true,
      segments: entries.map((e: any) => ({
        speakerId: e.speaker_id !== undefined && e.speaker_id !== null ? String(e.speaker_id) : null,
        startMs: Math.round(Number(e.start_time_seconds ?? 0) * 1000),
        endMs: Math.round(Number(e.end_time_seconds ?? e.start_time_seconds ?? 0) * 1000),
        text: String(e.transcript ?? '').trim(),
      })).filter((s: SttSegment) => s.text),
    };
  }
  const ts = j?.timestamps;
  const chunks: unknown[] | undefined = ts?.words ?? ts?.chunks;
  if (Array.isArray(chunks) && chunks.length) {
    return {
      fullText, language, diarized: false,
      segments: chunks.map((w, i) => ({
        speakerId: null,
        startMs: Math.round(Number(ts.start_time_seconds?.[i] ?? 0) * 1000),
        endMs: Math.round(Number(ts.end_time_seconds?.[i] ?? ts.start_time_seconds?.[i] ?? 0) * 1000),
        text: String(w ?? '').trim(),
      })).filter((s) => s.text),
    };
  }
  return { fullText, language, diarized: false, segments: fullText ? [{ speakerId: null, startMs: 0, endMs: 0, text: fullText }] : [] };
}

// ───────────────────────── Sync REST ─────────────────────────
export async function transcribeSync(cfg: SarvamConfig, audio: Buffer, opts: { fileName: string; mime: string; mode?: string }): Promise<SttResult> {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(audio)], { type: opts.mime }), opts.fileName);
  fd.append('model', cfg.model);
  fd.append('mode', opts.mode ?? 'transcribe');
  fd.append('language_code', cfg.languageCode);
  fd.append('with_timestamps', 'true');
  const j = await sarvamFetch(cfg, '/speech-to-text', { method: 'POST', body: fd, timeoutMs: 120_000 }, 'transcription');
  const m = mapSarvamOutput(j);
  return { provider: 'sarvam', model: cfg.model, mode: 'sync', ...m, translationEn: null, requestId: j.request_id ?? null };
}

/**
 * Fallback when batch is unavailable: split an MP3 into ≤25 s pieces and transcribe each with the sync API.
 * No diarization (speakers are inferred later by the AI analysis). Returns null if the audio can't be split.
 */
export async function transcribeChunked(cfg: SarvamConfig, audio: Buffer, opts: { fileName: string; mime: string }): Promise<SttResult | null> {
  const pieces = splitMp3(audio, Math.min(25, cfg.syncMaxSeconds - 2));
  if (!pieces) return null;
  const segments: SttSegment[] = [];
  const texts: string[] = [];
  let language: string | null = null;
  for (const [n, p] of pieces.entries()) {
    if (p.seconds < 0.5) continue;
    const r = await transcribeSync(cfg, p.data, { fileName: opts.fileName.replace(/(\.\w+)?$/, `-part${n + 1}.mp3`), mime: 'audio/mpeg' });
    language ??= r.language;
    if (r.fullText) texts.push(r.fullText);
    for (const s of r.segments) {
      const startMs = p.offsetMs + s.startMs;
      const endMs = s.endMs > 0 ? p.offsetMs + s.endMs : p.offsetMs + Math.round(p.seconds * 1000);
      segments.push({ ...s, startMs, endMs });
    }
  }
  return { provider: 'sarvam', model: cfg.model, mode: 'sync', language, diarized: false, fullText: texts.join(' '), segments, translationEn: null, requestId: null };
}

// ───────────────────────── Batch ─────────────────────────
export interface BatchHandle { jobId: string; inputName: string }

/** Create a batch job, upload the audio and start it. Returns a handle to poll. */
export async function startBatchJob(cfg: SarvamConfig, audio: Buffer, opts: { fileName: string; mime: string; mode?: string; diarize?: boolean }): Promise<BatchHandle> {
  const diarize = opts.diarize ?? cfg.diarization;
  const init = await sarvamFetch(cfg, '/speech-to-text/job/v1', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_parameters: {
        model: cfg.model, mode: opts.mode ?? 'transcribe', language_code: cfg.languageCode, with_timestamps: true,
        with_diarization: diarize, ...(diarize ? { num_speakers: cfg.numSpeakers } : {}),
      },
    }),
  }, 'batch job creation');
  const jobId: string = init.job_id;
  if (!jobId) throw new ProviderError('sarvam', 'Sarvam did not return a job id.', { retryable: true });
  const inputName = opts.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const up = await sarvamFetch(cfg, '/speech-to-text/job/v1/upload-files', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: jobId, files: [inputName] }),
  }, 'upload link request');
  const url: string | undefined = up?.upload_urls?.[inputName]?.file_url;
  if (!url) throw new ProviderError('sarvam', 'Sarvam did not return an upload URL.', { retryable: true });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  try {
    const put = await fetch(url, { method: 'PUT', body: new Uint8Array(audio), headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': opts.mime }, signal: ctrl.signal });
    if (!put.ok) throw new ProviderError('sarvam', `Audio upload to Sarvam storage failed (${put.status}).`, { status: put.status, retryable: put.status >= 500 || put.status === 429 });
  } catch (e: any) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('sarvam', `Audio upload to Sarvam storage failed (${networkReason(e)}).`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  // Sarvam's start endpoint intermittently returns 5xx; retry the start (the job and upload are already done).
  for (let attempt = 1; ; attempt++) {
    try {
      await sarvamFetch(cfg, `/speech-to-text/job/v1/${encodeURIComponent(jobId)}/start`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 'batch job start');
      break;
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, [3_000, 8_000, 15_000][attempt - 1]));
    }
  }
  return { jobId, inputName };
}

export type BatchPoll =
  | { state: 'running'; jobState: string }
  | { state: 'failed'; message: string }
  | { state: 'completed'; result: SttResult };

/** Poll once; when complete, downloads and maps the output. */
export async function pollBatchJob(cfg: SarvamConfig, jobId: string): Promise<BatchPoll> {
  const st = await sarvamFetch(cfg, `/speech-to-text/job/v1/${encodeURIComponent(jobId)}/status`, { method: 'GET' }, 'batch status');
  const jobState = String(st.job_state ?? '');
  if (jobState === 'Failed') return { state: 'failed', message: String(st.error_message || st.job_details?.[0]?.error_message || 'Sarvam batch job failed').slice(0, 300) };
  if (jobState !== 'Completed' && jobState !== 'PartiallyCompleted') return { state: 'running', jobState };
  const detail = (st.job_details ?? []).find((d: any) => d.outputs?.length && (!d.state || d.state === 'Success'));
  if (!detail) {
    const f = (st.job_details ?? [])[0];
    return { state: 'failed', message: String(f?.error_message || 'Sarvam returned no output for this recording (possibly unsupported audio).').slice(0, 300) };
  }
  const outName: string = detail.outputs[0].file_name;
  const dl = await sarvamFetch(cfg, '/speech-to-text/job/v1/download-files', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: jobId, files: [outName] }),
  }, 'result download link');
  const url: string | undefined = dl?.download_urls?.[outName]?.file_url;
  if (!url) throw new ProviderError('sarvam', 'Sarvam did not return a download URL.', { retryable: true });
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError('sarvam', `Downloading the Sarvam result failed (${res.status}).`, { retryable: true });
  const j = await res.json();
  const m = mapSarvamOutput(j);
  return { state: 'completed', result: { provider: 'sarvam', model: cfg.model, mode: 'batch', ...m, translationEn: null, requestId: j.request_id ?? null, jobId } };
}

/**
 * Choose sync vs batch. Sync is used only when the duration is known and ≤ syncMaxSeconds AND diarization isn't required
 * (the REST API has no diarization). Otherwise the batch API is used.
 */
export function chooseSttMode(cfg: SarvamConfig, durationSeconds: number | null | undefined): 'sync' | 'batch' {
  if (durationSeconds && durationSeconds > 0 && durationSeconds <= cfg.syncMaxSeconds && !cfg.diarization) return 'sync';
  if (durationSeconds && durationSeconds > 0 && durationSeconds <= Math.min(cfg.syncMaxSeconds, 20)) return 'sync'; // very short clips: speed > diarization
  return 'batch';
}

// ───────────────────────── Provider card ─────────────────────────
async function testConnection(ctx: ProviderContext): Promise<TestResult> {
  let cfg: SarvamConfig;
  try { cfg = sarvamConfigFrom(ctx.config, ctx.secrets); } catch (e: any) { return { ok: false, message: e.message }; }
  try {
    // Creating a batch job (never started, no audio) is the cheapest documented call that proves the key works.
    const j = await sarvamFetch(cfg, '/speech-to-text/job/v1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_parameters: { model: cfg.model, language_code: cfg.languageCode } }), timeoutMs: 20_000,
    }, 'connection test');
    return { ok: true, message: `Connected. Sarvam accepted the key (test job ${String(j.job_id ?? '').slice(0, 8)}… created, not started — no audio processed).` };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Sarvam connection test failed.' };
  }
}

export const sarvamProvider: ProviderDefinition = {
  id: 'sarvam',
  name: 'Sarvam AI Speech-to-Text',
  category: 'speech_to_text',
  description: 'Transcribes call recordings in Hindi, English and Hinglish with timestamps; long calls use the batch API with speaker diarization.',
  docsUrl: 'https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe',
  authType: 'api_key',
  configFields: [
    { key: 'model', label: 'Model', type: 'select', required: true, options: [
      { value: 'saaras:v4', label: 'saaras:v4 (default, recommended)' }, { value: 'saaras:v3', label: 'saaras:v3' }] },
    { key: 'languageCode', label: 'Language', type: 'select', options: [
      { value: 'unknown', label: 'Auto-detect (recommended for Hinglish)' }, { value: 'hi-IN', label: 'Hindi (hi-IN)' }, { value: 'en-IN', label: 'English – India (en-IN)' }],
      help: 'Original language is always preserved in the transcript.' },
    { key: 'diarization', label: 'Speaker diarization', type: 'select', options: [
      { value: 'on', label: 'On — batch API, separates agent and customer (beta)' }, { value: 'off', label: 'Off' }] },
    { key: 'numSpeakers', label: 'Expected speakers per call', type: 'number', placeholder: '2' },
    { key: 'translation', label: 'English translation', type: 'select', options: [
      { value: 'none', label: 'Via Claude during analysis (default, no extra STT cost)' },
      { value: 'sarvam', label: 'Via Sarvam translate mode (second STT pass)' }],
      help: 'Applies when "Translate to English" is enabled in AI Configuration.' },
  ],
  secretFields: [
    { key: 'apiKey', label: 'API subscription key', type: 'password', required: true, help: 'From the Sarvam dashboard. Sent as the api-subscription-key header; stored encrypted.' },
  ],
  scopes: [],
  dataImported: ['Nothing is imported. Authorised call audio is sent to Sarvam; the timestamped transcript is stored here.'],
  setupSteps: [
    'Create an API subscription key in the Sarvam AI dashboard (dashboard.sarvam.ai).',
    'Paste it here and choose the model / language.',
    'Click "Test connection" (creates an empty, unstarted batch job to verify the key).',
    'Make sure call recordings are available from MyOperator — calls without an authorised recording cannot be transcribed.',
  ],
  supportsWebhook: false,
  supportsPolling: false,
  limitations: [
    'The synchronous REST API is for clips under ~30 seconds and has no diarization; longer calls use the batch API (up to 2 h per file).',
    'Diarization is beta: speaker 0/1 are mapped to agent/customer only when the agent greeting is recognisable, otherwise labelled "unknown" and inferred during AI analysis.',
    'Rate limits (429) and overload (503) are retried with backoff.',
  ],
  testConnection,
};
