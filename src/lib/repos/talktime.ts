/**
 * Talk time per agent and the transcription bill it implies. Uses the same "agent calls only" rule as the pipeline
 * (see transcribe-gate.ts) so the estimate matches what is actually sent to Sarvam.
 */
import type { Db } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import type { OrgSettings } from '@/lib/constants';
import { SqlBuilder } from '@/lib/sql';
import { scopeInteractions } from '@/lib/repos/scope';

export const GST = 0.18;

export interface TalkRow {
  agent_id: string | null; agent_name: string | null;
  calls: number; answered: number; incoming: number; outgoing: number;
  talk_seconds: number;          // agent talk time (agent leg; whole call when the provider doesn't split legs)
  to_transcribe: number; skipped: number; billable_seconds: number;
}

export interface TalkTotals extends TalkRow { cost: number; cost_gst: number; minutes: number }

/** SQL for the transcription rule; must mirror transcriptionDecision(). */
function gateSql(b: SqlBuilder, t: OrgSettings['transcription']) {
  if (!t?.onlyAgentCalls) return `c.call_status = 'answered'`;
  const min = b.p(Math.max(0, Number(t.minAgentTalkSeconds ?? 20)));
  const unknownMin = b.p(Math.max(Number(t.minAgentTalkSeconds ?? 20), Number(t.unknownAgentMinSeconds ?? 90)));
  return `(c.call_status = 'answered' AND (
            (c.agent_talk_seconds IS NOT NULL AND c.agent_talk_seconds > 0 AND c.agent_talk_seconds >= ${min}::int)
         OR (c.agent_talk_seconds IS NULL AND (i.agent_id IS NOT NULL OR c.agent_phone IS NOT NULL) AND coalesce(c.duration_seconds, 0) >= ${min}::int)
         OR (c.agent_talk_seconds IS NULL AND i.agent_id IS NULL AND c.agent_phone IS NULL AND coalesce(c.duration_seconds, 0) >= ${unknownMin}::int)))`;
}

export async function getTalkTime(db: Db, s: Session, range: { from: Date; to: Date }, t: OrgSettings['transcription']) {
  const b = new SqlBuilder();
  const conds = [`i.channel = 'call'`, `NOT i.is_demo`, `i.occurred_at >= ${b.p(range.from)}`, `i.occurred_at <= ${b.p(range.to)}`, scopeInteractions(s, b, 'i')];
  const gate = gateSql(b, t);
  const rows = await db.query<any>(
    `SELECT i.agent_id, a.name AS agent_name, count(*)::int AS calls,
            count(*) FILTER (WHERE c.call_status = 'answered')::int AS answered,
            count(*) FILTER (WHERE i.direction = 'inbound')::int AS incoming,
            count(*) FILTER (WHERE i.direction = 'outbound')::int AS outgoing,
            coalesce(sum(CASE WHEN c.call_status <> 'answered' THEN 0
                              WHEN c.agent_talk_seconds IS NOT NULL THEN c.agent_talk_seconds
                              WHEN i.agent_id IS NOT NULL OR c.agent_phone IS NOT NULL THEN coalesce(c.duration_seconds, 0) ELSE 0 END), 0)::bigint AS talk_seconds,
            count(*) FILTER (WHERE ${gate})::int AS to_transcribe,
            count(*) FILTER (WHERE c.call_status = 'answered' AND NOT ${gate})::int AS skipped,
            coalesce(sum(coalesce(c.duration_seconds, 0)) FILTER (WHERE ${gate}), 0)::bigint AS billable_seconds
       FROM interactions i JOIN calls c ON c.interaction_id = i.id LEFT JOIN agents a ON a.id = i.agent_id
      WHERE ${conds.join(' AND ')}
      GROUP BY 1, 2 ORDER BY talk_seconds DESC`, b.params);
  const list: TalkRow[] = rows.map((r: any) => ({
    agent_id: r.agent_id, agent_name: r.agent_name, calls: Number(r.calls), answered: Number(r.answered), incoming: Number(r.incoming), outgoing: Number(r.outgoing),
    talk_seconds: Number(r.talk_seconds), to_transcribe: Number(r.to_transcribe), skipped: Number(r.skipped), billable_seconds: Number(r.billable_seconds),
  }));
  const b2 = new SqlBuilder();
  const conds2 = [`i.channel = 'call'`, `NOT i.is_demo`, `i.occurred_at >= ${b2.p(range.from)}`, `i.occurred_at <= ${b2.p(range.to)}`, scopeInteractions(s, b2, 'i')];
  const span = await db.one<{ first_at: string | null; last_at: string | null }>(
    `SELECT min(i.occurred_at) AS first_at, max(i.occurred_at) AS last_at FROM interactions i WHERE ${conds2.join(' AND ')}`, b2.params);
  // Days that actually have data in the range (so a 30-day view of 2 weeks of data isn't under-projected).
  const days = span?.first_at ? Math.max(1, Math.ceil((Math.min(Date.now(), range.to.getTime()) - new Date(span.first_at).getTime()) / 86400_000)) : 0;
  const totals = totalsOf(list, Number(t?.costPerMinuteInr ?? 0.49));
  return { rows: list, totals, days, monthlyCostGst: days ? Math.round((totals.cost_gst / days) * 30) : 0, monthlyHours: days ? (totals.billable_seconds / 3600 / days) * 30 : 0 };
}

/** Sum the agent rows and price the billable minutes. Pure; unit-tested. */
export function totalsOf(rows: TalkRow[], costPerMinute: number): TalkTotals {
  const sum = (k: keyof TalkRow) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const billable = sum('billable_seconds');
  const minutes = billable / 60;
  const cost = Math.round(minutes * costPerMinute * 100) / 100;
  return {
    agent_id: null, agent_name: 'All agents', calls: sum('calls'), answered: sum('answered'), incoming: sum('incoming'), outgoing: sum('outgoing'),
    talk_seconds: sum('talk_seconds'), to_transcribe: sum('to_transcribe'), skipped: sum('skipped'), billable_seconds: billable,
    minutes, cost, cost_gst: Math.round(cost * (1 + GST) * 100) / 100,
  };
}

/** "123h 45m" — hours are what people compare with the Sarvam bill. */
export function fmtHours(seconds: number) {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
