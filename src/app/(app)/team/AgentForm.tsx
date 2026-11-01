import { Field } from '@/components/ui';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { AGENT_HANDLES, AGENT_HANDLE_LABELS } from '@/lib/constants';
import { saveAgent } from './actions';

export type Opt = { id: string; name: string };

function Select({ name, options, value, placeholder }: { name: string; options: Opt[]; value?: string | null; placeholder: string }) {
  return (
    <select name={name} defaultValue={value ?? ''} className="input">
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

/** Create / edit an agent: who they are, their mobile numbers, and what they handle (calls in/out on MyOperator, chats/email on LimeChat). */
export function AgentForm({ a, teamOpts, userOpts }: { a?: any; teamOpts: Opt[]; userOpts: Opt[] }) {
  const handles: string[] = a?.handles ?? [];
  return (
    <ActionForm action={saveAgent} resetOnSuccess={!a} className="grid gap-3 md:grid-cols-3">
      {a && <input type="hidden" name="id" value={a.id} />}
      <Field label="Name *"><input name="name" defaultValue={a?.name ?? ''} required maxLength={120} className="input" /></Field>
      <Field label="Email" hint="Same email they use in LimeChat, so their chats are matched."><input name="email" type="email" defaultValue={a?.email ?? ''} maxLength={200} className="input" /></Field>
      <Field label="Status">
        <select name="active" defaultValue={a ? String(a.is_active) : 'true'} className="input"><option value="true">Active</option><option value="false">Inactive (left / on leave)</option></select>
      </Field>
      <div className="md:col-span-3">
        <p className="mb-1.5 text-xs font-medium text-ink-muted">What they handle</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {AGENT_HANDLES.map((h) => (
            <label key={h} className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-white px-3 py-2 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
              <input type="checkbox" name="handles" value={h} defaultChecked={handles.includes(h)} className="h-4 w-4 accent-[#784900]" />
              <span><span className="font-medium text-ink">{AGENT_HANDLE_LABELS[h].label}</span><span className="block text-2xs text-ink-muted">on {AGENT_HANDLE_LABELS[h].platform}</span></span>
            </label>
          ))}
        </div>
      </div>
      <Field label="Mobile number(s) assigned in MyOperator" hint="Comma-separated, e.g. 98123 45678, +91 99999 11111. Calls on these numbers are given to this agent.">
        <input name="phones" defaultValue={a ? ((a.phone_numbers ?? []) as string[]).map((p) => '+' + p).join(', ') : ''} placeholder="+91 98123 45678" className="input" />
      </Field>
      <Field label="Team"><Select name="teamId" options={teamOpts} value={a?.team_id} placeholder="No team" /></Field>
      <Field label="Linked portal user" hint="Lets the agent log in and see their own performance."><Select name="userId" options={userOpts} value={a?.user_id} placeholder="Not linked" /></Field>
      <Field label="Note (shift, languages, products…)"><input name="workNote" defaultValue={a?.work_note ?? ''} maxLength={500} placeholder="e.g. Morning shift, Hindi + English, ghee complaints" className="input" /></Field>
      <Field label="Provider IDs (advanced, JSON)" hint='Usually filled automatically, e.g. {"myoperator":"10234","limechat":"55"}'>
        <input name="externalIds" defaultValue={a ? JSON.stringify(a.external_ids ?? {}) : ''} placeholder='{"myoperator":"10234"}' className="input font-mono text-xs" />
      </Field>
      <div className="flex items-end"><SubmitButton size="md">{a ? 'Save changes' : 'Create agent'}</SubmitButton></div>
    </ActionForm>
  );
}
