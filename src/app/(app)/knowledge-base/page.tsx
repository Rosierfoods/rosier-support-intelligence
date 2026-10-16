import Link from 'next/link';
import { AlertTriangle, Plus } from 'lucide-react';
import { requirePermission, can } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { KbStatusBadge } from './markdown';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, Notice, PageHeader, Table, TBody, THead } from '@/components/ui';
import { fmtDate, relTime } from '@/lib/format';

export const metadata = { title: 'Knowledge Base' };

export default async function KnowledgeBasePage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('kb.view');
  const editor = can(s, 'kb.edit');
  const showArchived = sp(searchParams, 'archived') === '1';
  const rows = await withOrg(s.org.id, (db) => db.query(
    `SELECT a.id, a.slug, a.title, a.category, a.status, a.updated_at, u.name AS updated_by,
            v.version AS current_version, v.is_placeholder, v.published_at,
            (SELECT max(version) FROM knowledge_base_versions d WHERE d.article_id = a.id AND d.status = 'draft' AND d.version > coalesce(v.version, 0)) AS pending_draft,
            (SELECT count(*)::int FROM quality_flags f WHERE f.policy_article_id = a.id AND f.created_at > now() - interval '30 days') AS flags_30d
       FROM knowledge_base_articles a
       LEFT JOIN knowledge_base_versions v ON v.id = a.current_version_id
       LEFT JOIN users u ON u.id = a.updated_by
      WHERE ($1 OR a.status <> 'archived') AND ($2 OR a.status = 'published')
      ORDER BY a.category, a.title`, [showArchived, editor]));
  const byCat = new Map<string, any[]>();
  for (const r of rows) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const placeholders = rows.filter((r: any) => r.status === 'published' && r.is_placeholder).length;

  return (
    <div className="space-y-5">
      <PageHeader title="Knowledge Base" description="Approved support SOPs and policies. AI analysis and coaching use only the published version of each article, and record which version they used."
        actions={<>
          {editor && <Link href={showArchived ? '/knowledge-base' : '/knowledge-base?archived=1'} className="link text-sm">{showArchived ? 'Hide archived' : 'Show archived'}</Link>}
          {editor && <ButtonLink href="/knowledge-base/new" variant="primary"><Plus size={15} /> New article</ButtonLink>}
        </>} />

      {placeholders > 0 && (
        <Notice tone="warn" title={`${placeholders} published article${placeholders === 1 ? ' is' : 's are'} still a template`}>
          Template policies are illustrative only. For live (non-demo) interactions the AI treats them as <strong>missing</strong> and flags policy uncertainty for human review instead of judging compliance.
          {editor ? ' Replace the wording with Rosier Foods’ approved policy and publish a new version.' : ' Ask a CRM manager to publish the approved wording.'}
        </Notice>
      )}

      {!rows.length ? (
        <Card><EmptyState title="No articles yet" description={editor ? 'Create the first approved SOP.' : 'No published articles are available.'} /></Card>
      ) : Array.from(byCat.entries()).map(([cat, list]) => (
        <Card key={cat}>
          <CardHeader title={cat} subtitle={`${list.length} article${list.length === 1 ? '' : 's'}`} />
          <Table className="[&_table]:table-fixed">
            <THead><tr><th className="th">Article</th><th className="th w-64">Status</th><th className="th w-40">Version</th><th className="th w-40">Alerts citing (30 d)</th><th className="th w-48">Updated</th></tr></THead>
            <TBody>
              {list.map((a) => (
                <tr key={a.id} className="hover:bg-brand-50/40">
                  <td className="td">
                    <Link href={`/knowledge-base/${a.id}`} className="font-medium text-ink hover:text-brand hover:underline">{a.title}</Link>
                    <p className="font-mono text-2xs text-ink-faint">{a.slug}</p>
                  </td>
                  <td className="td">
                    <div className="flex flex-wrap items-center gap-1">
                      <KbStatusBadge status={a.status} />
                      {a.status === 'published' && a.is_placeholder && <Badge tone="warn" title="Not used as approved policy for live data"><AlertTriangle size={11} /> Template</Badge>}
                      {editor && a.pending_draft && <Badge tone="info">Draft v{a.pending_draft} pending</Badge>}
                    </div>
                  </td>
                  <td className="td tabular-nums text-sm">{a.current_version ? <>v{a.current_version} <span className="text-2xs text-ink-faint">· {fmtDate(a.published_at)}</span></> : <span className="text-ink-faint">Unpublished</span>}</td>
                  <td className="td tabular-nums text-sm">{a.flags_30d || <span className="text-ink-faint">0</span>}</td>
                  <td className="td whitespace-nowrap text-xs text-ink-muted">{relTime(a.updated_at)}{a.updated_by ? ` · ${a.updated_by}` : ''}</td>
                </tr>
              ))}
            </TBody>
          </Table>
        </Card>
      ))}
    </div>
  );
}
