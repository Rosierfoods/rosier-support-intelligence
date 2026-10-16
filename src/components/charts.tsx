'use client';
/**
 * Chart primitives (Recharts). Palette validated with the dataviz validator (light surface):
 *   channel categorical: #a56312 (call) · #2a78d6 (chat) · #1baf7a (whatsapp) · #6250d6 (email)
 *   aqua is < 3:1 contrast → every multi-series chart ships a legend + table view (relief rule).
 * Rules: one y-axis only, thin marks, 4px rounded bar ends, 2px gaps, recessive grid, hover tooltips.
 */
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, ReferenceLine, LabelList,
} from 'recharts';
import clsx from 'clsx';
import { Table2, BarChart3 } from 'lucide-react';

import { SINGLE } from '@/lib/palette';
const GRID = '#efe9dd';
const AXIS = { fontSize: 11, fill: '#6b6258' };

/** Replace {field} placeholders with values from the clicked row (functions can't cross the server→client boundary). */
export function fillTemplate(t: string, row: Record<string, any>) {
  return t.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(row[k] ?? ''));
}

export interface SeriesDef { key: string; label: string; color: string }

function TooltipBox({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="mb-1 font-medium text-ink">{label}</p>}
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-ink-muted">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color ?? p.fill }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums text-ink">{fmt ? fmt(p.value) : Number(p.value).toLocaleString('en-IN')}</span>
        </p>
      ))}
    </div>
  );
}

/** Card wrapper with a chart ⇄ table toggle (table view = accessibility relief). */
export function ChartCard({ title, subtitle, actions, table, children, className }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string;
  table?: { columns: string[]; rows: (string | number)[][] }; children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={clsx('card flex flex-col', className)}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {table && (
            <button type="button" onClick={() => setAsTable((v) => !v)} title={asTable ? 'Show chart' : 'Show as table'}
              className="rounded-md p-1 text-ink-faint hover:bg-brand-50 hover:text-ink" aria-label={asTable ? 'Show chart' : 'Show as table'}>
              {asTable ? <BarChart3 size={15} /> : <Table2 size={15} />}
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 p-4">
        {asTable && table ? (
          <div className="max-h-80 overflow-auto scrollbar-thin">
            <table className="min-w-full text-xs">
              <thead><tr>{table.columns.map((c) => <th key={c} className="th">{c}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="px-3 py-1.5 tabular-nums">{typeof v === 'number' ? v.toLocaleString('en-IN') : v}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        ) : children}
      </div>
    </section>
  );
}

export function StackedBars({ data, xKey, series, height = 260, hrefTemplate, yFmt }: {
  data: Record<string, any>[]; xKey: string; series: SeriesDef[]; height?: number; hrefTemplate?: string; yFmt?: (v: number) => string;
}) {
  const router = useRouter();
  if (!data.length) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap="22%"
        onClick={(e: any) => { if (hrefTemplate && e?.activePayload?.[0]) router.push(fillTemplate(hrefTemplate, e.activePayload[0].payload)); }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={12} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={yFmt} />
        <Tooltip content={<TooltipBox />} cursor={{ fill: 'rgba(120,73,0,0.05)' }} />
        <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} stroke="#fff" strokeWidth={1}
            radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} cursor={hrefTemplate ? 'pointer' : undefined} maxBarSize={36} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Lines({ data, xKey, series, height = 240, yFmt, yDomain }: {
  data: Record<string, any>[]; xKey: string; series: SeriesDef[]; height?: number; yFmt?: (v: number) => string; yDomain?: [number, number];
}) {
  if (!data.length) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={12} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={yFmt} domain={yDomain ?? ['auto', 'auto']} allowDecimals={false} />
        <Tooltip content={<TooltipBox fmt={yFmt} />} cursor={{ stroke: '#d6cdbd' }} />
        {series.length > 1 && <Legend iconType="plainline" iconSize={12} wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />}
        {series.map((s) => (
          <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false}
            activeDot={{ r: 4, stroke: '#fff', strokeWidth: 2 }} connectNulls type="monotone" />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ColumnBars({ data, xKey, yKey, label, height = 220, color = SINGLE, hrefTemplate, yFmt, refLine, showValues }: {
  data: Record<string, any>[]; xKey: string; yKey: string; label: string; height?: number; color?: string;
  hrefTemplate?: string; yFmt?: (v: number) => string; refLine?: { y: number; label: string }; showValues?: boolean;
}) {
  const router = useRouter();
  if (!data.length) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: showValues ? 16 : 4, right: 4, bottom: 0, left: -18 }} barCategoryGap="18%"
        onClick={(e: any) => { if (hrefTemplate && e?.activePayload?.[0]) router.push(fillTemplate(hrefTemplate, e.activePayload[0].payload)); }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={6} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={yFmt} />
        <Tooltip content={<TooltipBox fmt={yFmt} />} cursor={{ fill: 'rgba(120,73,0,0.05)' }} />
        {refLine && <ReferenceLine y={refLine.y} stroke="#b45309" strokeDasharray="4 3" label={{ value: refLine.label, fontSize: 10, fill: '#92400e', position: 'insideTopRight' }} />}
        <Bar dataKey={yKey} name={label} fill={color} radius={[4, 4, 0, 0]} maxBarSize={34} cursor={hrefTemplate ? 'pointer' : undefined}>
          {showValues && <LabelList dataKey={yKey} position="top" style={{ fontSize: 10, fill: '#6b6258' }} formatter={yFmt as any} />}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Horizontal ranked list with inline bars — plain HTML, fully clickable for drill-down. */
export function HBarList({ rows, valueFmt, max }: {
  rows: { label: string; value: number; sub?: string; href?: string; color?: string }[]; valueFmt?: (v: number) => string; max?: number;
}) {
  const router = useRouter();
  if (!rows.length) return <EmptyChart />;
  const m = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label}>
          <button type="button" disabled={!r.href} onClick={() => r.href && router.push(r.href)}
            className={clsx('group block w-full text-left', r.href && 'cursor-pointer')}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className={clsx('truncate text-ink', r.href && 'group-hover:text-brand group-hover:underline')}>{r.label}</span>
              <span className="shrink-0 tabular-nums text-ink-muted">
                <span className="font-medium text-ink">{valueFmt ? valueFmt(r.value) : r.value.toLocaleString('en-IN')}</span>
                {r.sub && <span className="ml-1.5">{r.sub}</span>}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-sand/50">
              <div className="h-2 rounded-full" style={{ width: `${Math.max(2, (r.value / m) * 100)}%`, background: r.color ?? SINGLE }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function EmptyChart({ message = 'No data for the selected filters.' }: { message?: string }) {
  return <div className="flex h-40 items-center justify-center text-sm text-ink-muted">{message}</div>;
}
