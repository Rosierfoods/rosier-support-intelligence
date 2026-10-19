'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { TICKET_STATUSES, updateTicket } from '@/lib/repos/tickets';
import { RESOLUTION_TYPES } from '@/lib/orders/tickets';
import type { ActionResult } from '@/components/interaction/types';

const schema = z.object({
  ticketId: z.string().uuid(),
  status: z.enum(TICKET_STATUSES),
  resolutionType: z.enum(RESOLUTION_TYPES).optional().or(z.literal('')).transform((v) => v || null),
  actionTaken: z.string().trim().max(1000).optional().transform((v) => v || null),
  problem: z.string().trim().max(1000).optional().transform((v) => v || null),
});

export async function updateTicketAction(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('interactions.view');
    const p = schema.parse(Object.fromEntries(fd));
    const ok = await withOrg(s.org.id, async (db) => {
      const done = await updateTicket(db, s, p.ticketId, p);
      if (done) await auditAction(db, s, 'ticket.updated', 'support_ticket', p.ticketId, { status: p.status, resolution_type: p.resolutionType });
      return done;
    });
    if (!ok) return { ok: false, error: 'Ticket not found.' };
    revalidatePath('/tickets');
    return { ok: true, message: 'Ticket updated.' };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: e.errors[0]?.message ?? 'Invalid input.' };
    if (e instanceof Error && /permission|signed in/i.test(e.message)) return { ok: false, error: e.message };
    console.error('[tickets action]', e);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
