import { requirePermission } from '@/lib/auth/session';
import type { SP } from '@/lib/filters';
import { InteractionListView } from '@/components/interaction/InteractionListView';

export const metadata = { title: 'Unified Inbox' };

export default async function InboxPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('interactions.view');
  return (
    <InteractionListView s={s} searchParams={searchParams} basePath="/inbox" variant="all" title="Unified Inbox"
      description={s.scope === 'own' ? 'Your calls, chats, WhatsApp and email conversations' : s.scope === 'team' ? 'Your team’s calls, chats, WhatsApp and emails' : 'All calls, chats, WhatsApp and email conversations'} />
  );
}
