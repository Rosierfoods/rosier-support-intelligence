import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';
import { NAV } from '@/components/shell/nav';
import { ROLE_LABELS } from '@/lib/constants';
import { logoutAction, markAllNotificationsRead } from '../actions';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await requireSession();
  const isAgent = s.user.role === 'support_agent';
  const items = NAV.filter((n) => {
    if (n.perm && !s.permissions.has(n.perm)) return isAgent && (n.href === '/agents' || n.href === '/coaching');
    if (n.anyPerm && !n.anyPerm.some((p) => s.permissions.has(p))) return isAgent && n.href === '/agents';
    return true;
  }).map((n) => ({ ...n, displayLabel: isAgent && n.agentLabel ? n.agentLabel : n.label }));

  const { notifications, unread, critical, hasDemo } = await withOrg(s.org.id, async (db) => {
    const notifications = await db.query(
      `SELECT id, title, body, link, severity, created_at, read_at FROM notification_events
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 12`, [s.user.id]);
    const unread = await db.one<{ c: number }>('SELECT count(*)::int AS c FROM notification_events WHERE user_id = $1 AND read_at IS NULL', [s.user.id]);
    const critical = await db.one<{ c: number }>(
      `SELECT count(*)::int AS c FROM quality_flags WHERE severity = 'critical' AND status IN ('new','under_review','confirmed')`);
    const demo = await db.one<{ d: boolean }>('SELECT EXISTS (SELECT 1 FROM interactions WHERE is_demo) AS d');
    return { notifications, unread: unread?.c ?? 0, critical: critical?.c ?? 0, hasDemo: !!demo?.d };
  });

  return (
    <div className="min-h-screen">
      <Sidebar items={items} orgName={s.org.name} />
      <div className="lg:pl-60">
        {hasDemo && (
          <div className="border-b border-amber-200 bg-amber-50 py-1.5 pl-14 pr-4 text-center text-xs text-amber-900 lg:px-6">
            <span className="font-semibold">Demo mode:</span> records labelled <span className="font-semibold">DEMO DATA</span> are synthetic samples, not real customers.
            {s.permissions.has('integrations.manage') && <> <Link href="/integrations" className="underline">Connect integrations</Link> to import real interactions.</>}
          </div>
        )}
        <Topbar
          user={{ name: s.user.name, email: s.user.email, roleLabel: ROLE_LABELS[s.user.role] }}
          notifications={JSON.parse(JSON.stringify(notifications))}
          unread={unread}
          criticalOpen={critical}
          canSearch={s.permissions.has('interactions.view')}
          canSeeAlerts={s.permissions.has('flags.review')}
          markAllRead={markAllNotificationsRead}
          logoutAction={logoutAction}
        />
        <main className="mx-auto max-w-[1440px] px-4 py-5 lg:px-6">{children}</main>
      </div>
    </div>
  );
}
