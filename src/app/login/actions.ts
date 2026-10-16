'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession, loginWithPassword, markMfaVerified, requestMeta, audit } from '@/lib/auth/session';
import { rateLimit } from '@/lib/auth/rate-limit';
import { withSystem } from '@/lib/db';
import { decryptString } from '@/lib/crypto';
import { verifyTotp } from '@/lib/auth/totp';

export type FormState = { error?: string } | undefined;

const schema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const parsed = schema.safeParse({ email: form.get('email'), password: form.get('password') });
  if (!parsed.success) return { error: 'Enter a valid email and password.' };
  const { ip } = await requestMeta();
  const rl = rateLimit(`login:${ip}`, 10, 5 * 60_000);
  const rlUser = rateLimit(`login-user:${parsed.data.email.toLowerCase()}`, 8, 5 * 60_000);
  if (!rl.ok || !rlUser.ok) return { error: 'Too many sign-in attempts. Please wait a few minutes.' };
  const r = await loginWithPassword(parsed.data.email, parsed.data.password);
  if (!r.ok) return { error: r.error };
  redirect(r.mfaRequired ? '/login/mfa' : '/');
}

export async function mfaAction(_: FormState, form: FormData): Promise<FormState> {
  const s = await getSession();
  if (!s) redirect('/login');
  const code = String(form.get('code') ?? '');
  const rl = rateLimit(`mfa:${s.id}`, 6, 5 * 60_000);
  if (!rl.ok) return { error: 'Too many attempts. Please wait a few minutes.' };
  const row = await withSystem((db) => db.one<{ mfa_secret_enc: string | null }>('SELECT mfa_secret_enc FROM users WHERE id = $1', [s.user.id]));
  if (!row?.mfa_secret_enc || !verifyTotp(decryptString(row.mfa_secret_enc), code)) {
    const meta = await requestMeta();
    await withSystem((db) => audit(db, s.org.id, s.user.id, 'auth.mfa_failed', 'user', s.user.id, {}, meta));
    return { error: 'That code didn’t match. Check your authenticator app and try again.' };
  }
  await markMfaVerified(s.id);
  const meta2 = await requestMeta();
  await withSystem((db) => audit(db, s.org.id, s.user.id, 'auth.mfa_verified', 'user', s.user.id, {}, meta2));
  redirect('/');
}
