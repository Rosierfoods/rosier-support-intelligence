import Link from 'next/link';
import clsx from 'clsx';
import { SINGLE, WARN_COLOR } from '@/lib/palette';

export interface ParetoRow { label: string; sub?: string; n: number; share: number; cumulative: number; href: string }

/**
 * Pareto as a sorted bar list (single axis): bar = count, right column = cumulative %.
 * A marker row is inserted after the item where the cumulative share first reaches 80% —
 * items above it are the "vital few". No second y-axis.
 */
export function ParetoList({ rows, threshold = 0.8 }: { rows: ParetoRow[]; threshold?: number }) {
  if (!rows.length) return <div className="flex h-40 items-center justify-center text-sm text-ink-muted">No data for the selected filters.</div>;
  const max = Math.max(...rows.map((r) => r.n), 1);
  const cut = rows.findIndex((r) => r.cumulative >= threshold - 1e-9);
  return (
    <div>
      <div className="mb-1.5 grid grid-cols-[1fr_auto_auto] gap-x-3 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        <span>Subcategory</span><span className="w-10 text-right">Count</span><span className="w-14 text-right">Cum. %</span>
      </div>
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.label + i}>
            <Link href={r.href} className="group grid grid-cols-[1fr_auto_auto] items-center gap-x-3 rounded-md py-0.5 hover:bg-brand-50/50">
              <span className="min-w-0">
                <span className="flex items-baseline gap-1.5 text-xs">
                  <span className="truncate text-ink group-hover:text-brand group-hover:underline">{r.label}</span>
                  {r.sub && <span className="hidden shrink-0 text-2xs text-ink-faint sm:inline">{r.sub}</span>}
                </span>
                <span className="mt-0.5 block h-2 w-full rounded-full bg-sand/50">
                  <span className="block h-2 rounded-full" style={{ width: `${Math.max(2, (r.n / max) * 100)}%`, background: cut >= 0 && i <= cut ? SINGLE : '#cbb89a' }} />
                </span>
              </span>
              <span className="w-10 text-right text-xs font-medium tabular-nums text-ink">{r.n}</span>
              <span className={clsx('w-14 text-right text-xs tabular-nums', r.cumulative >= threshold ? 'text-ink-muted' : 'font-medium text-ink')}>
                {(r.cumulative * 100).toFixed(0)}%
              </span>
            </Link>
            {i === cut && i < rows.length - 1 && (
              <div className="my-2 flex items-center gap-2 text-2xs font-medium" style={{ color: WARN_COLOR }} role="separator" aria-label={`${Math.round(threshold * 100)}% of issues above this line`}>
                <span className="h-px flex-1 border-t border-dashed" style={{ borderColor: WARN_COLOR }} />
                {Math.round(threshold * 100)}% of issues come from the {i + 1} item{i ? 's' : ''} above
                <span className="h-px flex-1 border-t border-dashed" style={{ borderColor: WARN_COLOR }} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
