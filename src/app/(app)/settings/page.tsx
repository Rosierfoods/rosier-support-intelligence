import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { demoCounts, getOrgRow } from '@/lib/repos/team';
import { Badge, Card, CardBody, CardHeader, Field, Notice, PageHeader } from '@/components/ui';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { fmtNum } from '@/lib/format';
import { CheckCircle2, XCircle } from 'lucide-react';
import { removeDemo, resetDemo, saveNotifications, saveOrganization, saveRetention } from './actions';

export const metadata = { title: 'System Settings' };

const ENV_CHECKS: { key: string; label: string; why: string; required?: boolean }[] = [
  { key: 'SECRETS_ENCRYPTION_KEY', label: 'Secrets encryption key', why: 'Encrypts integration credentials and MFA secrets (AES-256-GCM).', required: true },
  { key: 'APP_URL', label: 'Public app URL', why: 'Used for webhook URLs and links in notifications.', required: true },
  { key: 'DATABASE_SSL', label: 'Database TLS mode', why: 'Encrypts database traffic in transit (set to require for hosted Postgres).' },
  { key: 'STORAGE_DRIVER', label: 'Private storage driver', why: 'Where retained recordings and attachments are stored (local or S3-compatible).' },
  { key: 'SMTP_URL', label: 'SMTP for email alerts', why: 'Needed to email critical alerts; in-app notifications work without it.' },
  { key: 'CRON_SECRET', label: 'Cron secret', why: 'Protects the scheduled sync / SLA / retention endpoints.' },
];

const RETENTION: { key: string; label: string; hint: string }[] = [
  { key: 'recordingsDays', label: 'Call recordings', hint: 'Retained audio copies are deleted after this many days.' },
  { key: 'transcriptsDays', label: 'Transcripts', hint: 'Transcript text and segments.' },
  { key: 'messagesDays', label: 'Chat / WhatsApp / email messages', hint: 'Message bodies; metadata and scores are kept.' },
  { key: 'piiDays', label: 'Customer personal data', hint: 'Names, phone numbers and emails are anonymised after this period.' },
  { key: 'auditDays', label: 'Audit logs', hint: 'Minimum 90 days.' },
];

