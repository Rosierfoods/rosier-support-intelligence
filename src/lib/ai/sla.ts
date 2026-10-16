/**
 * Business-hours-aware response-gap / SLA computation (spec §8).
 * Deterministic: produces candidate flags ('excessive_delay', 'sla_unresolved') with evidence = the customer
 * message that was waiting for a reply. A conversation is never flagged merely because the agent has not replied yet
 * if the wait is still within SLA once non-business hours are excluded.
 */
export interface BusinessHours { days: number[]; start: string; end: string } // days: 0=Sun … 6=Sat, local to tz; "HH:MM"

export interface SlaSettings {
  timezone: string;
  businessHours: BusinessHours;
  sla: { firstResponseMinutes: Record<string, number>; resolutionHours: number };
}

export interface SlaMessage { seq: number; sender_type: string; sent_at: Date | string; body?: string; external_message_id?: string | null }

export interface SlaCandidate {
  rule_code: 'excessive_delay' | 'sla_unresolved';
  evidence_id: string;            // M<seq> / E<seq>
  reason: string;
  confidence: number;
  business_minutes: number;
  sla_minutes: number;
  awaiting: boolean;              // still unanswered
}

// ───────────────────────── Time-zone helpers (Intl, DST-safe) ─────────────────────────
function partsIn(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd };
}

/** Offset (ms) of tz from UTC at instant d. */
function tzOffsetMs(d: Date, tz: string) {
  const p = partsIn(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000;
}

/** UTC instant for a wall-clock time in tz. */
export function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz); // second pass handles DST boundaries
  return new Date(t);
}

function hm(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  return m ? [Math.min(23, +m[1]), Math.min(59, +m[2])] : [0, 0];
}

/** Minutes between a and b that fall inside business hours (in tz). */
export function businessMinutesBetween(a: Date | string, b: Date | string, bh: BusinessHours, tz: string): number {
  const start = new Date(a), end = new Date(b);
  if (!(end > start)) return 0;
  const [sh, sm] = hm(bh.start), [eh, em] = hm(bh.end);
  const days = new Set(bh.days ?? []);
  if (!days.size) return 0;
  let total = 0;
  // iterate local calendar days from the local date of `start` to that of `end`
  const p0 = partsIn(start, tz);
  let cursor = Date.UTC(p0.y, p0.m - 1, p0.d);
  const p1 = partsIn(end, tz);
  const last = Date.UTC(p1.y, p1.m - 1, p1.d);
  let guard = 0;
  while (cursor <= last && guard++ < 400) {
    const cd = new Date(cursor);
    const y = cd.getUTCFullYear(), m = cd.getUTCMonth() + 1, d = cd.getUTCDate();
    const wd = cd.getUTCDay();
    if (days.has(wd)) {
      const ws = zonedTimeToUtc(y, m, d, sh, sm, tz).getTime();
      const we = zonedTimeToUtc(y, m, d, eh, em, tz).getTime();
      const s = Math.max(ws, start.getTime()), e = Math.min(we, end.getTime());
      if (e > s) total += (e - s) / 60_000;
    }
    cursor += 86_400_000;
  }
  if (guard >= 400) {
    // very long spans: approximate the remainder by average business minutes per week
    const perWeek = days.size * Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
    total += ((end.getTime() - cursor) / (7 * 86_400_000)) * perWeek;
  }
  return Math.round(total);
}

/**
 * For chat/WhatsApp/email threads: compute agent response gaps in business minutes.
 * - A "waiting window" opens at the first customer message after the last agent message and closes at the next agent message.
 *   Bot/system messages do not close it (auto-replies are not human responses).
 * - Closed windows longer than the first-response SLA → one 'excessive_delay' candidate (worst gap).
 * - An open window (customer still waiting, conversation not resolved) longer than the first-response SLA → 'excessive_delay'
 *   (awaiting); longer than resolutionHours → 'sla_unresolved'.
 */
export function computeSlaCandidates(
  msgs: SlaMessage[], channel: string, settings: SlaSettings,
  opts: { now?: Date; resolved?: boolean; idPrefix?: 'M' | 'E' } = {},
): { candidates: SlaCandidate[]; gaps: { evidence_id: string; minutes: number; answered: boolean }[] } {
  const now = opts.now ?? new Date();
  const prefix = opts.idPrefix ?? (channel === 'email' ? 'E' : 'M');
  const slaMin = Number(settings.sla.firstResponseMinutes?.[channel] ?? 0);
  const resMin = Number(settings.sla.resolutionHours ?? 0) * 60;
  const sorted = [...msgs].sort((x, y) => new Date(x.sent_at).getTime() - new Date(y.sent_at).getTime() || x.seq - y.seq);
  const gaps: { evidence_id: string; minutes: number; answered: boolean }[] = [];
  let open: SlaMessage | null = null;
  for (const m of sorted) {
    if (m.sender_type === 'customer') { if (!open) open = m; continue; }
    if (m.sender_type === 'agent' && open) {
      gaps.push({ evidence_id: `${prefix}${open.seq}`, minutes: businessMinutesBetween(open.sent_at, m.sent_at, settings.businessHours, settings.timezone), answered: true });
      open = null;
    }
  }
  const candidates: SlaCandidate[] = [];
  if (slaMin > 0) {
    const worst = gaps.filter((g) => g.minutes > slaMin).sort((a, b) => b.minutes - a.minutes)[0];
    if (worst) {
      candidates.push({
        rule_code: 'excessive_delay', evidence_id: worst.evidence_id, confidence: 1, business_minutes: worst.minutes, sla_minutes: slaMin, awaiting: false,
        reason: `Agent replied after ${fmtMin(worst.minutes)} of business time; the ${channel} first-response SLA is ${fmtMin(slaMin)} (non-business hours excluded).`,
      });
    }
  }
  if (open && !opts.resolved) {
    const waited = businessMinutesBetween(open.sent_at, now, settings.businessHours, settings.timezone);
    gaps.push({ evidence_id: `${prefix}${open.seq}`, minutes: waited, answered: false });
    if (resMin > 0 && waited > resMin) {
      candidates.push({
        rule_code: 'sla_unresolved', evidence_id: `${prefix}${open.seq}`, confidence: 1, business_minutes: waited, sla_minutes: resMin, awaiting: true,
        reason: `Customer has been waiting ${fmtMin(waited)} of business time without an agent reply; resolution SLA is ${fmtMin(resMin)}.`,
      });
    } else if (slaMin > 0 && waited > slaMin && !candidates.some((c) => c.rule_code === 'excessive_delay')) {
      candidates.push({
        rule_code: 'excessive_delay', evidence_id: `${prefix}${open.seq}`, confidence: 1, business_minutes: waited, sla_minutes: slaMin, awaiting: true,
        reason: `Customer message unanswered for ${fmtMin(waited)} of business time; first-response SLA is ${fmtMin(slaMin)} (non-business hours excluded).`,
      });
    }
  }
  return { candidates, gaps };
}

export function fmtMin(m: number) {
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return r ? `${h} h ${r} min` : `${h} h`;
}
