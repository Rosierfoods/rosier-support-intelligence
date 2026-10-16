'use client';
import { useEffect, useState } from 'react';
import { useSetParams } from '@/components/filters';

/** Quality score min/max inputs bound to ?score_min= & ?score_max=. */
export function ScoreRangeFilter() {
  const { set, params, pending } = useSetParams();
  const [min, setMin] = useState(params.get('score_min') ?? '');
  const [max, setMax] = useState(params.get('score_max') ?? '');
  const pk = params.toString();
  const [prevPk, setPrevPk] = useState(pk);
  if (prevPk !== pk) { setPrevPk(pk); setMin(params.get('score_min') ?? ''); setMax(params.get('score_max') ?? ''); }
  const valid = (v: string) => v === '' || (!Number.isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100);
  return (
    <form
      className={`flex items-center gap-1 ${pending ? 'opacity-60' : ''}`}
      onSubmit={(e) => { e.preventDefault(); if (valid(min) && valid(max)) set({ score_min: min || null, score_max: max || null }); }}
    >
      <span className="text-2xs font-medium text-ink-muted">Score</span>
      <input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="min" aria-label="Minimum quality score"
        className={`input h-8 w-14 px-2 text-xs ${valid(min) ? '' : 'border-red-400'}`} />
      <span className="text-xs text-ink-faint">–</span>
      <input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder="max" aria-label="Maximum quality score"
        className={`input h-8 w-14 px-2 text-xs ${valid(max) ? '' : 'border-red-400'}`} />
      <button type="submit" className="h-8 rounded-lg border border-line bg-white px-2 text-xs font-medium text-ink hover:bg-brand-50">Apply</button>
    </form>
  );
}

/** Checkbox bound to a URL flag param (value "1"). */
export function ParamToggle({ name, label }: { name: string; label: string }) {
  const { set, params } = useSetParams();
  const on = params.get(name) === '1';
  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs text-ink hover:bg-brand-50">
      <input type="checkbox" checked={on} onChange={(e) => set({ [name]: e.target.checked ? '1' : null })} className="accent-[#784900]" />
      {label}
    </label>
  );
}
