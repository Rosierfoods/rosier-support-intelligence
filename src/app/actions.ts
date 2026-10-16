'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession, logout } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';

export async function logoutAction() {
  await logout();
  redirect('/login');
}

export async function markAllNotificationsRead() {
  const s = await getSession();
  if (!s) return;
  await withOrg(s.org.id, (db) => db.exec('UPDATE notification_events SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [s.user.id]));
  revalidatePath('/', 'layout');
}
