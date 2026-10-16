import type { ReactNode } from 'react';
import { DemoBadge } from '@/components/ui';
import { fmtDate } from '@/lib/format';

/** Standard "n = …, date range, method" footer/header line used on analytics and report pages. */
export function SampleNote({ n, unit = 'interactions', from, to, demo, children }: {
  n: number; unit?: string; from: Date; to: Date; demo?: boolean; children?: ReactNode;
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
      <span>n = <span className="font-medium tabular-nums text-ink">{n.toLocaleString('en-IN')}</span> {unit}</span>
      <span aria-hidden>·</span>
      <span>{fmtDate(from)} – {fmtDate(to)} (IST)</span>
      {demo && <DemoBadge />}
      {children}
    </span>
  );
}
