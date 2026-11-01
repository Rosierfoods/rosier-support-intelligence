/**
 * Which calls are worth transcribing: only calls where one of our agents actually spoke with the customer.
 * IVR / bot-only calls and very short connects are skipped (and never sent to Sarvam, so they cost nothing). Pure; unit-tested.
 */
import type { OrgSettings } from '@/lib/constants';

export interface GateInput {
  callStatus: string | null;
  agentTalkSeconds: number | null;   // agent leg talk time; 0 = never reached an agent; null = provider didn't say
  durationSeconds: number | null;    // whole call
  agentKnown: boolean;               // an agent / agent number is linked to the call
}

export type GateResult = { transcribe: true } | { transcribe: false; reason: string };

export function transcriptionDecision(c: GateInput, t: OrgSettings['transcription']): GateResult {
  if (c.callStatus && c.callStatus !== 'answered') return { transcribe: false, reason: 'Not connected' };
  if (!t?.onlyAgentCalls) return { transcribe: true };
  const min = Math.max(0, Number(t.minAgentTalkSeconds ?? 20));
  if (c.agentTalkSeconds !== null && c.agentTalkSeconds !== undefined) {
    if (c.agentTalkSeconds <= 0) return { transcribe: false, reason: 'No agent joined (IVR / bot only)' };
    if (c.agentTalkSeconds < min) return { transcribe: false, reason: `Agent talked under ${min}s` };
    return { transcribe: true };
  }
  // Provider gave no leg detail: rely on whether an agent is linked and how long the call was.
  const dur = c.durationSeconds ?? 0;
  if (c.agentKnown) return dur >= min ? { transcribe: true } : { transcribe: false, reason: `Call under ${min}s` };
  const unknownMin = Math.max(min, Number(t.unknownAgentMinSeconds ?? 90));
  return dur >= unknownMin ? { transcribe: true } : { transcribe: false, reason: 'No agent on the call (IVR / bot only)' };
}

/** Minutes billed for a call that is transcribed (Sarvam bills per second on the whole recording). */
export function billableMinutes(durationSeconds: number | null) {
  return Math.max(0, durationSeconds ?? 0) / 60;
}
