/**
 * 'transcribe' job: fetch an authorised call recording server-side → (optional private copy) → Sarvam STT →
 * call_transcripts + transcript_segments → enqueue analysis.
 *
 * Recording access for providers that need auth (e.g. MyOperator): the integrations layer registers a fetcher with
 *   registerRecordingFetcher('myoperator', async ({ db, orgId, ref, connectionId }) => ({ url, init }))
 * at module load of its provider file (the worker imports src/lib/integrations/sync.ts, which should import providers).
 * Without a registered fetcher, http(s) refs are fetched directly; other refs fail with a clear message.
 *
 * Demo recordings (is_demo or demo:// refs) are NEVER sent to external providers.
 */
import { withOrg, type Db } from '@/lib/db';
import { deferJob, enqueueProcessing, type Job } from './jobs';
import { getProviderConnection } from '@/lib/ai/connections';
import { loadOrgSettings } from '@/lib/ai/settings';
import { PipelineError, ProviderError, errorMessage, isRetryable } from '@/lib/ai/errors';
import { getStorage, recordingKey } from '@/lib/storage';
import {
  chooseSttMode, pollBatchJob, transcribeChunked, sarvamConfigFrom, startBatchJob, transcribeSync, type SarvamConfig, type SttResult, type SttSegment,
} from '@/lib/providers/sarvam';
import { networkReason } from '@/lib/providers/anthropic';
import { resolveMyOperatorRecording } from './myoperator-recording';
export { myOperatorFileName } from './myoperator-recording';

const MAX_RECORDING_BYTES = 200 * 1024 * 1024;
const BATCH_POLL_MS = 20_000;
const BATCH_INLINE_WAIT_MS = 4 * 60_000;   // poll inline this long, then defer the job and resume later
const BATCH_MAX_AGE_MS = 6 * 3600_000;

// ───────────────────────── Recording access hook ─────────────────────────
export interface RecordingFetchArgs { db: Db; orgId: string; connectionId: string | null; sourcePlatform: string; ref: string; sourceRecordId?: string | null }
export type RecordingFetcher = (a: RecordingFetchArgs) => Promise<{ url: string; init?: RequestInit } | null>;
const fetchers = new Map<string, RecordingFetcher>();
export function registerRecordingFetcher(platform: string, fn: RecordingFetcher) { fetchers.set(platform, fn); }

/** Resolve how to fetch a recording. Called inside an org transaction (may read connection secrets). */
export async function getRecordingFetchInit(a: RecordingFetchArgs): Promise<{ url: string; init?: RequestInit }> {
  const custom = fetchers.get(a.sourcePlatform);
  if (custom) {
    const r = await custom(a);
    if (r) return r;
  }
  if (a.sourcePlatform === 'myoperator') return resolveMyOperatorRecording(a);
  if (/^https?:\/\//i.test(a.ref)) return { url: a.ref };
  throw new PipelineError(`Recording reference for ${a.sourcePlatform} is not a downloadable URL and no authorised fetcher is configured.`, { retryable: false });
}

export async function downloadRecording(target: { url: string; init?: RequestInit }): Promise<{ data: Buffer; mime: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  let res: Response;
  try {
    res = await fetch(target.url, { ...target.init, signal: ctrl.signal, redirect: 'follow' });
  } catch (e: any) {
    throw new PipelineError(e?.name === 'AbortError' ? 'Timed out downloading the call recording.' : `Could not download the call recording (${networkReason(e)}).`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 || res.status === 410) throw new PipelineError(`The provider no longer has this recording (HTTP ${res.status}).`, { retryable: false });
  if (res.status === 401 || res.status === 403) throw new PipelineError(`The provider refused access to this recording (HTTP ${res.status}). Check the call-platform integration permissions.`, { retryable: false });
  if (res.status === 429) throw new PipelineError('The call platform rate-limited the recording download (HTTP 429).', { retryable: true, retryAfterMs: 5 * 60_000 });
  if (!res.ok) throw new PipelineError(`Recording download failed (HTTP ${res.status}).`, { retryable: res.status >= 500 });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_RECORDING_BYTES) throw new PipelineError('Recording is larger than 200 MB and cannot be transcribed.', { retryable: false });
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_RECORDING_BYTES) throw new PipelineError('Recording is larger than 200 MB and cannot be transcribed.', { retryable: false });
  if (data.length < 512) throw new PipelineError('The downloaded recording is empty or not an audio file.', { retryable: false });
  let mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('audio/') && !mime.startsWith('video/')) mime = sniffAudioMime(data) ?? 'audio/mpeg';
  return { data, mime };
}

