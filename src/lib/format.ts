import { formatInTimeZone } from './tz';

export const TZ = 'Asia/Kolkata';

export function fmtDateTime(d: Date | string | null | undefined, tz = TZ) {
  if (!d) return '—';
  return formatInTimeZone(new Date(d), tz, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtDate(d: Date | string | null | undefined, tz = TZ) {
  if (!d) return '—';
  return formatInTimeZone(new Date(d), tz, { day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtTime(d: Date | string | null | undefined, tz = TZ) {
  if (!d) return '—';
  return formatInTimeZone(new Date(d), tz, { hour: '2-digit', minute: '2-digit' });
}
export function fmtDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
  const s = Math.round(Number(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}
export function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtPct(v: number | null | undefined, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${(Number(v) * 100).toFixed(digits)}%`;
}
export function fmtNum(v: number | string | null | undefined, digits = 0) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function fmtINR(v: number | string | null | undefined) {
  if (v === null || v === undefined) return '—';
  return '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
export function titleCase(s: string | null | undefined) {
  if (!s) return '—';
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
export function relTime(d: Date | string | null | undefined) {
  if (!d) return '—';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(d);
}

/** Date offset from now by N days (kept out of component bodies so render stays pure for the React compiler lint). */
export function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86400_000);
}
