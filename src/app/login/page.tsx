import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { withSystem } from '@/lib/db';
import { AuthShell } from './AuthShell';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const s = await getSession();
  if (s && (!s.user.mfaEnabled || s.mfaVerified)) redirect('/');
  const showDemo = process.env.DEMO_SHOW_CREDENTIALS !== 'false'
    && (await withSystem((db) => db.one<{ d: boolean }>(`SELECT EXISTS (SELECT 1 FROM users WHERE is_demo AND is_active) AS d`)))?.d;
  return (
    <AuthShell title="Sign in" subtitle="For authorised Rosier Foods CX, quality and management staff."
      footer={showDemo ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
          <p className="mb-1 font-semibold">Demo accounts (DEMO DATA only)</p>
          <p>Password: <code className="font-mono">{process.env.DEMO_PASSWORD ?? 'RosierDemo@2026'}</code></p>
          <ul className="mt-1 space-y-0.5 font-mono">
            <li>admin@rosier.demo — Super Admin</li>
            <li>crm@rosier.demo — CRM Manager</li>
            <li>lead.calls@rosier.demo — Team Leader</li>
            <li>qa@rosier.demo — Quality Analyst</li>
            <li>priya@rosier.demo — Support Agent</li>
          </ul>
          <p className="mt-2 text-amber-800">Hide this panel with DEMO_SHOW_CREDENTIALS=false, and remove demo users from Settings before going live.</p>
        </div>
      ) : null}>
      <LoginForm />
    </AuthShell>
  );
}
