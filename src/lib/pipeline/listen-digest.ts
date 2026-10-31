/**
 * Morning summary (from 9:00 IST, once a day): how many "must listen" / "should listen" conversations came in yesterday,
 * sent as an in-app notification to Super Admins and CRM managers, linking to the Calls to listen page.
 */
import { withOrg, withSystem } from '@/lib/db';
import type { Session } from '@/lib/auth/session';
import { notifyUsers, usersWithRoles } from '@/lib/notify';
import { getListenList } from '@/lib/repos/listen';

function istDate(d: Date) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d); }

export async function runListenDigest(log: (m: string) => void = () => {}, now = new Date()): Promise<number> {
  const hourIst = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now));
  if (hourIst < 9) return 0;
  const today = istDate(now);
  const yesterday = istDate(new Date(now.getTime() - 86400_000));
  const orgs = await withSystem((db) => db.query<{ id: string }>(`SELECT id FROM organizations LIMIT 50`));
  let sent = 0;
  for (const { id: orgId } of orgs) {
    try {
      sent += await withOrg(orgId, async (db) => {
        const already = await db.one(`SELECT 1 FROM notification_events WHERE type = 'listen_digest' AND created_at >= $1::timestamptz LIMIT 1`, [`${today}T00:00:00+05:30`]);
        if (already) return 0;
        const s = { scope: 'all', user: { id: null, teamId: null, agentId: null }, permissions: new Set<string>(), org: { id: orgId } } as unknown as Session;
        const { rows, counts } = await getListenList(db, s, {
          from: new Date(`${yesterday}T00:00:00+05:30`), to: new Date(`${yesterday}T23:59:59.999+05:30`), rangeLabel: yesterday, channel: null, agentId: null, show: 'todo',
        }, 3);
        const users = await usersWithRoles(db, ['super_admin', 'crm_manager']);
        if (!users.length) return 0;
        const total = counts.must + counts.should;
        const top = rows.slice(0, 3).map((r) => `${r.order_ref ? `Order ${r.order_ref}` : r.customer_name ?? 'Customer'} (${r.agent_name ?? 'unassigned'}): ${r.reasons[0] ?? ''}`).join(' · ');
        await notifyUsers(db, orgId, users, {
          type: 'listen_digest', severity: counts.must ? 'critical' : total ? 'high' : undefined,
          title: total ? `${counts.must} must-listen and ${counts.should} should-listen conversation${total === 1 ? '' : 's'} from yesterday` : 'No calls need a founder’s attention from yesterday',
          body: top || undefined, link: `/listen?from=${yesterday}&to=${yesterday}`,
        });
        return 1;
      });
    } catch (e) { log(`listen digest failed for org ${orgId}: ${(e as Error).message}`); }
  }
  return sent;
}
