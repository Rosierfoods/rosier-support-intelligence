import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { REPORTS } from '@/lib/repos/reports';
import { Badge, PageHeader } from '@/components/ui';
import { RANGE_PRESETS } from '@/lib/filters';
import { FileBarChart, Download, Printer } from 'lucide-react';

export const metadata = { title: 'Reports & Analytics' };

export default async function ReportsPage() {
  const s = await requirePermission('reports.view');
  const canExport = s.permissions.has('reports.export');
  return (
    <div className="space-y-5">
      <PageHeader title="Reports & Analytics" description="Standard reports with filters, drill-down to the underlying conversations, CSV export and print-ready layouts." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map((r) => (
          <Link key={r.key} href={`/reports/${r.key}`} className="card group flex flex-col p-4 transition-colors hover:border-brand-500/40">
            <div className="flex items-start justify-between gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand"><FileBarChart size={18} aria-hidden /></span>
              <Badge tone="muted">{r.cadence}</Badge>
            </div>
            <h2 className="mt-3 text-sm font-semibold text-ink group-hover:text-brand">{r.title}</h2>
            <p className="mt-1 flex-1 text-xs leading-relaxed text-ink-muted">{r.description}</p>
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint">
              <span>Default: {RANGE_PRESETS.find((p) => p.key === r.defaultRange)?.label}</span>
              {canExport && <span className="inline-flex items-center gap-1"><Download size={11} aria-hidden /> CSV</span>}
              <span className="inline-flex items-center gap-1"><Printer size={11} aria-hidden /> Print / PDF</span>
            </p>
          </Link>
        ))}
      </div>
      {!canExport && <p className="text-xs text-ink-muted">CSV export requires the “Export reports / CSV” permission.</p>}
      <p className="text-2xs text-ink-faint">Customer issue trends and Pareto analysis live on <Link className="link" href="/issues">Customer Issues & Root Causes</Link>; agent comparisons on <Link className="link" href="/agents">Agent Performance</Link>.</p>
    </div>
  );
}
