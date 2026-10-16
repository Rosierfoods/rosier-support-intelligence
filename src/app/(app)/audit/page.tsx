import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { parsePage, parseRange, sp, type SP } from '@/lib/filters';
import { auditActionOptions, listActiveSessions, listAuditLogs, listUsers, securityPosture } from '@/lib/repos/team';
import { Badge, Card, CardHeader, KpiCard, PageHeader, Table, TBody, THead } from '@/components/ui';
import { ClearFilters, ParamSearch, ParamSelect, RangeFilter } from '@/components/filters';
import { Pagination } from '@/components/pagination';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { Tabs } from '@/components/analytics/Segmented';
import { ROLE_LABELS, type Role } from '@/lib/constants';
import { fmtDateTime, fmtPct, relTime } from '@/lib/format';
import { revokeSession } from './actions';

export const metadata = { title: 'Audit Logs & Security' };

function details(d: Record<string, unknown> | null) {
  if (!d || !Object.keys(d).length) return null;
  const s = JSON.stringify(d);
  return s.length > 180 ? s.slice(0, 180) + '…' : s;
}

function device(ua: string | null) {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ' · ' + os : ''}`;
}

export default async function AuditPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('audit.view');
  const tab = (['logs', 'sessions', 'security'].includes(sp(searchParams, 'tab') ?? '') ? sp(searchParams, 'tab') : 'logs') as string;
  const range = parseRange(searchParams, '30d');
  const { page, pageSize } = parsePage(searchParams, 50);

  const d = await withOrg(s.org.id, async (db) => {
    if (tab === 'sessions') return { sessions: await listActiveSessions(db) };
    if (tab === 'security') return { posture: await securityPosture(db) };
    const [logs, actions, users] = await Promise.all([
      listAuditLogs(db, { action: sp(searchParams, 'action') ?? null, userId: sp(searchParams, 'user') ?? null, target: sp(searchParams, 'target') ?? null, from: range.from, to: range.to, page, pageSize }),
      auditActionOptions(db), listUsers(db),
    ]);
    return { logs, actions, users };
  }) as any;

  const prefixes = Array.from(new Set<string>((d.actions ?? []).map((a: any) => a.action.split('.')[0])));

  return (
    <div>
      <PageHeader title="Audit Logs & Security" description="Who did what, when — access, configuration changes and exports — plus active sessions and security posture." />
      <Tabs basePath="/audit" searchParams={searchParams} value={tab} tabs={[{ value: 'logs', label: 'Audit log' }, { value: 'sessions', label: 'Active sessions' }, { value: 'security', label: 'Security posture' }]} />

      {tab === 'logs' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ParamSelect name="action" placeholder="All actions" options={[
              ...prefixes.map((p) => ({ value: `${p}.*`, label: `${p}.* (all)` })),
              ...d.actions.map((a: any) => ({ value: a.action, label: `${a.action} (${a.n})` })),
            ]} />
            <ParamSelect name="user" placeholder="All users" options={d.users.map((u: any) => ({ value: u.id, label: u.name }))} />
            <ParamSearch name="target" placeholder="Target type or ID…" />
            <RangeFilter />
            <ClearFilters keep={['tab']} />
          </div>
          <Card>
            <Table>
              <THead><tr><th className="th">When</th><th className="th">User</th><th className="th">Action</th><th className="th">Target</th><th className="th">Details</th><th className="th">Source</th></tr></THead>
              <TBody>
                {d.logs.rows.map((l: any) => (
                  <tr key={l.id} className="align-top">
                    <td className="td whitespace-nowrap text-xs" title={fmtDateTime(l.created_at)}>{fmtDateTime(l.created_at)}</td>
                    <td className="td text-sm">{l.user_name ?? <span className="text-ink-faint">System / removed user</span>}<p className="text-2xs text-ink-muted">{l.user_email}</p></td>
                    <td className="td"><Badge tone={l.action.startsWith('auth.login_failed') || l.action.includes('mfa_failed') ? 'bad' : l.action.startsWith('export.') ? 'warn' : 'neutral'}><span className="font-mono">{l.action}</span></Badge></td>
                    <td className="td text-xs">{l.target_type ?? '—'}<p className="max-w-[12rem] truncate font-mono text-2xs text-ink-faint" title={l.target_id ?? ''}>{l.target_id}</p></td>
                    <td className="td max-w-md"><code className="block break-all font-mono text-2xs text-ink-muted">{details(l.details) ?? '—'}</code></td>
                    <td className="td whitespace-nowrap text-2xs text-ink-muted">{l.ip ?? '—'}<p title={l.user_agent ?? ''}>{device(l.user_agent)}</p></td>
                  </tr>
                ))}
                {!d.logs.rows.length && <tr><td colSpan={6} className="td text-center text-ink-muted">No audit events for these filters.</td></tr>}
              </TBody>
            </Table>
            <Pagination searchParams={searchParams} page={page} pageSize={pageSize} total={d.logs.total} basePath="/audit" />
          </Card>
          <p className="text-2xs text-ink-faint">Audit entries are append-only from the app and retained for {s.org.settings.retention.auditDays} days (System Settings → retention).</p>
        </div>
      )}

      {tab === 'sessions' && (
        <Card>
          <CardHeader title={`Active sessions (${d.sessions.length})`} subtitle="Revoking a session signs that device out immediately." />
          <Table>
            <THead><tr><th className="th">User</th><th className="th">Device</th><th className="th">IP</th><th className="th">MFA</th><th className="th">Signed in</th><th className="th">Last active</th><th className="th">Expires</th><th className="th"><span className="sr-only">Revoke</span></th></tr></THead>
            <TBody>
              {d.sessions.map((x: any) => (
                <tr key={x.id}>
                  <td className="td"><p className="font-medium text-ink">{x.name}</p><p className="text-2xs text-ink-muted">{x.email} · {ROLE_LABELS[x.role as Role]}</p></td>
                  <td className="td text-xs" title={x.user_agent ?? ''}>{device(x.user_agent)}</td>
                  <td className="td font-mono text-xs">{x.ip ?? '—'}</td>
                  <td className="td">{x.mfa_verified ? <Badge tone="good">Verified</Badge> : <Badge tone="muted">No</Badge>}</td>
                  <td className="td whitespace-nowrap text-xs">{fmtDateTime(x.created_at)}</td>
                  <td className="td whitespace-nowrap text-xs">{relTime(x.last_seen_at)}</td>
                  <td className="td whitespace-nowrap text-xs">{fmtDateTime(x.expires_at)}</td>
                  <td className="td text-right">
                    {x.id === s.id ? <Badge tone="brand">This session</Badge> : (
                      <ActionForm action={revokeSession} inline><input type="hidden" name="id" value={x.id} />
                        <SubmitButton variant="secondary" size="sm" confirm={`Sign ${x.name} out of this device?`}>Revoke</SubmitButton></ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {tab === 'security' && (() => {
        const p = d.posture; const sm = p.summary;
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <KpiCard label="MFA adoption" value={fmtPct(sm.active_users ? sm.mfa_users / sm.active_users : null, 0)} sub={`${sm.mfa_users} of ${sm.active_users} active users`} formula="Active users with two-factor authentication enabled ÷ active users." tone={sm.active_users && sm.mfa_users / sm.active_users < 0.5 ? 'warn' : undefined} />
              <KpiCard label="Admins/managers without MFA" value={sm.privileged_without_mfa} tone={sm.privileged_without_mfa ? 'bad' : 'good'} formula="Active Super Admin and CRM Manager accounts without MFA." />
              <KpiCard label="Locked accounts" value={sm.locked} tone={sm.locked ? 'warn' : undefined} formula="Accounts temporarily locked after 5 failed sign-ins (15 minutes)." />
              <KpiCard label="Failed sign-ins (7 days)" value={sm.failed_7d} sub={`${sm.mfa_failed_7d} failed MFA codes`} formula="auth.login_failed and auth.mfa_failed audit events in the last 7 days." href="/audit?tab=logs&action=auth.login_failed&range=7d" />
              <KpiCard label="Exports (30 days)" value={sm.exports_30d} formula="CSV / data export audit events (export.*) in the last 30 days." href="/audit?tab=logs&action=export.*&range=30d" />
              <KpiCard label="Active sessions" value={sm.active_sessions} href="/audit?tab=sessions" />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader title="Users without MFA" subtitle="Privileged roles first" actions={<Link className="text-xs text-brand hover:underline" href="/team">Team management →</Link>} />
                <Table>
                  <THead><tr><th className="th">User</th><th className="th">Role</th><th className="th">Last sign-in</th></tr></THead>
                  <TBody>
                    {p.withoutMfa.map((u: any) => (
                      <tr key={u.id}><td className="td"><p className="text-sm text-ink">{u.name}</p><p className="text-2xs text-ink-muted">{u.email}</p></td>
                        <td className="td">{['super_admin', 'crm_manager'].includes(u.role) ? <Badge tone="warn">{ROLE_LABELS[u.role as Role]}</Badge> : <span className="text-sm">{ROLE_LABELS[u.role as Role]}</span>}</td>
                        <td className="td text-xs text-ink-muted">{u.last_login_at ? relTime(u.last_login_at) : 'Never'}</td></tr>
                    ))}
                    {!p.withoutMfa.length && <tr><td className="td text-ink-muted" colSpan={3}>Every active user has MFA enabled.</td></tr>}
                  </TBody>
                </Table>
              </Card>
              <Card>
                <CardHeader title="Locked accounts" />
                <Table>
                  <THead><tr><th className="th">User</th><th className="th">Failed attempts</th><th className="th">Locked until</th></tr></THead>
                  <TBody>
                    {p.locked.map((u: any) => <tr key={u.id}><td className="td text-sm">{u.name}<p className="text-2xs text-ink-muted">{u.email}</p></td><td className="td tabular-nums">{u.failed_login_count}</td><td className="td text-xs">{fmtDateTime(u.locked_until)}</td></tr>)}
                    {!p.locked.length && <tr><td className="td text-ink-muted" colSpan={3}>No locked accounts.</td></tr>}
                  </TBody>
                </Table>
              </Card>
              <Card>
                <CardHeader title="Recent failed sign-ins" subtitle="Last 7 days" />
                <Table>
                  <THead><tr><th className="th">When</th><th className="th">Account</th><th className="th">Type</th><th className="th">IP</th></tr></THead>
                  <TBody>
                    {p.failed.map((f: any, i: number) => <tr key={i}><td className="td whitespace-nowrap text-xs">{fmtDateTime(f.created_at)}</td><td className="td text-sm">{f.name ?? '—'}<p className="text-2xs text-ink-muted">{f.email}</p></td><td className="td text-xs">{f.action === 'auth.mfa_failed' ? 'MFA code' : 'Password'}</td><td className="td font-mono text-xs">{f.ip ?? '—'}</td></tr>)}
                    {!p.failed.length && <tr><td className="td text-ink-muted" colSpan={4}>No failed sign-ins in the last 7 days.</td></tr>}
                  </TBody>
                </Table>
              </Card>
              <Card>
                <CardHeader title="Recent exports" subtitle="Last 30 days" />
                <Table>
                  <THead><tr><th className="th">When</th><th className="th">User</th><th className="th">Export</th><th className="th">Rows</th></tr></THead>
                  <TBody>
                    {p.exports.map((x: any, i: number) => <tr key={i}><td className="td whitespace-nowrap text-xs">{fmtDateTime(x.created_at)}</td><td className="td text-sm">{x.name ?? '—'}</td><td className="td font-mono text-xs">{x.action}{x.target_id ? ` · ${x.target_id}` : ''}</td><td className="td tabular-nums text-xs">{x.details?.row_count ?? x.details?.rows ?? '—'}</td></tr>)}
                    {!p.exports.length && <tr><td className="td text-ink-muted" colSpan={4}>No exports in the last 30 days.</td></tr>}
                  </TBody>
                </Table>
              </Card>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
