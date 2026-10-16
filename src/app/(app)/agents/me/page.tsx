import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { UserRoundX } from 'lucide-react';

export const metadata = { title: 'My Performance' };

/** Support agents land here; redirects to their own agent page when a profile is linked. */
export default async function MyPerformancePage() {
  const s = await requireSession();
  if (s.user.agentId) {
    const ok = await withOrg(s.org.id, (db) => db.one<{ id: string }>('SELECT id FROM agents WHERE id = $1', [s.user.agentId]));
    if (ok) redirect(`/agents/${s.user.agentId}`);
  }
  return (
    <div>
      <PageHeader title="My Performance" />
      <Card>
        <EmptyState icon={<UserRoundX size={28} />} title="Your account isn’t linked to an agent profile yet"
          description="Performance, reviewed conversations and coaching appear here once an administrator links your user account to your agent profile in Team Management. Please ask your team leader or CRM manager to set this up." />
      </Card>
    </div>
  );
}
