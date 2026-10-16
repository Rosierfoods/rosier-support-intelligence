import type { Tone } from '@/components/ui';
import { COACHING_FLOW, COACHING_STATUS_LABELS } from '@/lib/repos/coaching';

export function coachingTone(status: string, overdue?: boolean): Tone {
  if (overdue) return 'bad';
  return status === 'reviewed' ? 'good' : status === 'completed' ? 'info' : status === 'cancelled' ? 'muted' : status === 'assigned' ? 'brand' : 'warn';
}

/** Five-step progress: assigned → acknowledged → in progress → completed → reviewed. */
export function CoachingProgress({ status }: { status: string }) {
  const idx = COACHING_FLOW.indexOf(status as (typeof COACHING_FLOW)[number]);
  return (
    <div className="flex items-center gap-1" role="img" aria-label={`Progress: ${COACHING_STATUS_LABELS[status] ?? status}`}>
      {COACHING_FLOW.map((st, i) => (
        <span key={st} title={COACHING_STATUS_LABELS[st]}
          className={`h-1.5 w-5 rounded-full ${status === 'cancelled' ? 'bg-stone-200' : i <= idx ? 'bg-brand' : 'bg-sand/70'}`} />
      ))}
    </div>
  );
}
