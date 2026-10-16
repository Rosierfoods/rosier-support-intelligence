'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import clsx from 'clsx';

const PRESETS = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7D' }, { key: '30d', label: '30D' }, { key: '90d', label: '90D' }, { key: 'all', label: 'All' },
];

export function useSetParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const set = (updates: Record<string, string | null | undefined>) => {
    const u = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) { if (v === null || v === undefined || v === '') u.delete(k); else u.set(k, v); }
    u.delete('page');
    start(() => router.push(`${pathname}${u.toString() ? `?${u}` : ''}`));
  };
  return { set, params, pending };
}

/** Date-range presets + custom range, stored in the URL (?range= or ?from=&to=). */
export function RangeFilter({ defaultPreset = '30d' }: { defaultPreset?: string }) {
  const { set, params, pending } = useSetParams();
  const current = params.get('from') ? 'custom' : params.get('range') ?? defaultPreset;
  const [custom, setCustom] = useState(current === 'custom');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', pending && 'opacity-60')}>
      <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
        {PRESETS.map((p) => (
          <button key={p.key} type="button" onClick={() => { setCustom(false); set({ range: p.key, from: null, to: null }); }}
            className={clsx('rounded-md px-2.5 py-1 text-xs font-medium', current === p.key ? 'bg-brand text-white' : 'text-ink-muted hover:text-ink')}>
            {p.label}
          </button>
        ))}
        <button type="button" onClick={() => setCustom((v) => !v)}
          className={clsx('rounded-md px-2.5 py-1 text-xs font-medium', current === 'custom' ? 'bg-brand text-white' : 'text-ink-muted hover:text-ink')}>
          Custom
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-1.5">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input h-8 w-auto text-xs" aria-label="From date" />
          <span className="text-xs text-ink-faint">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input h-8 w-auto text-xs" aria-label="To date" />
          <button type="button" disabled={!from} onClick={() => set({ from, to: to || null, range: null })}
            className="h-8 rounded-lg bg-brand px-2.5 text-xs font-medium text-white disabled:opacity-50">Apply</button>
        </div>
      )}
    </div>
  );
}

/** Generic select bound to a URL param. */
export function ParamSelect({ name, options, placeholder, className }: {
  name: string; options: { value: string; label: string }[]; placeholder: string; className?: string;
}) {
  const { set, params } = useSetParams();
  return (
    <select value={params.get(name) ?? ''} onChange={(e) => set({ [name]: e.target.value || null })}
      className={clsx('input h-8 w-auto min-w-[8rem] py-0 text-xs', className)} aria-label={placeholder}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function ParamSearch({ name = 'q', placeholder }: { name?: string; placeholder: string }) {
  const { set, params } = useSetParams();
  const [v, setV] = useState(params.get(name) ?? '');
  return (
    <form onSubmit={(e) => { e.preventDefault(); set({ [name]: v.trim() || null }); }} className="flex-1 min-w-[12rem]">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="input h-8 text-xs" aria-label={placeholder} />
    </form>
  );
}

export function ClearFilters({ keep = [] as string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const kept = new URLSearchParams();
  keep.forEach((k) => { const v = params.get(k); if (v) kept.set(k, v); });
  const has = Array.from(params.keys()).some((k) => !keep.includes(k));
  if (!has) return null;
  return (
    <button type="button" onClick={() => router.push(`${pathname}${kept.toString() ? `?${kept}` : ''}`)} className="text-xs text-brand hover:underline">
      Clear filters
    </button>
  );
}
