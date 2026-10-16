import Link from 'next/link';
import { withParams, type SP } from '@/lib/filters';
import { buttonClass } from './ui';

export function Pagination({ searchParams, page, pageSize, total, basePath }: { searchParams: SP; page: number; pageSize: number; total: number; basePath: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-xs text-ink-muted">
      <span>{from}–{to} of {total.toLocaleString('en-IN')}</span>
      <div className="flex items-center gap-1.5">
        {page > 1 ? <Link className={buttonClass('secondary', 'sm')} href={`${basePath}${withParams(searchParams, { page: page - 1 })}`}>Previous</Link>
          : <span className={buttonClass('secondary', 'sm', 'pointer-events-none opacity-40')}>Previous</span>}
        <span className="px-1">Page {page} of {pages}</span>
        {page < pages ? <Link className={buttonClass('secondary', 'sm')} href={`${basePath}${withParams(searchParams, { page: page + 1 })}`}>Next</Link>
          : <span className={buttonClass('secondary', 'sm', 'pointer-events-none opacity-40')}>Next</span>}
      </div>
    </div>
  );
}

export function SortLink({ searchParams, basePath, field, label }: { searchParams: SP; basePath: string; field: string; label: string }) {
  const cur = (Array.isArray(searchParams.sort) ? searchParams.sort[0] : searchParams.sort) ?? '';
  const [f, dir] = cur.split(':');
  const active = f === field;
  const next = active && dir === 'desc' ? `${field}:asc` : `${field}:desc`;
  return (
    <Link href={`${basePath}${withParams(searchParams, { sort: next, page: undefined })}`} className="inline-flex items-center gap-0.5 hover:text-ink">
      {label}{active ? (dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </Link>
  );
}