export function sniffAudioMime(b: Buffer): string | null {
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (b.slice(0, 3).toString('ascii') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.slice(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (b.slice(0, 4).toString('ascii') === 'fLaC') return 'audio/flac';
  if (b.slice(4, 8).toString('ascii') === 'ftyp') return 'audio/mp4';
  if (b.slice(0, 6).toString('ascii') === '#!AMR\n') return 'audio/amr';
  return null;
}

// ───────────────────────── Speaker mapping ─────────────────────────
const AGENT_GREETING = /\b(rosier|thank you for (calling|contacting)|thanks for calling|how (can|may) i (help|assist)|customer (care|support)|support team|my name is|main .{1,20} (bol|baat kar) (raha|rahi)|kaise (madad|help)|aapki (kya )?(madad|sahayata))\b/i;

/**
 * Map diarized speaker ids to agent/customer. A speaker is labelled agent ONLY when their first utterance matches agent
 * greeting patterns; the other speaker (2-speaker calls) becomes the customer. Otherwise everything stays 'unknown'
 * and the AI analysis step infers labels from content.
 */
export function mapSpeakers(segments: SttSegment[]): { speakers: ('agent' | 'customer' | 'unknown')[]; note: string } {
  const ids = Array.from(new Set(segments.map((s) => s.speakerId).filter((x): x is string => x !== null)));
  if (!ids.length) return { speakers: segments.map(() => 'unknown'), note: 'No diarization — speakers to be inferred during AI analysis.' };
  const firstUtterance = new Map<string, string>();
  for (const s of segments) if (s.speakerId !== null && !firstUtterance.has(s.speakerId)) firstUtterance.set(s.speakerId, s.text);
  // also consider the first ~2 utterances of each speaker (greetings sometimes follow a "hello?")
  const firstTwo = new Map<string, string>();
  for (const s of segments) if (s.speakerId !== null) firstTwo.set(s.speakerId, ((firstTwo.get(s.speakerId) ?? '') + ' ' + s.text).slice(0, 400));
  const matches = ids.filter((id) => AGENT_GREETING.test(firstUtterance.get(id) ?? '') || AGENT_GREETING.test(firstTwo.get(id) ?? ''));
  if (matches.length !== 1) return { speakers: segments.map(() => 'unknown'), note: matches.length ? 'Several speakers matched agent greeting patterns — left unknown.' : 'No agent greeting recognised — speakers left unknown for AI inference.' };
  const agentId = matches[0];
  const twoSpeakers = ids.length === 2;
  return {
    speakers: segments.map((s) => s.speakerId === agentId ? 'agent' : (twoSpeakers && s.speakerId !== null ? 'customer' : 'unknown')),
    note: `Speaker ${agentId} mapped to agent from greeting${twoSpeakers ? '; other speaker mapped to customer' : ''}.`,
  };
}

// ───────────────────────── Job ─────────────────────────
interface CallRow {
  interaction_id: string; org_id: string; is_demo: boolean; source_platform: string; connection_id: string | null; channel: string;
  call_id: string; recording_available: boolean; recording_source_ref: string | null; recording_storage_key: string | null;
  recording_mime: string | null; duration_seconds: number | null; language_hint: string | null; call_status: string;
  source_record_id: string | null;
}

export type TranscribeOutcome = { status: 'completed'; segments: number } | { status: 'deferred' };

export async function runTranscribeJob(job: Pick<Job, 'id' | 'org_id' | 'interaction_id' | 'payload' | 'attempts'>): Promise<TranscribeOutcome> {
  const orgId = job.org_id;
  const interactionId = job.interaction_id;
  if (!interactionId) throw new PipelineError('Transcribe job has no interaction.', { retryable: false });
  try {
    return await transcribeInner(job, orgId, interactionId);
  } catch (e) {
    await markTranscriptionFailed(orgId, interactionId, errorMessage(e), job.attempts, isRetryable(e));
    throw e;
  }
}

async function transcribeInner(job: Pick<Job, 'id' | 'payload' | 'attempts'>, orgId: string, interactionId: string): Promise<TranscribeOutcome> {
  // 1) load + resolve access (short tx)
  const prep = await withOrg(orgId, async (db) => {
    const c = await db.one<CallRow>(
      `SELECT i.id AS interaction_id, i.org_id, i.is_demo, i.source_platform, i.connection_id, i.channel,
              c.id AS call_id, c.recording_available, c.recording_source_ref, c.recording_storage_key, c.recording_mime,
              c.duration_seconds, c.language_hint, c.call_status, i.source_record_id
         FROM interactions i JOIN calls c ON c.interaction_id = i.id WHERE i.id = $1`, [interactionId]);
    if (!c) throw new PipelineError('Call record not found for this interaction.', { retryable: false });
    if (c.is_demo || (c.recording_source_ref ?? '').startsWith('demo://') || c.source_platform === 'demo') {
      throw new PipelineError('Demo recordings are synthetic and are never sent to the speech-to-text provider.', { retryable: false });
    }
    if (!c.recording_available || (!c.recording_source_ref && !c.recording_storage_key)) {
      throw new PipelineError('No authorised recording is available for this call.', { retryable: false });
    }
    const conn = await getProviderConnection(db, 'sarvam', orgId);
    const cfg = sarvamConfigFrom(conn.config, conn.secrets);
    if (c.language_hint && /^(hi|en)(-IN)?$/i.test(c.language_hint) && cfg.languageCode === 'unknown') {
      cfg.languageCode = c.language_hint.slice(0, 2).toLowerCase() + '-IN';
    }
    const settings = await loadOrgSettings(db, orgId);
    await db.exec(`UPDATE interactions SET processing_status = 'transcribing', processing_error = NULL WHERE id = $1`, [interactionId]);
    const target = !job.payload?.sarvam_job_id && !c.recording_storage_key
      ? await getRecordingFetchInit({ db, orgId, connectionId: c.connection_id, sourcePlatform: c.source_platform, ref: c.recording_source_ref!, sourceRecordId: c.source_record_id })
      : null;
    return { c, cfg, settings, target };
  });
  const { c, cfg, settings } = prep;

  // 2) resume a pending Sarvam batch job, if any
  if (job.payload?.sarvam_job_id) {
    return pollAndFinish(job, orgId, interactionId, c, cfg, settings, String(job.payload.sarvam_job_id), Number(job.payload.sarvam_started_at ?? Date.now()));
  }

  // 3) get audio (retained copy first, else provider)
  let audio: { data: Buffer; mime: string };
  const storage = getStorage();
  const stored = c.recording_storage_key ? await storage.get(c.recording_storage_key) : null;
  if (stored) audio = { data: stored.body, mime: stored.contentType ?? c.recording_mime ?? 'audio/mpeg' };
  else {
    const target = prep.target ?? await withOrg(orgId, (db) => getRecordingFetchInit({ db, orgId, connectionId: c.connection_id, sourcePlatform: c.source_platform, ref: c.recording_source_ref!, sourceRecordId: c.source_record_id }));
    audio = await downloadRecording(target);
  }

  // 4) optional private copy (retention.recordingsDays > 0)
  if (!stored && Number(settings.retention?.recordingsDays ?? 0) > 0) {
    try {
      const key = recordingKey(orgId, interactionId, audio.mime);
      await storage.put(key, audio.data, audio.mime);
      await withOrg(orgId, (db) => db.exec(`UPDATE calls SET recording_storage_key = $2, recording_mime = $3 WHERE id = $1`, [c.call_id, key, audio.mime]));
    } catch (e) {
      console.warn(`[transcribe] could not store private recording copy for ${interactionId}: ${errorMessage(e)}`);
    }
  }

  // 5) transcribe
  const fileName = `call-${interactionId.slice(0, 8)}${extOf(audio.mime)}`;
  const mode = chooseSttMode(cfg, c.duration_seconds);
  if (mode === 'sync') {
    let result: SttResult;
    try {
      result = await transcribeSync(cfg, audio.data, { fileName, mime: audio.mime });
    } catch (e) {
      // the sync API rejects audio over its limit — fall back to batch
      if (e instanceof ProviderError && (e.status === 400 || e.status === 422)) return startAndPoll(job, orgId, interactionId, c, cfg, settings, audio, fileName);
      throw e;
    }
    if (settings.ai?.translateToEnglish && cfg.translation === 'sarvam' && result.language && !result.language.startsWith('en')) {
      try { result.translationEn = (await transcribeSync(cfg, audio.data, { fileName, mime: audio.mime, mode: 'translate' })).fullText || null; } catch { /* optional */ }
    }
    return finish(orgId, interactionId, c, settings, result, job.attempts);
  }
  return startAndPoll(job, orgId, interactionId, c, cfg, settings, audio, fileName);
}

async function startAndPoll(job: Pick<Job, 'id' | 'payload' | 'attempts'>, orgId: string, interactionId: string, c: CallRow, cfg: SarvamConfig, settings: any, audio: { data: Buffer; mime: string }, fileName: string) {
  let h: Awaited<ReturnType<typeof startBatchJob>>;
  try {
    h = await startBatchJob(cfg, audio.data, { fileName, mime: audio.mime });
  } catch (e) {
    // Batch service failing (5xx / unreachable): transcribe in short pieces with the sync API instead.
    if (!(e instanceof ProviderError) || !e.retryable || (e.status ?? 500) === 429) throw e;
    console.warn(`[transcribe] Sarvam batch unavailable for ${interactionId} (${errorMessage(e)}); using short-piece transcription.`);
    const r = await transcribeChunked(cfg, audio.data, { fileName, mime: audio.mime });
    if (!r) throw e;
    return finish(orgId, interactionId, c, settings, r, job.attempts);
  }
  let translationJobId: string | null = null;
  if (settings.ai?.translateToEnglish && cfg.translation === 'sarvam' && cfg.languageCode !== 'en-IN') {
    try { translationJobId = (await startBatchJob(cfg, audio.data, { fileName, mime: audio.mime, mode: 'translate', diarize: false })).jobId; } catch { /* optional */ }
  }
  if (translationJobId) job.payload = { ...(job.payload ?? {}), sarvam_translation_job_id: translationJobId };
  return pollAndFinish(job, orgId, interactionId, c, cfg, settings, h.jobId, Date.now());
}

async function pollAndFinish(job: Pick<Job, 'id' | 'payload' | 'attempts'>, orgId: string, interactionId: string, c: CallRow, cfg: SarvamConfig, settings: any, jobId: string, startedAt: number): Promise<TranscribeOutcome> {
  const until = Date.now() + BATCH_INLINE_WAIT_MS;
  for (;;) {
    const p = await pollBatchJob(cfg, jobId);
    if (p.state === 'failed') throw new PipelineError(`Sarvam could not transcribe this recording: ${p.message}`, { retryable: false });
    if (p.state === 'completed') {
      const tId = job.payload?.sarvam_translation_job_id;
      if (tId) {
        try { const t = await pollBatchJob(cfg, String(tId)); if (t.state === 'completed') p.result.translationEn = t.result.fullText || null; } catch { /* optional */ }
      }
      return finish(orgId, interactionId, c, settings, p.result, job.attempts);
    }
    if (Date.now() - startedAt > BATCH_MAX_AGE_MS) throw new PipelineError('Sarvam batch transcription did not finish within 6 hours.', { retryable: true });
    if (Date.now() > until) {
      await withOrg(orgId, (db) => deferJob(db, job, 60_000, { sarvam_job_id: jobId, sarvam_started_at: startedAt, ...(job.payload?.sarvam_translation_job_id ? { sarvam_translation_job_id: job.payload.sarvam_translation_job_id } : {}) }));
      return { status: 'deferred' };
    }
    await new Promise((r) => setTimeout(r, BATCH_POLL_MS));
  }
}

async function finish(orgId: string, interactionId: string, c: CallRow, settings: any, r: SttResult, attempt: number): Promise<TranscribeOutcome> {
  const { speakers } = mapSpeakers(r.segments);
  await withOrg(orgId, async (db) => {
    await db.exec(`UPDATE call_transcripts SET is_current = false WHERE interaction_id = $1 AND is_current`, [interactionId]);
    const t = await db.one<{ id: string }>(
      `INSERT INTO call_transcripts (org_id, call_id, interaction_id, provider, model, language, status, attempt, diarized, full_text, translation_en, is_current)
       VALUES ($1,$2,$3,'sarvam',$4,$5,'completed',$6,$7,$8,$9,true) RETURNING id`,
      [orgId, c.call_id, interactionId, `${r.model} (${r.mode})`, r.language, attempt, r.diarized, r.fullText, r.translationEn]);
    let seq = 0;
    for (let k = 0; k < r.segments.length; k++) {
      const s = r.segments[k];
      await db.exec(
        `INSERT INTO transcript_segments (org_id, transcript_id, interaction_id, seq, speaker, start_ms, end_ms, text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orgId, t!.id, interactionId, seq++, speakers[k], s.startMs, Math.max(s.endMs, s.startMs), s.text]);
    }
    await db.exec(`UPDATE interactions SET processing_status = 'analysis_pending', processing_error = NULL WHERE id = $1`, [interactionId]);
    await db.exec('SELECT rsi_refresh_search_text($1)', [interactionId]);
    if (settings.ai?.autoAnalyze !== false) await enqueueProcessing(db, orgId, interactionId, { reason: 'transcribed' });
  });
  return { status: 'completed', segments: r.segments.length };
}

async function markTranscriptionFailed(orgId: string, interactionId: string, message: string, attempt: number, retryable: boolean) {
  try {
    await withOrg(orgId, async (db) => {
      const c = await db.one<{ id: string }>('SELECT id FROM calls WHERE interaction_id = $1', [interactionId]);
      if (c) {
        const hasCompleted = await db.one(`SELECT 1 FROM call_transcripts WHERE interaction_id = $1 AND is_current AND status = 'completed'`, [interactionId]);
        if (!hasCompleted) await db.exec(`UPDATE call_transcripts SET is_current = false WHERE interaction_id = $1 AND is_current`, [interactionId]);
        await db.exec(
          `INSERT INTO call_transcripts (org_id, call_id, interaction_id, provider, status, error, attempt, is_current) VALUES ($1,$2,$3,'sarvam','failed',$4,$5,$6)`,
          [orgId, c.id, interactionId, message.slice(0, 1000), attempt, !hasCompleted]);
      }
      await db.exec(`UPDATE interactions SET processing_status = 'failed', processing_error = $2 WHERE id = $1`,
        [interactionId, `Transcription failed: ${message}${retryable ? ' (will retry automatically)' : ''}`.slice(0, 1000)]);
    });
  } catch { /* job error still recorded */ }
}

function extOf(mime: string) {
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return '.m4a';
  if (mime.includes('flac')) return '.flac';
  if (mime.includes('amr')) return '.amr';
  return '.mp3';
}
