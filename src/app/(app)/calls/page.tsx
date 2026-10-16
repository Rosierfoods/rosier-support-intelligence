import { requirePermission } from '@/lib/auth/session';
import type { SP } from '@/lib/filters';
import { InteractionListView } from '@/components/interaction/InteractionListView';

export const metadata = { title: 'Calls & Transcriptions' };

export default async function CallsPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('interactions.view');
  return (
    <InteractionListView s={s} searchParams={searchParams} basePath="/calls" variant="call" title="Calls & Transcriptions"
      description="Call records with recording, transcription and AI analysis status" />
  );
}
