import { requirePermission } from '@/lib/auth/session';
import type { SP } from '@/lib/filters';
import { InteractionListView } from '@/components/interaction/InteractionListView';

export const metadata = { title: 'Chat & WhatsApp' };

export default async function ChatsPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('interactions.view');
  return (
    <InteractionListView s={s} searchParams={searchParams} basePath="/chats" variant="chat" title="Chat & WhatsApp"
      description="Web chat and WhatsApp threads with response times" />
  );
}
