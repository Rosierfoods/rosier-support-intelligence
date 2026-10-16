'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import type { ActionResult } from '@/components/analytics/ActionForm';

/** Revoke (delete) an active session. The caller's own current session cannot be revoked here — use Sign out. */
export async function revokeSession(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await assertPermission('audit.view');
    const { id } = z.object({ id: z.string().uuid() }).parse(Object.fromEntries(fd));
    if (id === s.id) throw new Error('This is your current session — use Sign out instead.');
    await withOrg(s.org.id, async (db) => {
      const row = await db.one<{ user_id: string; role: string }>(`SELECT s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`, [id]);
      if (!row) throw new Error('Session already ended.');
      if (row.role === 'super_admin' && s.user.role !== 'super_admin') throw new Error('Only a Super Admin can revoke a Super Admin session.');
      await db.exec(`DELETE FROM sessions WHERE id = $1`, [id]);
      await auditAction(db, s, 'session.revoke', 'user', row.user_id, { session_id: id });
    });
    revalidatePath('/audit');
    return { ok: true, message: 'Session revoked.' };
  } catch (e) {
    return { ok: false, error: e instanceof z.ZodError ? 'Invalid request.' : (e as Error).message };
  }
}
