import Link from 'next/link';
import clsx from 'clsx';
import { withParams, type SP } from '@/lib/filters';

/** Link-based segmented control bound to a URL param (works without JS). */
export function Segmented({ basePath, searchParams, name, options, value, label }: {
  basePath: string; searchParams: SP; name: string; options: { value: string; label: string }[]; value: string; label: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-white p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <Link key={o.value} href={`${basePath}${withParams(searchParams, { [name]: o.value, page: undefined })}`} scroll={false}
          aria-current={value === o.value ? 'true' : undefined}
          className={clsx('rounded-md px-2.5 py-1 text-xs font-medium', value === o.value ? 'bg-brand text-white' : 'text-ink-muted hover:text-ink')}>
          {o.label}
        </Link>
      ))}
    </div>
  );
}

/** Tab strip for multi-section admin pages. */
export function Tabs({ basePath, searchParams, value, tabs }: {
  basePath: string; searchParams: SP; value: string; tabs: { value: string; label: string; count?: number }[];
}) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line scrollbar-thin" aria-label="Sections">
      {tabs.map((t) => (
        <Link key={t.value} href={`${basePath}${withParams({}, { tab: t.value })}`}
          aria-current={value === t.value ? 'page' : undefined}
          className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
            value === t.value ? 'border-brand text-brand' : 'border-transparent text-ink-muted hover:text-ink')}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-sand/60 px-1.5 text-2xs text-ink-muted">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
