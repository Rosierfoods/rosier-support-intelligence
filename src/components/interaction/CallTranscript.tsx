'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { Search, Languages, AlertTriangle } from 'lucide-react';
import type { FlagMarker } from './types';

export interface Segment { seq: number; speaker: string; start_ms: number; end_ms: number; text: string; text_en: string | null }

function mmss(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Wrap case-insensitive occurrences of `q` in <mark class="hl">. */
export function highlight(text: string, q: string): ReactNode {
  if (!q.trim()) return text;
  const parts = text.split(new RegExp(`(${escapeRe(q.trim())})`, 'gi'));
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="hl">{p}</mark> : p));
}

const SEV_RING: Record<string, string> = {
  critical: 'ring-red-400 bg-red-50/70', high: 'ring-amber-400 bg-amber-50/70', medium: 'ring-brand-500/60 bg-brand-50', low: 'ring-stone-300 bg-stone-50',
};

export function CallTranscript({ interactionId, segments, audioSrc, audioNote, targetSeq, selectedFlag, markers, fullTranslation, focusLabel }: {
  interactionId: string; segments: Segment[]; audioSrc: string | null; audioNote: string | null; targetSeq: number | null;
  selectedFlag: FlagMarker | null; markers: Record<number, FlagMarker[]>; fullTranslation: string | null; focusLabel: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [q, setQ] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [english, setEnglish] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [current, setCurrent] = useState<number>(-1);
  const hasSegTranslation = segments.some((s) => s.text_en);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return new Set<number>();
    return new Set(segments.filter((s) => s.text.toLowerCase().includes(needle) || (s.text_en ?? '').toLowerCase().includes(needle)).map((s) => s.seq));
  }, [q, segments]);

  // Pre-position the player at the evidence timestamp (without autoplay).
  useEffect(() => {
    const a = audioRef.current;
    const seg = segments.find((s) => s.seq === targetSeq);
    if (!a || !seg) return;
    const set = () => { try { a.currentTime = seg.start_ms / 1000; } catch { /* not seekable yet */ } };
    if (a.readyState >= 1) set(); else a.addEventListener('loadedmetadata', set, { once: true });
  }, [targetSeq, segments]);

  const seek = (ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => {});
  };

  const onTime = () => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.currentTime * 1000;
    const seg = segments.find((s) => t >= s.start_ms && t < s.end_ms);
    setCurrent(seg?.seq ?? -1);
  };

  const shown = onlyMatches && q.trim() ? segments.filter((s) => matches.has(s.seq)) : segments;

  return (
    <div>
      {audioSrc ? (
        <div className="border-b border-line px-4 py-3">
          <audio ref={audioRef} controls preload="metadata" src={audioSrc} className="w-full" onTimeUpdate={onTime}
            onError={() => setAudioError('The recording could not be loaded. It may have expired at the provider, or playback is not configured.')}
            aria-label="Call recording" />
          {audioError && <p className="mt-1.5 text-2xs text-red-700" role="alert">{audioError}</p>}
          <p className="mt-1 text-2xs text-ink-faint">Playback is streamed through an authorised proxy and logged in the audit trail. Click a timestamp to jump there.</p>
        </div>
      ) : audioNote ? (
        <div className="border-b border-line px-4 py-2.5 text-xs text-ink-muted">{audioNote}</div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <div className="relative min-w-[12rem] flex-1">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search within transcript…" aria-label="Search within transcript"
            className="input h-8 pl-8 text-xs" />
        </div>
        {q.trim() && (
          <>
            <span className="text-2xs text-ink-muted" aria-live="polite">{matches.size} matching segment{matches.size === 1 ? '' : 's'}</span>
            <label className="inline-flex items-center gap-1 text-2xs text-ink-muted">
              <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} className="accent-[#784900]" /> Only matches
            </label>
          </>
        )}
        {(hasSegTranslation || fullTranslation) && (
          <button type="button" onClick={() => setEnglish((v) => !v)} aria-pressed={english}
            className={clsx('inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium',
              english ? 'border-brand bg-brand text-white' : 'border-line bg-white text-ink hover:bg-brand-50')}>
            <Languages size={13} /> English translation
          </button>
        )}
      </div>

      {english && !hasSegTranslation && fullTranslation && (
        <div className="border-b border-line bg-sky-50/50 px-4 py-3">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-sky-800">Machine translation (English)</p>
          <p className="whitespace-pre-wrap text-sm text-ink">{fullTranslation}</p>
        </div>
      )}

      <ol className="divide-y divide-line/70" aria-label="Timestamped transcript">
        {shown.map((s) => {
          const isTarget = s.seq === targetSeq;
          const segFlags = markers[s.seq] ?? [];
          const isAgent = s.speaker === 'agent';
          return (
            <li key={s.seq} id={isTarget ? 'evidence' : `seg-${s.seq}`} tabIndex={isTarget ? -1 : undefined}
              className={clsx('flex gap-3 px-4 py-2.5 outline-none transition-colors',
                isTarget && clsx('ring-2 ring-inset', SEV_RING[selectedFlag?.severity ?? 'medium']),
                !isTarget && current === s.seq && 'bg-brand-50/60')}>
              <div className="w-14 shrink-0 pt-0.5">
                {audioSrc ? (
                  <button type="button" onClick={() => seek(s.start_ms)} className="font-mono text-2xs text-brand hover:underline"
                    aria-label={`Play from ${mmss(s.start_ms)}`}>{mmss(s.start_ms)}</button>
                ) : <span className="font-mono text-2xs text-ink-muted">{mmss(s.start_ms)}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className={clsx('text-2xs font-semibold uppercase tracking-wide', isAgent ? 'text-brand' : s.speaker === 'customer' ? 'text-sky-800' : 'text-ink-faint')}>
                  {isAgent ? 'Agent' : s.speaker === 'customer' ? 'Customer' : 'Speaker'}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink">{highlight(english && s.text_en ? s.text_en : s.text, q)}</p>
                {english && s.text_en && <p className="mt-0.5 text-2xs text-ink-faint">Original: {s.text}</p>}
                {isTarget && selectedFlag && (
                  <div className="mt-2 rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-xs">
                    <p className="flex items-center gap-1 font-medium text-amber-900"><AlertTriangle size={13} /> {selectedFlag.title}</p>
                    <p className="mt-0.5 text-ink-muted"><span className="font-medium text-ink">AI reason:</span> {selectedFlag.reason}</p>
                  </div>
                )}
                {isTarget && !selectedFlag && focusLabel && <p className="mt-1 text-2xs font-medium text-brand">{focusLabel}</p>}
                {segFlags.filter((f) => !(isTarget && f.id === selectedFlag?.id)).map((f) => (
                  <Link key={f.id} href={`/inbox/${interactionId}?flag=${f.id}#evidence`} scroll={false}
                    className="mt-1 mr-1 inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-2xs text-amber-900 ring-1 ring-inset ring-amber-200 hover:bg-amber-100">
                    <AlertTriangle size={11} /> {f.title}
                  </Link>
                ))}
              </div>
            </li>
          );
        })}
        {!shown.length && <li className="px-4 py-6 text-center text-sm text-ink-muted">No segments match “{q}”.</li>}
      </ol>
    </div>
  );
}
