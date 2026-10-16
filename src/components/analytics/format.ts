// Server- and client-safe helpers for analytics pages (no 'use client' here).

export function bucketLabel(b: string, bucket: string) {
  const d = new Date(b + 'T00:00:00');
  if (bucket === 'month') return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function bucketEnd(b: string, bucket: string) {
  const d = new Date(b + 'T00:00:00Z');
  if (bucket === 'week') d.setUTCDate(d.getUTCDate() + 6);
  else if (bucket === 'month') { d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); }
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD in IST — the format /inbox expects for from/to. */
export function istDate(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** Replace {field} placeholders with URL-encoded row values (server-side twin of charts.fillTemplate). */
export function fillHref(t: string, row: Record<string, any>) {
  return t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(row[k] ?? ''));
}

export function pctChange(v: number | null) {
  if (v === null || !Number.isFinite(v)) return '—';
  const p = Math.round(v * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}

/** Minimum sample size before an agent-level score is shown (fairness rule, spec §13). */
export const MIN_SAMPLE = 5;
