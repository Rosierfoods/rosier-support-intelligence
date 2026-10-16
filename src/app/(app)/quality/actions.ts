'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { applyFlagAction, FLAG_ACTION_PERMISSION, type FlagAction } from '@/lib/repos/flags';
import { ReviewError } from '@/lib/repos/interactions';
import type { ActionResult } from '@/components/interaction/types';

const ACTIONS = ['start_review', 'confirm', 'false_positive', 'resolve', 'reopen', 'assign', 'unassign', 'escalate'] as const;
const MESSAGES: Record<FlagAction, string> = {
  start_review: 'Review started.', confirm: 'Alert confirmed.', false_positive: 'Marked as false positive.', resolve: 'Alert resolved.',
  reopen: 'Alert reopened for review.', assign: 'Reviewer assigned and notified.', unassign: 'Reviewer removed.', escalate: 'Escalated — managers notified.',
};

const single = z.object({
  flagId: z.string().uuid(),
  action: z.enum(ACTIONS),
  note: z.string().trim().max(2000).optional().transform((v) => v || null),
  assigneeId: z.string().uuid().optional().or(z.literal('')).transform((v) => v || null),
});

function errorResult(e: unknown): ActionResult {
  if (e instanceof z.ZodError) return { ok: false, error: e.errors[0]?.message ?? 'Invalid input.' };
  if (e instanceof ReviewError || (e instanceof Error && /permission|signed in/i.test(e.message))) return { ok: false, error: (e as Error).message };
  console.error('[flag action]', e);
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

/** One action on one alert (used by the review queue and the interaction detail page). */
export async function flagAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const v = single.parse(Object.fromEntries(fd));
    if (v.action === 'false_positive' && !v.note) return { ok: false, error: 'Add a note explaining why this is a false positive.' };
    const s = await assertPermission(FLAG_ACTION_PERMISSION[v.action]);
    const r = await withOrg(s.org.id, (db) => applyFlagAction(db, s, v.flagId, v.action, { note: v.note, assigneeId: v.assigneeId }));
    revalidatePath('/quality');
    revalidatePath(`/inbox/${r.interactionId}`);
    return { ok: true, message: MESSAGES[v.action] };
  } catch (e) {
    return errorResult(e);
  }
}

const bulk = z.object({
  ids: z.array(z.string().uuid()).min(1, 'Select at least one alert.').max(100),
  action: z.enum(['start_review', 'assign']),
  assigneeId: z.string().uuid().optional().or(z.literal('')).transform((v) => v || null),
});

/** Bulk start-review / assign from the queue. Each alert is processed independently; failures are reported. */
export async function bulkFlagAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const v = bulk.parse({ ids: fd.getAll('ids').map(String), action: fd.get('action'), assigneeId: fd.get('assigneeId') ?? '' });
    if (v.action === 'assign' && !v.assigneeId) return { ok: false, error: 'Choose a reviewer to assign.' };
    const s = await assertPermission(FLAG_ACTION_PERMISSION[v.action]);
    let done = 0;
    const skipped: string[] = [];
    for (const id of v.ids) {
      try {
        await withOrg(s.org.id, (db) => applyFlagAction(db, s, id, v.action, { assigneeId: v.assigneeId }));
        done++;
      } catch (e) {
        if (e instanceof ReviewError) skipped.push(e.message); else throw e;
      }
    }
    revalidatePath('/quality');
    const verb = v.action === 'assign' ? 'assigned' : 'moved to review';
    return { ok: true, message: `${done} alert${done === 1 ? '' : 's'} ${verb}.${skipped.length ? ` ${skipped.length} skipped (${skipped[0]})` : ''}` };
  } catch (e) {
    return errorResult(e);
  }
}
