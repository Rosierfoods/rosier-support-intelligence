'use server';
import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { auditAction, getSession, hashPassword, markMfaVerified, validatePasswordStrength, type Session } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { decryptString, encryptString } from '@/lib/crypto';
import { generateTotpSecret, verifyTotp } from '@/lib/auth/totp';
import { rateLimit } from '@/lib/auth/rate-limit';
import type { ActionResult } from '@/components/analytics/ActionForm';

async function me(): Promise<Session> {
  const s = await getSession();
  if (!s || (s.user.mfaEnabled && !s.mfaVerified)) throw new Error('Not signed in');
  return s;
}

const pwSchema = z.object({
  current: z.string().min(1, 'Enter your current password.').max(200),
  next: z.string().min(1).max(200),
  confirm: z.string().max(200),
});

/** Change own password: verify current, enforce strength, bcrypt, revoke all other sessions. */
export async function changePassword(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await me();
    const v = pwSchema.parse(Object.fromEntries(fd));
    if (!rateLimit(`pwchange:${s.user.id}`, 5, 15 * 60_000).ok) throw new Error('Too many attempts. Please wait a few minutes.');
    if (v.next !== v.confirm) throw new Error('The new passwords don’t match.');
    if (v.next === v.current) throw new Error('Choose a password different from your current one.');
    const weak = validatePasswordStrength(v.next);
    if (weak) throw new Error(weak);
    const revoked = await withOrg(s.org.id, async (db) => {
      const row = await db.one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`, [s.user.id]);
      if (!row || !(await bcrypt.compare(v.current, row.password_hash))) {
        await auditAction(db, s, 'auth.password_change_failed', 'user', s.user.id, {});
        throw new Error('Your current password is incorrect.');
      }
      await db.exec(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [s.user.id, await hashPassword(v.next)]);
      const n = await db.exec(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [s.user.id, s.id]);
      await auditAction(db, s, 'auth.password_changed', 'user', s.user.id, { other_sessions_revoked: n });
      return n;
    });
    return { ok: true, message: `Password changed.${revoked ? ` ${revoked} other session${revoked > 1 ? 's were' : ' was'} signed out.` : ''}` };
  } catch (e) { return { ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message : (e as Error).message }; }
}

/** Step 1 of MFA enrolment: generate a secret and store it encrypted (not yet enabled). */
export async function startMfaSetup(_: ActionResult, _fd: FormData): Promise<ActionResult> {
  try {
    const s = await me();
    if (s.user.mfaEnabled) throw new Error('Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    await withOrg(s.org.id, async (db) => {
      await db.exec(`UPDATE users SET mfa_secret_enc = $2 WHERE id = $1 AND NOT mfa_enabled`, [s.user.id, encryptString(secret)]);
      await auditAction(db, s, 'auth.mfa_setup_started', 'user', s.user.id, {});
    });
    revalidatePath('/profile');
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.') });

/** Step 2: verify a code against the pending secret, then enable MFA and mark this session verified. */
export async function confirmMfaSetup(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await me();
    const { code } = codeSchema.parse(Object.fromEntries(fd));
    if (!rateLimit(`mfa-setup:${s.user.id}`, 6, 5 * 60_000).ok) throw new Error('Too many attempts. Please wait a few minutes.');
    await withOrg(s.org.id, async (db) => {
      const row = await db.one<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(`SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1 FOR UPDATE`, [s.user.id]);
      if (row?.mfa_enabled) throw new Error('Two-factor authentication is already enabled.');
      if (!row?.mfa_secret_enc) throw new Error('Start the setup first.');
      if (!verifyTotp(decryptString(row.mfa_secret_enc), code)) {
        await auditAction(db, s, 'auth.mfa_setup_failed', 'user', s.user.id, {});
        throw new Error('That code didn’t match. Check the time on your phone and try the current code.');
      }
      await db.exec(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [s.user.id]);
      await auditAction(db, s, 'auth.mfa_enabled', 'user', s.user.id, {});
    });
    await markMfaVerified(s.id);
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Two-factor authentication is on. You’ll be asked for a code at each sign-in.' };
  } catch (e) { return { ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message : (e as Error).message }; }
}

export async function cancelMfaSetup(_: ActionResult, _fd: FormData): Promise<ActionResult> {
  try {
    const s = await me();
    await withOrg(s.org.id, (db) => db.exec(`UPDATE users SET mfa_secret_enc = NULL WHERE id = $1 AND NOT mfa_enabled`, [s.user.id]));
    revalidatePath('/profile');
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Disable MFA — requires a current code. */
export async function disableMfa(_: ActionResult, fd: FormData): Promise<ActionResult> {
  try {
    const s = await me();
    const { code } = codeSchema.parse(Object.fromEntries(fd));
    if (!rateLimit(`mfa-disable:${s.user.id}`, 6, 5 * 60_000).ok) throw new Error('Too many attempts. Please wait a few minutes.');
    await withOrg(s.org.id, async (db) => {
      const row = await db.one<{ mfa_secret_enc: string | null; mfa_enabled: boolean }>(`SELECT mfa_secret_enc, mfa_enabled FROM users WHERE id = $1 FOR UPDATE`, [s.user.id]);
      if (!row?.mfa_enabled || !row.mfa_secret_enc) throw new Error('Two-factor authentication is not enabled.');
      if (!verifyTotp(decryptString(row.mfa_secret_enc), code)) {
        await auditAction(db, s, 'auth.mfa_disable_failed', 'user', s.user.id, {});
        throw new Error('That code didn’t match.');
      }
      await db.exec(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1`, [s.user.id]);
      await auditAction(db, s, 'auth.mfa_disabled', 'user', s.user.id, {});
    });
    revalidatePath('/', 'layout');
    return { ok: true, message: 'Two-factor authentication has been turned off.' };
  } catch (e) { return { ok: false, error: e instanceof z.ZodError ? e.issues[0]?.message : (e as Error).message }; }
}
