import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { Card, CardBody, Notice, PageHeader } from '@/components/ui';
import { ArticleForm } from '../ArticleForm';
import { createArticleAction } from '../actions';

export const metadata = { title: 'New KB article' };

export default async function NewKbArticlePage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('kb.edit');
  const cats = await withOrg(s.org.id, (db) => db.query<{ category: string }>('SELECT DISTINCT category FROM knowledge_base_articles ORDER BY 1'));
  const error = sp(searchParams, 'error');
  return (
    <div className="space-y-5">
      <Link href="/knowledge-base" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"><ArrowLeft size={14} /> Knowledge Base</Link>
      <PageHeader title="New article" description="Write the approved SOP or policy. Only published, non-template versions are used to judge live interactions." />
      {error && <Notice tone="bad" title="Not saved">{error}</Notice>}
      <Card><CardBody><ArticleForm action={createArticleAction} mode="create" body="" categories={cats.map((c) => c.category)} /></CardBody></Card>
    </div>
  );
}
