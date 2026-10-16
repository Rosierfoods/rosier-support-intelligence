import { CHANNELS, type Channel } from './constants';

export type SP = Record<string, string | string[] | undefined>;

export function sp(searchParams: SP, key: string): string | undefined {
  const v = searchParams[key];
  return Array.isArray(v) ? v[0] : v || undefined;
}
export function spAll(searchParams: SP, key: string): string[] {
  const v = searchParams[key];
  if (!v) return [];
  return (Array.isArray(v) ? v : v.split(',')).filter(Boolean);
}

export const RANGE_PRESETS = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: 'all', label: 'All time', days: 3650 },
] as const;

export interface DateRange { from: Date; to: Date; preset: string; label: string; days: number }

/** Parse ?range=7d|30d|90d|today|all or ?from=YYYY-MM-DD&to=YYYY-MM-DD (dates in IST). Default 30d. */
export function parseRange(searchParams: SP, defaultPreset = '30d'): DateRange {
  const from = sp(searchParams, 'from');
  const to = sp(searchParams, 'to');
  const ist = (d: string, end = false) => new Date(`${d}T${end ? '23:59:59.999' : '00:00:00'}+05:30`);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const f = ist(from);
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? ist(to, true) : new Date();
    const days = Math.max(1, Math.round((t.getTime() - f.getTime()) / 86400_000));
    return { from: f, to: t, preset: 'custom', label: `${from} → ${to ?? 'today'}`, days };
  }
  const key = sp(searchParams, 'range') ?? defaultPreset;
  const preset = RANGE_PRESETS.find((p) => p.key === key) ?? RANGE_PRESETS.find((p) => p.key === defaultPreset)!;
  const now = new Date();
  let f: Date;
  if (preset.key === 'today') {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
    f = ist(today);
  } else {
    f = new Date(now.getTime() - preset.days * 86400_000);
  }
  return { from: f, to: now, preset: preset.key, label: preset.label, days: Math.max(1, preset.days) };
}

/** The equally long period immediately before `r` (for period-over-period comparisons). */
export function previousRange(r: DateRange): { from: Date; to: Date } {
  const len = r.to.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - len), to: new Date(r.from.getTime()) };
}

export function parseChannel(searchParams: SP): Channel | null {
  const c = sp(searchParams, 'channel');
  return c && (CHANNELS as readonly string[]).includes(c) ? (c as Channel) : null;
}

export function parsePage(searchParams: SP, pageSize = 25) {
  const page = Math.max(1, Number(sp(searchParams, 'page') ?? 1) || 1);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Rebuild a query string with overrides (undefined/'' removes a key). */
export function withParams(searchParams: SP, overrides: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined) continue;
    (Array.isArray(v) ? v : [v]).forEach((x) => u.append(k, x));
  }
  for (const [k, v] of Object.entries(overrides)) {
    u.delete(k);
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}
