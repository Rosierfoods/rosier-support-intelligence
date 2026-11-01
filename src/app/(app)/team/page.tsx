import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { sp, type SP } from '@/lib/filters';
import { getRoleOverrides, listAgentsAdmin, listTeams, listUnmatchedAgentSides, listUsers } from '@/lib/repos/team';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_LABELS, type Permission } from '@/lib/auth/rbac';
import { ROLES, ROLE_LABELS, PLATFORM_LABELS, type Role } from '@/lib/constants';
import { Badge, Card, CardBody, CardHeader, DemoBadge, Field, Notice, PageHeader, Table, TBody, THead } from '@/components/ui';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { Tabs } from '@/components/analytics/Segmented';
import { fmtDateTime, relTime } from '@/lib/format';
import { createUser, resetUserMfa, resetUserPassword, rematchAgents, assignUnmatched, setAgentActive, saveRolePermissions, saveTeam, setUserActive, unlockUser, updateUser } from './actions';

export const metadata = { title: 'Team Management' };

import { AgentForm, type Opt } from './AgentForm';
import Link from 'next/link';
import { AGENT_HANDLE_LABELS, type AgentHandle } from '@/lib/constants';
function Select({ name, options, value, placeholder, required }: { name: string; options: Opt[]; value?: string | null; placeholder: string; required?: boolean }) {
  return (
    <select name={name} defaultValue={value ?? ''} required={required} className="input">
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

function RoleSelect({ value, canSuper }: { value?: string; canSuper: boolean }) {
  return (
    <select name="role" defaultValue={value ?? 'support_agent'} className="input" required>
      {ROLES.filter((r) => canSuper || r !== 'super_admin' || value === 'super_admin').map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </select>
  );
}

export default async function TeamPage(props: { searchParams: Promise<SP> }) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('team.manage');
  const tab = (['users', 'teams', 'agents', 'permissions'].includes(sp(searchParams, 'tab') ?? '') ? sp(searchParams, 'tab') : 'users') as string;
  const d = await withOrg(s.org.id, async (db) => {
    const [users, teams, agents, overrides] = await Promise.all([listUsers(db), listTeams(db), listAgentsAdmin(db), getRoleOverrides(db)]);
    const unmatched = tab === 'agents' ? await listUnmatchedAgentSides(db) : null;
    return { users, teams, agents, overrides, unmatched };
  });
  const canSuper = s.user.role === 'super_admin';
  const teamOpts: Opt[] = d.teams.map((t: any) => ({ id: t.id, name: t.name }));
  const agentOpts: Opt[] = d.agents.map((a: any) => ({ id: a.id, name: `${a.name}${a.user_id ? ' (linked)' : ''}` }));
  const userOpts: Opt[] = d.users.filter((u: any) => u.is_active).map((u: any) => ({ id: u.id, name: `${u.name} · ${ROLE_LABELS[u.role as Role]}` }));
  const ovMap = new Map(d.overrides.map((o) => [`${o.role}:${o.permission}`, o.allowed]));

  return (
    <div>
      <PageHeader title="Team Management" description="Users, teams, agent profiles and role permissions. Every change is recorded in the audit log." />
      <Tabs basePath="/team" searchParams={searchParams} value={tab} tabs={[
        { value: 'users', label: 'Users', count: d.users.length }, { value: 'teams', label: 'Teams', count: d.teams.length },
        { value: 'agents', label: 'Agents', count: d.agents.length }, { value: 'permissions', label: 'Role permissions' },
      ]} />

      {tab === 'users' && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Invite a user" subtitle="A temporary password is generated and shown once. Share it securely; ask the user to change it and enable two-factor authentication." />
            <CardBody>
              <ActionForm action={createUser} resetOnSuccess className="grid gap-3 md:grid-cols-6">
                <div className="md:col-span-2"><Field label="Work email *"><input name="email" type="email" required maxLength={200} className="input" autoComplete="off" /></Field></div>
                <div className="md:col-span-2"><Field label="Full name *"><input name="name" required maxLength={120} className="input" /></Field></div>
                <div className="md:col-span-2"><Field label="Role *"><RoleSelect canSuper={canSuper} /></Field></div>
                <div className="md:col-span-2"><Field label="Team" hint="Team leaders see only their team’s data."><Select name="teamId" options={teamOpts} placeholder="No team" /></Field></div>
                <div className="md:col-span-2"><Field label="Link to agent profile" hint="Support agents see their own performance via this link."><Select name="agentId" options={agentOpts} placeholder="Not linked" /></Field></div>
                <div className="flex items-end md:col-span-2"><SubmitButton>Create user</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <Table>
              <THead><tr><th className="th">User</th><th className="th">Role</th><th className="th">Team · agent</th><th className="th">Security</th><th className="th">Last sign-in</th><th className="th"><span className="sr-only">Manage</span></th></tr></THead>
              <TBody>
                {d.users.map((u: any) => {
                  const editable = canSuper || u.role !== 'super_admin';
                  return (
                    <tr key={u.id} className={u.is_active ? '' : 'bg-canvas/60 text-ink-muted'}>
                      <td className="td"><p className="font-medium text-ink">{u.name}{u.id === s.user.id && <span className="ml-1 text-2xs text-ink-faint">(you)</span>}</p><p className="text-2xs text-ink-muted">{u.email}</p>
                        <div className="mt-1 flex gap-1">{!u.is_active && <Badge tone="muted">Inactive</Badge>}{u.is_demo && <DemoBadge />}</div></td>
                      <td className="td text-sm">{ROLE_LABELS[u.role as Role]}</td>
                      <td className="td text-xs">{u.team ?? <span className="text-ink-faint">No team</span>}<p className="text-ink-muted">{u.agent ? `Agent: ${u.agent}` : ''}</p></td>
                      <td className="td"><div className="flex flex-wrap gap-1">
                        {u.mfa_enabled ? <Badge tone="good">MFA on</Badge> : <Badge tone={['super_admin', 'crm_manager'].includes(u.role) ? 'warn' : 'muted'}>No MFA</Badge>}
                        {u.locked && <Badge tone="bad">Locked</Badge>}
                        {u.active_sessions > 0 && <Badge tone="info">{u.active_sessions} session{u.active_sessions > 1 ? 's' : ''}</Badge>}
                      </div></td>
                      <td className="td whitespace-nowrap text-xs text-ink-muted" title={u.last_login_at ? fmtDateTime(u.last_login_at) : undefined}>{u.last_login_at ? relTime(u.last_login_at) : 'Never'}</td>
                      <td className="td text-right">
                        {editable ? (
                          <details className="group relative inline-block text-left">
                            <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-brand-50">Manage</summary>
                            <div className="absolute right-0 z-10 mt-1 w-80 space-y-3 rounded-xl border border-line bg-white p-3 text-left shadow-lg">
                              <ActionForm action={updateUser} className="space-y-2">
                                <input type="hidden" name="id" value={u.id} />
                                <Field label="Name"><input name="name" defaultValue={u.name} required className="input" /></Field>
                                <Field label="Role"><RoleSelect value={u.role} canSuper={canSuper} /></Field>
                                <Field label="Team"><Select name="teamId" options={teamOpts} value={u.team_id} placeholder="No team" /></Field>
                                <Field label="Agent profile"><Select name="agentId" options={agentOpts} value={u.agent_id} placeholder="Not linked" /></Field>
                                <SubmitButton size="sm">Save</SubmitButton>
                              </ActionForm>
                              <div className="space-y-2 border-t border-line pt-2">
                                {u.id !== s.user.id && (
                                  <ActionForm action={resetUserPassword} inline><input type="hidden" name="id" value={u.id} />
                                    <SubmitButton variant="secondary" size="sm" className="w-full" confirm={`Reset ${u.name}'s password and sign them out?`}>Reset password</SubmitButton></ActionForm>
                                )}
                                {u.mfa_enabled && (
                                  <ActionForm action={resetUserMfa} inline><input type="hidden" name="id" value={u.id} />
                                    <SubmitButton variant="secondary" size="sm" className="w-full" confirm={`Remove two-factor authentication for ${u.name}?`}>Reset MFA</SubmitButton></ActionForm>
                                )}
                                {u.locked && (
                                  <ActionForm action={unlockUser} inline><input type="hidden" name="id" value={u.id} /><SubmitButton variant="secondary" size="sm" className="w-full">Unlock account</SubmitButton></ActionForm>
                                )}
                                {u.id !== s.user.id && (
                                  <ActionForm action={setUserActive} inline><input type="hidden" name="id" value={u.id} /><input type="hidden" name="active" value={u.is_active ? 'false' : 'true'} />
                                    <SubmitButton variant={u.is_active ? 'danger' : 'secondary'} size="sm" className="w-full" confirm={u.is_active ? `Deactivate ${u.name}? They will be signed out.` : undefined}>{u.is_active ? 'Deactivate' : 'Activate'}</SubmitButton></ActionForm>
                                )}
                              </div>
                            </div>
                          </details>
                        ) : <span className="text-2xs text-ink-faint">Super Admin only</span>}
                      </td>
                    </tr>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </div>
      )}

      {tab === 'teams' && (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <Table>
              <THead><tr><th className="th">Team</th><th className="th">Lead</th><th className="th">Members</th><th className="th"><span className="sr-only">Edit</span></th></tr></THead>
              <TBody>
                {d.teams.map((t: any) => (
                  <tr key={t.id}>
                    <td className="td"><p className="font-medium text-ink">{t.name} {t.is_demo && <DemoBadge className="ml-1" />}</p><p className="text-2xs text-ink-muted">{t.description}</p></td>
                    <td className="td text-sm">{t.lead ?? <span className="text-ink-faint">No lead</span>}</td>
                    <td className="td text-xs">{t.users} users · {t.agents} agents</td>
                    <td className="td text-right">
                      <details className="relative inline-block text-left">
                        <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-brand-50">Edit</summary>
                        <div className="absolute right-0 z-10 mt-1 w-72 rounded-xl border border-line bg-white p-3 shadow-lg">
                          <ActionForm action={saveTeam} className="space-y-2">
                            <input type="hidden" name="id" value={t.id} />
                            <Field label="Name"><input name="name" defaultValue={t.name} required className="input" /></Field>
                            <Field label="Description"><input name="description" defaultValue={t.description ?? ''} className="input" /></Field>
                            <Field label="Team lead"><Select name="leadUserId" options={userOpts} value={t.lead_user_id} placeholder="No lead" /></Field>
                            <SubmitButton size="sm">Save</SubmitButton>
                          </ActionForm>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
                {!d.teams.length && <tr><td className="td text-ink-muted" colSpan={4}>No teams yet.</td></tr>}
              </TBody>
            </Table>
          </Card>
          <Card>
            <CardHeader title="Create team" />
            <CardBody>
              <ActionForm action={saveTeam} resetOnSuccess className="space-y-3">
                <Field label="Name *"><input name="name" required maxLength={80} className="input" /></Field>
                <Field label="Description"><input name="description" maxLength={300} className="input" /></Field>
                <Field label="Team lead"><Select name="leadUserId" options={userOpts} placeholder="No lead" /></Field>
                <SubmitButton>Create team</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'agents' && (
        <div className="space-y-4">
          <Notice tone="info">
            <strong>Mobile numbers</strong> link calls to agents: add each agent&apos;s own mobile number(s) — the number their MyOperator calls ring on.
            New calls are assigned automatically; use <em>Re-match calls</em> after adding numbers.{' '}
            External IDs map provider users to agent profiles during import, e.g. <code className="rounded bg-white px-1">{'{"myoperator":"10234","limechat":"ag_55","email":"neha@rosierfoods.com"}'}</code>.
            Each provider ID can belong to one agent only. Known providers: {Object.keys(PLATFORM_LABELS).filter((k) => !['manual', 'demo'].includes(k)).join(', ')}.
          </Notice>
          {d.unmatched && (d.unmatched.groups.length > 0 || d.unmatched.noInfoCalls > 0 || d.unmatched.unassignedChats > 0) && (
            <Card>
              <CardHeader title="Calls with no agent yet — who is this?"
                subtitle="Numbers and names MyOperator sent for answered calls that didn't match any agent. Pick the agent once: past calls are assigned now and future calls automatically." />
              {d.unmatched.groups.length > 0 && (
                <Table>
                  <THead><tr><th className="th">Agent number / details from MyOperator</th><th className="th">Calls</th><th className="th">Incoming</th><th className="th">Outgoing</th><th className="th">Last call</th><th className="th">Assign to</th></tr></THead>
                  <TBody>
                    {d.unmatched.groups.map((g) => (
                      <tr key={`${g.phone}|${g.hint}`}>
                        <td className="td">
                          {g.phone ? <p className="font-medium tabular-nums text-ink">+{g.phone}</p> : null}
                          {g.hint && <p className="max-w-md truncate text-2xs text-ink-muted" title={g.hint}>{g.hint}</p>}
                        </td>
                        <td className="td tabular-nums">{g.calls}</td>
                        <td className="td tabular-nums text-red-700">{g.incoming}</td>
                        <td className="td tabular-nums text-emerald-700">{g.outgoing}</td>
                        <td className="td whitespace-nowrap text-xs">{relTime(g.last_at)}</td>
                        <td className="td">
                          <ActionForm action={assignUnmatched} className="flex items-center gap-2">
                            {g.phone && <input type="hidden" name="phone" value={g.phone} />}
                            {!g.phone && g.hint && <input type="hidden" name="hint" value={g.hint} />}
                            <select name="agentId" required defaultValue="" className="input h-8 w-44 py-0 text-xs">
                              <option value="" disabled>Choose agent…</option>
                              {d.agents.filter((a: any) => a.is_active).map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                            <SubmitButton>Assign</SubmitButton>
                          </ActionForm>
                        </td>
                      </tr>
                    ))}
                  </TBody>
                </Table>
              )}
              <div className="space-y-1 px-4 py-3 text-xs text-ink-muted">
                {d.unmatched.noInfoCalls > 0 && <p>{d.unmatched.noInfoCalls} answered call(s) came from MyOperator with no agent details at all — re-run the MyOperator historical import so they are read again with the improved agent detection.</p>}
                {d.unmatched.unassignedChats > 0 && <p>{d.unmatched.unassignedChats} chat / email conversation(s) have no agent — usually chats the bot closed without handing to a person. Chats handed to an agent are assigned from LimeChat automatically; give each agent here the same email they use in LimeChat.</p>}
              </div>
            </Card>
          )}
          <Card>
            <Table>
              <THead><tr><th className="th">Agent</th><th className="th">Handles</th><th className="th">Mobile numbers</th><th className="th">Last 30 days (actual)</th><th className="th">Team</th><th className="th">Status</th><th className="th"><span className="sr-only">Edit</span></th></tr></THead>
              <TBody>
                {d.agents.map((a: any) => {
                  const handles = (a.handles ?? []) as AgentHandle[];
                  const warn = mismatch(a, handles);
                  return (
                  <tr key={a.id} className={a.is_active ? '' : 'bg-canvas/60 text-ink-muted'}>
                    <td className="td min-w-[11rem]"><Link href={`/team/agents/${a.id}`} className="font-medium text-ink hover:text-brand">{a.name}</Link><p className="text-2xs text-ink-muted">{a.email ?? ''}</p>
                      {a.work_note && <p className="mt-0.5 max-w-[14rem] truncate text-2xs text-ink-faint" title={a.work_note}>{a.work_note}</p>}
                      {a.is_demo && <div className="mt-1"><DemoBadge /></div>}</td>
                    <td className="td min-w-[10rem]">
                      {handles.length ? <div className="flex flex-wrap gap-1">{handles.map((h) => <Badge key={h} tone={h === 'incoming_calls' ? 'bad' : h === 'outgoing_calls' ? 'good' : 'info'}>{AGENT_HANDLE_LABELS[h]?.label ?? h}</Badge>)}</div>
                        : <Link href={`/team/agents/${a.id}`} className="text-2xs text-brand hover:underline">Set what they handle</Link>}
                    </td>
                    <td className="td text-xs tabular-nums">{(a.phone_numbers ?? []).length ? (a.phone_numbers as string[]).map((p) => <p key={p}>+{p}</p>) : <span className="text-ink-faint">Not set</span>}</td>
                    <td className="td whitespace-nowrap text-xs">
                      <span className="text-red-700">{a.incoming_30d ?? 0} in</span> · <span className="text-emerald-700">{a.outgoing_30d ?? 0} out</span> · {a.chats_30d ?? 0} chats · {a.emails_30d ?? 0} emails
                      {warn && <p className="mt-0.5 text-2xs text-amber-700">{warn}</p>}
                    </td>
                    <td className="td text-sm">{a.team ?? <span className="text-ink-faint">—</span>}</td>
                    <td className="td">
                      <ActionForm action={setAgentActive} className="flex items-center gap-1.5">
                        <input type="hidden" name="id" value={a.id} /><input type="hidden" name="active" value={a.is_active ? 'false' : 'true'} />
                        <Badge tone={a.is_active ? 'good' : 'muted'}>{a.is_active ? 'Active' : 'Inactive'}</Badge>
                        <SubmitButton size="sm" variant="ghost">{a.is_active ? 'Deactivate' : 'Activate'}</SubmitButton>
                      </ActionForm>
                    </td>
                    <td className="td text-right"><Link href={`/team/agents/${a.id}`} className="rounded-md px-2 py-1 text-xs font-medium text-brand hover:bg-brand-50">Edit</Link></td>
                  </tr>
                  );
                })}
              </TBody>
            </Table>
          </Card>
          <ActionForm action={rematchAgents} className="flex items-center gap-3">
            <SubmitButton variant="secondary">Re-match calls to agents by mobile number</SubmitButton>
          </ActionForm>
          <Card>
            <CardHeader title="Add agent profile" subtitle="Agents are the people whose conversations are imported and evaluated. Link a user so the agent can see their own performance." />
            <CardBody><AgentForm teamOpts={teamOpts} userOpts={userOpts} /></CardBody>
          </Card>
        </div>
      )}

      {tab === 'permissions' && (
        <Card>
          <CardHeader title="Role permissions" subtitle="Overrides on top of each role’s defaults. Super Admin always has every permission and cannot be restricted. Changes take effect on the next request." />
          <ActionForm action={saveRolePermissions}>
            <Table>
              <THead><tr><th className="th">Permission</th>{ROLES.map((r) => <th key={r} className="th">{ROLE_LABELS[r]}</th>)}</tr></THead>
              <TBody>
                {PERMISSIONS.map((p) => (
                  <tr key={p}>
                    <td className="td"><p className="text-sm text-ink">{PERMISSION_LABELS[p as Permission]}</p><p className="font-mono text-2xs text-ink-faint">{p}</p></td>
                    {ROLES.map((r) => {
                      if (r === 'super_admin') return <td key={r} className="td"><Badge tone="good">Always</Badge></td>;
                      const def = DEFAULT_ROLE_PERMISSIONS[r].has(p as Permission);
                      const ov = ovMap.get(`${r}:${p}`);
                      const val = ov === undefined ? 'default' : ov ? 'allow' : 'deny';
                      return (
                        <td key={r} className="td">
                          <select name={`perm:${r}:${p}`} defaultValue={val} aria-label={`${ROLE_LABELS[r]} — ${PERMISSION_LABELS[p as Permission]}`}
                            className={`input h-8 w-[8.5rem] py-0 text-xs ${val !== 'default' ? 'border-brand-500 bg-brand-50' : ''}`}>
                            <option value="default">Default ({def ? 'yes' : 'no'})</option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </TBody>
            </Table>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
              <p className="text-2xs text-ink-faint">Highlighted cells differ from the role default. Data scope (all / team / own) is fixed per role.</p>
              <SubmitButton>Save permissions</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}


/** Assigned work vs what the agent actually did in the last 30 days. */
function mismatch(a: any, handles: AgentHandle[]): string | null {
  if (!handles.length) return null;
  const notes: string[] = [];
  if ((a.incoming_30d ?? 0) > 0 && !handles.includes('incoming_calls')) notes.push(`${a.incoming_30d} incoming calls though not set`);
  if ((a.outgoing_30d ?? 0) > 0 && !handles.includes('outgoing_calls')) notes.push(`${a.outgoing_30d} outgoing calls though not set`);
  if ((a.chats_30d ?? 0) > 0 && !handles.includes('chat_whatsapp')) notes.push(`${a.chats_30d} chats though not set`);
  if ((a.emails_30d ?? 0) > 0 && !handles.includes('email')) notes.push(`${a.emails_30d} emails though not set`);
  return notes.length ? notes.join(' · ') : null;
}
