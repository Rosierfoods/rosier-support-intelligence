import { Badge } from '@/components/ui';
import { ScoreBadge } from '@/components/badges';
import { fmtNum, fmtPct } from '@/lib/format';
import { MIN_SAMPLE } from './format';

/** Score that is suppressed below the minimum sample size (fairness rule). */
export function GatedScore({ value, n, kind = 'score' }: { value: number | null; n: number; kind?: 'score' | 'pct' | 'num' }) {
  if (n < MIN_SAMPLE || value === null || value === undefined) {
    return <span className="whitespace-nowrap text-2xs text-ink-faint" title={`Insufficient data: n=${n}, at least ${MIN_SAMPLE} needed`}>insufficient data{n > 0 ? ` (n=${n})` : ''}</span>;
  }
  return (
    <span className="whitespace-nowrap">
      {kind === 'score' ? <ScoreBadge score={value} /> : <span className="tabular-nums">{kind === 'pct' ? fmtPct(value, 0) : fmtNum(value, 1)}</span>}
      <span className="ml-1 text-2xs text-ink-faint">n={n}</span>
    </span>
  );
}

export function DeltaBadge({ cur, prev, nCur, nPrev }: { cur: number | null; prev: number | null; nCur: number; nPrev: number }) {
  if (cur === null || prev === null || nCur < MIN_SAMPLE || nPrev < MIN_SAMPLE) return <span className="text-2xs text-ink-faint" title="Needs ≥5 evaluations in both periods">—</span>;
  const d = cur - prev;
  const tone = Math.abs(d) < 1 ? 'neutral' : d > 0 ? 'good' : 'warn';
  return <Badge tone={tone}><span className="tabular-nums">{d > 0 ? '+' : ''}{d.toFixed(1)}</span></Badge>;
}
