'use client';
import { useState } from 'react';
import clsx from 'clsx';
import { buttonClass } from '@/components/ui';

/** Rubric group weights with a live "must total 100" check. Server re-validates. */
export function WeightsForm({ action, scope, label, groups, initial, inherited, fallback }: {
  action: (fd: FormData) => Promise<void>;
  scope: string; label: string;
  groups: { key: string; label: string }[];
  initial: Record<string, number>;
  inherited?: boolean;            // channel currently inherits the default weights
  fallback?: Record<string, number>;
}) {
  const [inherit, setInherit] = useState(!!inherited);
  const [w, setW] = useState<Record<string, number>>(initial);
  const shown = inherit && fallback ? fallback : w;
  const sum = groups.reduce((a, g) => a + (Number(shown[g.key]) || 0), 0);
  const ok = inherit || sum === 100;
  return (
    <form action={action} className="rounded-lg border border-line p-3">
      <input type="hidden" name="scope" value={scope} />
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{label}</p>
        {scope !== 'default' && (
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input type="checkbox" name="inherit" checked={inherit} onChange={(e) => setInherit(e.target.checked)} /> Use default weights
          </label>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {groups.map((g) => (
          <label key={g.key} className="block">
            <span className="label truncate" title={g.label}>{g.label}</span>
            <input type="number" min={0} max={100} step={1} name={`w_${g.key}`} disabled={inherit}
              value={shown[g.key] ?? 0} onChange={(e) => setW({ ...w, [g.key]: Number(e.target.value) })}
              className="input tabular-nums" />
            {inherit && <input type="hidden" name={`w_${g.key}`} value={shown[g.key] ?? 0} />}
          </label>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={clsx('text-xs tabular-nums', ok ? 'text-ink-muted' : 'font-medium text-red-700')} aria-live="polite">
          {inherit ? 'Inherits the default weights' : <>Total: {sum} / 100{!ok && ' — must equal 100'}</>}
        </p>
        <button type="submit" disabled={!ok} className={buttonClass('primary', 'sm')}>Save</button>
      </div>
    </form>
  );
}
