import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { decryptString } from '@/lib/crypto';
import { otpauthUrl } from '@/lib/auth/totp';
import { Badge, Card, CardBody, CardHeader, Field, KeyValue, Notice, PageHeader } from '@/components/ui';
import { ActionForm } from '@/components/analytics/ActionForm';
import { SubmitButton } from '@/components/analytics/SubmitButton';
import { ROLE_LABELS } from '@/lib/constants';
import { fmtDateTime } from '@/lib/format';
import { cancelMfaSetup, changePassword, confirmMfaSetup, disableMfa, startMfaSetup } from './actions';
import { ShieldCheck } from 'lucide-react';

export const metadata = { title: 'Profile & security' };

export default async function ProfilePage() {
  const s = await requireSession();
  const u = await withOrg(s.org.id, (db) => db.one<any>(
    `SELECT u.name, u.email, u.role, u.mfa_enabled, u.mfa_secret_enc, u.last_login_at, u.created_at, t.name AS team, a.name AS agent, a.id AS agent_id,
            (SELECT count(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > now())::int AS sessions
       FROM users u LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN agents a ON a.id = u.agent_id WHERE u.id = $1`, [s.user.id]));
  // Pending enrolment: the secret is shown only to its owner, only before MFA is enabled.
  let pending: { secret: string; url: string } | null = null;
  if (u && !u.mfa_enabled && u.mfa_secret_enc) {
    try { const secret = decryptString(u.mfa_secret_enc); pending = { secret, url: otpauthUrl(secret, u.email) }; } catch { pending = null; }
  }
  const grouped = pending?.secret.match(/.{1,4}/g)?.join(' ');

  return (
    <div className="space-y-5">
      <PageHeader title="Profile & security" description="Your account, password and two-factor authentication." />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Account" />
          <CardBody>
            <KeyValue className="sm:grid-cols-1" items={[
              ['Name', u?.name], ['Email', u?.email], ['Role', ROLE_LABELS[u?.role as keyof typeof ROLE_LABELS]],
              ['Team', u?.team ?? '—'], ['Agent profile', u?.agent ? <Link className="link" href={`/agents/${u.agent_id}`}>{u.agent}</Link> : 'Not linked'],
              ['Last sign-in', fmtDateTime(u?.last_login_at)], ['Active sessions', u?.sessions],
            ]} />
            <p className="mt-3 text-2xs text-ink-faint">Name, role and team are managed by an administrator.</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Change password" subtitle="At least 10 characters with letters and numbers. Other devices are signed out." />
          <CardBody>
            <ActionForm action={changePassword} resetOnSuccess className="space-y-3">
              <Field label="Current password"><input name="current" type="password" autoComplete="current-password" required className="input" /></Field>
              <Field label="New password"><input name="next" type="password" autoComplete="new-password" required minLength={10} className="input" /></Field>
              <Field label="Confirm new password"><input name="confirm" type="password" autoComplete="new-password" required minLength={10} className="input" /></Field>
              <SubmitButton>Change password</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-2">Two-factor authentication {u?.mfa_enabled ? <Badge tone="good">On</Badge> : <Badge tone="warn">Off</Badge>}</span>}
            subtitle="Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy)." />
          <CardBody className="space-y-3">
            {u?.mfa_enabled ? (
              <>
                <p className="flex items-start gap-2 text-sm text-ink"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden /> Your account asks for a 6-digit code at every sign-in.</p>
                <ActionForm action={disableMfa} className="space-y-2 border-t border-line pt-3">
                  <Field label="To turn it off, enter a current code"><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required className="input tracking-[0.3em]" /></Field>
                  <SubmitButton variant="secondary" size="sm">Turn off two-factor</SubmitButton>
                </ActionForm>
              </>
            ) : pending ? (
              <>
                <ol className="ml-4 list-decimal space-y-1 text-sm text-ink">
                  <li>In your authenticator app, add an account using a setup key (or paste the link below on a device that supports it).</li>
                  <li>Enter the 6-digit code it shows to finish.</li>
                </ol>
                <div>
                  <p className="label">Setup key</p>
                  <code className="block select-all rounded-lg bg-canvas px-3 py-2 font-mono text-sm tracking-wider text-ink ring-1 ring-line">{grouped}</code>
                </div>
                <div>
                  <p className="label">otpauth link</p>
                  <code className="block max-h-24 select-all overflow-auto break-all rounded-lg bg-canvas px-3 py-2 font-mono text-2xs text-ink-muted ring-1 ring-line">{pending.url}</code>
                </div>
                <Notice tone="warn">Keep this key private. It is shown only until setup is complete.</Notice>
                <ActionForm action={confirmMfaSetup} className="space-y-2">
                  <Field label="6-digit code"><input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className="input text-center text-lg tracking-[0.4em]" /></Field>
                  <SubmitButton>Verify and turn on</SubmitButton>
                </ActionForm>
                <ActionForm action={cancelMfaSetup}><SubmitButton variant="ghost" size="sm">Cancel setup</SubmitButton></ActionForm>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-muted">Protect your account with a code from your phone in addition to your password.{['super_admin', 'crm_manager'].includes(s.user.role) && ' Strongly recommended for your role, which can access customer data and configuration.'}</p>
                <ActionForm action={startMfaSetup}><SubmitButton>Set up two-factor</SubmitButton></ActionForm>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
