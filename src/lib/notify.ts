import type { Db } from '@/lib/db';

/**
 * In-app notifications (+ optional email for critical alerts via the 'notify' job when SMTP is configured).
 */
export async function notifyUsers(db: Db, orgId: string, userIds: string[], n: {
  type: string; title: string; body?: string; link?: string; severity?: string;
}) {
  for (const uid of new Set(userIds)) {
    await db.exec(
      `INSERT INTO notification_events (org_id, user_id, type, severity, title, body, link) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, uid, n.type, n.severity ?? null, n.title, n.body ?? null, n.link ?? null],
    );
  }
}

/** Users holding any of the given roles (active only). */
export async function usersWithRoles(db: Db, roles: string[]): Promise<string[]> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM users WHERE is_active AND role = ANY($1)`, [roles]);
  return rows.map((r) => r.id);
}
