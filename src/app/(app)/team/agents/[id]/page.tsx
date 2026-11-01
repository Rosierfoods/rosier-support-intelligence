import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requirePermission } from '@/lib/auth/session';
import { withOrg, isUuid } from '@/lib/db';
import { listAgentsAdmin, listTeams, listUsers } from '@/lib/repos/team';
import { Badge, Card, CardBody, CardHeader, DemoBadge, PageHeader } from '@/components/ui';
import { AGENT_HANDLE_LABELS, ROLE_LABELS, type AgentHandle, type Role } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { AgentForm, type Opt } from '../../AgentForm';

export const metadata = { title: 'Edit agent' };

export default async function AgentEditPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const s = await requirePermission('team.manage');
  const d = await withOrg(s.org.id, async (db) => {
    const [[a], teams, users] = await Promise.all([listAgentsAdmin(db, id), listTeams(db), listUsers(db)]);
    return { a: a as any, teams, users };
  });
  if (!d.a) notFound();
  const a = d.a;
  const teamOpts: Opt[] = d.teams.map((t: any) => ({ id: t.id, name: t.name }));
  const userOpts: Opt[] = d.users.filter((u: any) => u.is_active).map((u: any) => ({ id: u.id, name: `${u.name} · ${ROLE_LABELS[u.role as Role]}` }));
  const handles = (a.handles ?? []) as AgentHandle[];
  const stats: [string, number, string, string][] = [
    ['Incoming calls', a.incoming_30d ?? 0, `/calls?agent=${a.id}&direction=inbound&range=30d`, 'text-red-700'],
    ['Outgoing calls', a.outgoing_30d ?? 0, `/calls?agent=${a.id}&direction=outbound&range=30d`, 'text-emerald-700'],
    ['Chats & WhatsApp', a.chats_30d ?? 0, `/chats?agent=${a.id}&range=30d`, 'text-ink'],
    ['Emails', a.emails_30d ?? 0, `/emails?agent=${a.id}&range=30d`, 'text-ink'],
  ];
  return (
    <div className="space-y-5">
      <Link href="/team?tab=agents" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-brand"><ArrowLeft size={13} /> Team → Agents</Link>
      <PageHeader title={a.name}
        description={<span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge tone={a.is_active ? 'good' : 'muted'}>{a.is_active ? 'Active' : 'Inactive'}</Badge>
          {handles.map((h) => <Badge key={h} tone={h === 'incoming_calls' ? 'bad' : h === 'outgoing_calls' ? 'good' : 'info'}>{AGENT_HANDLE_LABELS[h]?.label ?? h} · {AGENT_HANDLE_LABELS[h]?.platform}</Badge>)}
          {!handles.length && <span className="text-ink-muted">Not set what they handle yet</span>}
          {a.team && <span className="text-ink-muted">· {a.team}</span>}
          {a.is_demo && <DemoBadge />}
        </span>} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, n, href, tone]) => (
          <Link key={label} href={href} className="card block px-4 py-3 transition-colors hover:border-brand-500/40">
            <p className="text-xs font-medium text-ink-muted">{label} · last 30 days</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{n}</p>
            <p className="mt-0.5 text-2xs text-brand">Open list →</p>
          </Link>
        ))}
      </div>
      <p className="text-xs text-ink-muted">{a.last_at ? `Last conversation ${relTime(a.last_at)}` : 'No conversations in the last 30 days.'} · {a.interactions} conversations in total.</p>

      <Card>
        <CardHeader title="Edit agent" subtitle="Changes apply straight away. Adding or changing a mobile number re-assigns that number's calls to this agent." />
        <CardBody><AgentForm a={a} teamOpts={teamOpts} userOpts={userOpts} /></CardBody>
      </Card>
    </div>
  );
}
