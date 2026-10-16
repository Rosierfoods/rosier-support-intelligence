import { requirePermission } from '@/lib/auth/session';
import type { SP } from '@/lib/filters';
import { InteractionListView } from '@/components/interaction/InteractionListView';

export const metadata = { title: 'Email Conversations' };

export default async function EmailsPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('interactions.view');
  return (
    <InteractionListView s={s} searchParams={searchParams} basePath="/emails" variant="email" title="Email Conversations"
      description="Email threads with subject, response times and AI analysis" />
  );
}
