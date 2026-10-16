import type { Db } from '@/lib/db';

export async function audit(
  db: Db, orgId: string, userId: string | null, action: string, targetType: string | null, targetId: string | null,
  details: Record<string, unknown> = {}, meta?: { ip?: string; userAgent?: string },
) {
  await db.exec(
    'INSERT INTO audit_logs (org_id, user_id, action, target_type, target_id, details, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [orgId, userId, action, targetType, targetId, JSON.stringify(details), meta?.ip ?? null, meta?.userAgent ?? null],
  );
}
