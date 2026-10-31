'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { markListened } from '@/lib/repos/listen';
import type { ActionResult } from '@/components/interaction/types';

const schema = z.object({
  interactionId: z.string().uuid(),
  listened: z.enum(['1', '0']).default('1'),
  note: z.string().trim().max(1000).optional().transform((v) => v || null),
});

/** Founder marks a flagged call as listened (optionally with a note for the team). */
export async function markListenedAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('reports.view');
    const p = schema.parse(Object.fromEntries(fd));
    const ok = await withOrg(s.org.id, async (db) => {
      const done = await markListened(db, s, p.interactionId, p.listened === '1', p.note);
      if (done) await auditAction(db, s, p.listened === '1' ? 'founder.listened' : 'founder.unlistened', 'interaction', p.interactionId, { note: !!p.note });
      return done;
    });
    if (!ok) return { ok: false, error: 'Conversation not found.' };
    revalidatePath('/listen');
    revalidatePath(`/inbox/${p.interactionId}`);
    return { ok: true, message: p.listened === '1' ? 'Marked as listened.' : 'Moved back to the list.' };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: e.errors[0]?.message ?? 'Invalid input.' };
    if (e instanceof Error && /permission|signed in/i.test(e.message)) return { ok: false, error: e.message };
    console.error('[listen action]', e);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
