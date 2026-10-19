import Link from 'next/link';
import clsx from 'clsx';
import { withParams, type SP } from '@/lib/filters';

const TABS = [
  { href: '/agents', label: 'Performance' },
  { href: '/agents/activity', label: 'Daily activity' },
  { href: '/agents/review', label: 'Review & accuracy' },
];

/** Tabs across the agent dashboards; keeps the date range and agent/team filters. */
export function AgentTabs({ current, searchParams }: { current: string; searchParams: SP }) {
  const keep = { range: searchParams.range, from: searchParams.from, to: searchParams.to, team: searchParams.team } as SP;
  return (
    <nav className="inline-flex rounded-lg border border-line bg-white p-0.5" aria-label="Agent dashboards">
      {TABS.map((t) => (
        <Link key={t.href} href={`${t.href}${withParams(keep, {})}`} aria-current={current === t.href ? 'page' : undefined}
          className={clsx('rounded-md px-3 py-1.5 text-xs font-medium', current === t.href ? 'bg-brand text-white' : 'text-ink-muted hover:bg-brand-50')}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
