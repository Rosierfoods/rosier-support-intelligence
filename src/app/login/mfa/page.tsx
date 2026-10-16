import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AuthShell } from '../AuthShell';
import { MfaForm } from '../LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Two-factor verification' };

export default async function MfaPage() {
  const s = await getSession();
  if (!s) redirect('/login');
  if (!s.user.mfaEnabled || s.mfaVerified) redirect('/');
  return (
    <AuthShell title="Two-factor verification" subtitle={`Signed in as ${s.user.email}`}>
      <MfaForm />
    </AuthShell>
  );
}
