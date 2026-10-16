/**
 * 'notify' job: optional email for critical alerts (org setting notifications.emailCritical + SMTP_URL).
 * The email contains rule, severity, interaction id and a link — never customer message/transcript content.
 */
import nodemailer from 'nodemailer';
import { withOrg } from '@/lib/db';
import type { Job } from './jobs';
import { loadOrgSettings } from '@/lib/ai/settings';
import { usersWithRoles } from '@/lib/notify';
import { PipelineError } from '@/lib/ai/errors';

export async function runNotifyJob(job: Pick<Job, 'org_id' | 'payload'>): Promise<{ sent: number; skipped?: string }> {
  const smtp = process.env.SMTP_URL;
  if (!smtp) return { sent: 0, skipped: 'SMTP_URL not configured' };
  const flagId = job.payload?.flagId;
  if (!flagId) throw new PipelineError('notify job without flagId', { retryable: false });
  const data = await withOrg(job.org_id, async (db) => {
    const settings = await loadOrgSettings(db, job.org_id);
    if (!settings.notifications?.emailCritical) return null;
    const f = await db.one<any>(
      `SELECT f.id, f.severity, f.title, f.rule_code, f.confidence, f.interaction_id, i.ref, i.channel, i.source_platform, i.is_demo, a.name AS agent_name, t.lead_user_id
         FROM quality_flags f JOIN interactions i ON i.id = f.interaction_id LEFT JOIN agents a ON a.id = f.agent_id LEFT JOIN teams t ON t.id = i.team_id
        WHERE f.id = $1`, [flagId]);
    if (!f) return null;
    const ids = [...(await usersWithRoles(db, f.severity === 'critical' ? ['super_admin', 'crm_manager'] : ['crm_manager'])), ...(f.lead_user_id ? [f.lead_user_id] : [])];
    const users = await db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = ANY($1) AND is_active`, [ids]);
    return { f, users };
  });
  if (!data || !data.users.length) return { sent: 0, skipped: 'disabled or no recipients' };
  const { f, users } = data;
  const link = `${(process.env.APP_URL ?? '').replace(/\/+$/, '')}/inbox/${f.interaction_id}?flag=${f.id}#evidence`;
  const transport = nodemailer.createTransport(smtp);
  await transport.sendMail({
    from: process.env.SMTP_FROM || 'Rosier Support Intelligence <no-reply@example.com>',
    to: users.map((u) => u.email),
    subject: `[${String(f.severity).toUpperCase()}] ${f.title} — ${f.ref}${f.is_demo ? ' (demo)' : ''}`,
    text: [
      `A potential ${f.severity} quality concern was detected and needs human review.`,
      '',
      `Alert: ${f.title}`,
      `Interaction: ${f.ref} (${f.channel}, ${f.source_platform})`,
      `Agent: ${f.agent_name ?? '—'}`,
      `AI confidence: ${f.confidence !== null ? Math.round(Number(f.confidence) * 100) + '%' : '—'}`,
      '',
      `Review it here: ${link}`,
      '',
      'This is an AI-generated flag for verification. No action should be taken against an employee without human review.',
    ].join('\n'),
  });
  await withOrg(job.org_id, (db) => db.exec(
    `INSERT INTO notification_events (org_id, user_id, type, severity, title, link, channel, delivered_at)
     SELECT $1, u, 'quality_flag', $2, $3, $4, 'email', now() FROM unnest($5::uuid[]) AS u`,
    [job.org_id, f.severity, `Email sent: ${f.title} — ${f.ref}`, `/inbox/${f.interaction_id}?flag=${f.id}#evidence`, users.map((u) => u.id)]));
  return { sent: users.length };
}