export default async function SettingsPage() {
  const s = await requirePermission('settings.manage');
  const canDemo = s.permissions.has('demo.reset');
  const { org, counts, isDemoUser } = await withOrg(s.org.id, async (db) => {
    const [org, counts, me] = await Promise.all([
      getOrgRow(db), demoCounts(db), db.one<{ is_demo: boolean }>(`SELECT is_demo FROM users WHERE id = $1`, [s.user.id]),
    ]);
    return { org, counts, isDemoUser: !!me?.is_demo };
  });
  const st = s.org.settings;
  // Booleans only — values are never sent to the browser.
  const env = ENV_CHECKS.map((e) => ({ ...e, set: !!process.env[e.key] && process.env[e.key] !== '' }));

  return (
    <div className="space-y-5">
      <PageHeader title="System Settings" description="Organisation, data retention, notifications, demo data and deployment checks. Changes are audited." />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Organisation" />
          <CardBody>
            <ActionForm action={saveOrganization} className="grid gap-3 sm:grid-cols-2">
              <Field label="Organisation name"><input name="name" defaultValue={org?.name ?? s.org.name} required maxLength={120} className="input" /></Field>
              <Field label="Time zone" hint="IANA name. Reports and dashboards display IST."><input name="timezone" defaultValue={st.timezone} required className="input" list="tz-list" /></Field>
              <datalist id="tz-list">{['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'].map((z) => <option key={z} value={z} />)}</datalist>
              <div className="sm:col-span-2"><SubmitButton size="sm">Save</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Notifications" />
          <CardBody>
            <ActionForm action={saveNotifications} className="space-y-3">
              <label className="flex items-start gap-2.5 text-sm">
                <input type="checkbox" name="emailCritical" defaultChecked={!!st.notifications.emailCritical} className="mt-0.5 h-4 w-4 accent-[#784900]" />
                <span><span className="font-medium text-ink">Email critical quality alerts</span>
                  <span className="block text-xs text-ink-muted">Super Admins and CRM Managers receive an email for every new critical alert, in addition to the in-app notification.{!process.env.SMTP_URL && ' SMTP is not configured, so emails will not be sent until SMTP_URL is set.'}</span></span>
              </label>
              <SubmitButton size="sm">Save</SubmitButton>
            </ActionForm>
            <p className="mt-3 text-2xs text-ink-faint">SLA targets, business hours and score thresholds are managed in <Link href="/ai-config" className="link">AI Configuration</Link>.</p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Data retention policy" subtitle="How long source content and personal data are kept. Scores, labels and reviewer decisions remain for reporting after content is deleted." />
        <CardBody>
          <ActionForm action={saveRetention} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {RETENTION.map((r) => (
              <Field key={r.key} label={`${r.label} (days)`} hint={r.hint}>
                <input name={r.key} type="number" min={1} max={3650} required defaultValue={(st.retention as Record<string, number>)[r.key]} className="input" />
              </Field>
            ))}
            <div className="sm:col-span-2 lg:col-span-5"><SubmitButton size="sm">Save retention policy</SubmitButton></div>
          </ActionForm>
        </CardBody>
      </Card>

      {canDemo && (
        <Card>
          <CardHeader title="Demo data" subtitle="Synthetic sample records labelled DEMO DATA. Real imported records are never touched." />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {([['Interactions', counts.interactions], ['Calls', counts.calls], ['Chats', counts.chats], ['Emails', counts.emails], ['Alerts', counts.flags],
                ['Coaching', counts.coaching], ['Agents', counts.agents], ['Users', counts.users]] as [string, number][]).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-line px-3 py-2"><p className="text-2xs uppercase tracking-wide text-ink-faint">{k}</p><p className="text-lg font-semibold tabular-nums text-ink">{fmtNum(v)}</p></div>
              ))}
            </div>
            <p className="text-xs text-ink-muted">{fmtNum(counts.real_interactions)} real (non-demo) interactions in the system.</p>
            <div className="grid gap-4 lg:grid-cols-2">
              <ActionForm action={resetDemo} className="space-y-2 rounded-lg border border-line p-3">
                <p className="text-sm font-medium text-ink">Reset demo data</p>
                <p className="text-xs text-ink-muted">Deletes all demo records and regenerates a fresh set dated around today. Demo user accounts are recreated with the demo password, so anyone signed in with a demo account is signed out.</p>
                <Field label="Type RESET DEMO DATA to confirm"><input name="confirm" required autoComplete="off" className="input" pattern="RESET DEMO DATA" /></Field>
                <SubmitButton variant="secondary" size="sm">Reset demo data</SubmitButton>
              </ActionForm>
              <ActionForm action={removeDemo} className="space-y-2 rounded-lg border border-red-200 p-3">
                <p className="text-sm font-medium text-red-900">Remove all demo data</p>
                <p className="text-xs text-ink-muted">Permanently deletes every demo interaction, customer, alert, coaching plan, agent, team and demo user account. Do this before going live.</p>
                {isDemoUser && <Notice tone="warn">You are signed in with a demo account. Create a real Super Admin first and sign in with it — otherwise removing demo data would delete your own account.</Notice>}
                <Field label="Type REMOVE DEMO DATA to confirm"><input name="confirm" required autoComplete="off" className="input" pattern="REMOVE DEMO DATA" disabled={isDemoUser} /></Field>
                <SubmitButton variant="danger" size="sm" confirm="Permanently remove all demo data? This cannot be undone.">Remove demo data</SubmitButton>
              </ActionForm>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Environment checklist" subtitle="Whether each deployment setting is present. Values are never displayed." />
        <ul className="divide-y divide-line">
          {env.map((e) => (
            <li key={e.key} className="flex items-start gap-3 px-4 py-2.5">
              {e.set ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-700" aria-label="Set" /> : <XCircle size={18} className={`mt-0.5 shrink-0 ${e.required ? 'text-red-700' : 'text-ink-faint'}`} aria-label="Not set" />}
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{e.label} <code className="ml-1 font-mono text-2xs text-ink-muted">{e.key}</code></p>
                <p className="text-xs text-ink-muted">{e.why}</p>
              </div>
              <Badge tone={e.set ? 'good' : e.required ? 'bad' : 'muted'}>{e.set ? 'Set' : e.required ? 'Missing' : 'Not set'}</Badge>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
