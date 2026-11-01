import { describe, it, expect } from 'vitest';
import { transcriptionDecision } from '@/lib/pipeline/transcribe-gate';
import { agentLegTalk, mapMyOperatorCall } from '@/lib/providers/myoperator';
import { fmtHours, totalsOf } from '@/lib/repos/talktime';

const T = { onlyAgentCalls: true, minAgentTalkSeconds: 20, unknownAgentMinSeconds: 90, costPerMinuteInr: 0.49 };
const call = (o: Partial<Parameters<typeof transcriptionDecision>[0]>) => transcriptionDecision({ callStatus: 'answered', agentTalkSeconds: null, durationSeconds: 60, agentKnown: true, ...o }, T);

describe('transcribe only calls where an agent spoke', () => {
  it('missed calls are never transcribed', () => expect(call({ callStatus: 'missed' })).toEqual({ transcribe: false, reason: 'Not connected' }));
  it('IVR / AI-only call (no agent leg) is skipped', () => expect(call({ agentTalkSeconds: 0, durationSeconds: 18 }).transcribe).toBe(false));
  it('agent talked 12s — skipped', () => expect(call({ agentTalkSeconds: 12 })).toEqual({ transcribe: false, reason: 'Agent talked under 20s' }));
  it('agent talked 2 minutes — transcribed', () => expect(call({ agentTalkSeconds: 120 }).transcribe).toBe(true));
  it('no leg detail, agent known, 45s — transcribed', () => expect(call({ durationSeconds: 45 }).transcribe).toBe(true));
  it('no leg detail, no agent, 30s — skipped as IVR only', () => expect(call({ agentKnown: false, durationSeconds: 30 }).transcribe).toBe(false));
  it('no leg detail, no agent, 3 min — transcribed (a real conversation)', () => expect(call({ agentKnown: false, durationSeconds: 180 }).transcribe).toBe(true));
  it('rule switched off — every answered call', () => expect(transcriptionDecision({ callStatus: 'answered', agentTalkSeconds: 0, durationSeconds: 5, agentKnown: false }, { ...T, onlyAgentCalls: false }).transcribe).toBe(true));
});

describe('agent talk time from MyOperator legs', () => {
  const cust = '+919900011122';
  it('agent leg duration', () => expect(agentLegTalk([{ duration: '00:00:40' }], { duration: '00:02:05' }, cust)).toBe(125));
  it('legs but nobody else — 0 (IVR only)', () => expect(agentLegTalk([{ contact: cust, duration: '00:00:18' }], null, cust)).toBe(0));
  it('no legs — unknown', () => expect(agentLegTalk([], null, cust)).toBeNull());
  it('search document: answered by IVR only', () => {
    const n = mapMyOperatorCall({ allcaller_id: 'a', caller_number: cust, start_time: 1760000000, duration: '00:00:18', type: '1', status: 1, log_details: [{ contact: cust, duration: '00:00:18' }] });
    expect(n?.call?.agentTalkSeconds).toBe(0);
  });
  it('search document: agent talked', () => {
    const n = mapMyOperatorCall({ allcaller_id: 'b', caller_number: cust, start_time: 1760000000, duration: '00:03:00', type: '1', status: 1,
      log_details: [{ received_by: [{ name: 'Neha', contact: '+918888877777' }], duration: '00:02:30' }] });
    expect(n?.call?.agentTalkSeconds).toBe(150);
  });
  it('legacy short-key log: agent leg', () => {
    const n = mapMyOperatorCall({ _ai: 'c', _cl: cust, _st: 1760000000, _dr: '00:02:00', _su: 1, _ld: [{ _rr: { _na: 'Ravi', _ct: '+917777766666' }, _dr: '00:01:40' }] });
    expect(n?.call?.agentTalkSeconds).toBe(100);
  });
});

describe('talk time totals and cost', () => {
  it('sums agents and prices billable minutes with GST', () => {
    const r = (id: string, talk: number, bill: number) => ({ agent_id: id, agent_name: id, calls: 10, answered: 8, incoming: 6, outgoing: 4, talk_seconds: talk, to_transcribe: 5, skipped: 3, billable_seconds: bill });
    const t = totalsOf([r('a', 3600, 3000), r('b', 1800, 600)], 0.5);
    expect(t.talk_seconds).toBe(5400);
    expect(t.minutes).toBe(60);
    expect(t.cost).toBe(30);
    expect(t.cost_gst).toBe(35.4);
    expect(fmtHours(5400)).toBe('1h 30m');
  });
});
