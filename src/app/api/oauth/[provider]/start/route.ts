import { NextResponse, type NextRequest } from 'next/server';
import { getSession, auditAction } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { randomToken, sha256Hex } from '@/lib/crypto';
import { getProvider } from '@/lib/providers/registry';
import { buildContext, getConnectionRow, oauthRedirectUri, appUrl } from '@/lib/integrations/connections';

export const dynamic = 'force-dynamic';

function back(provider: string, status: 'ok' | 'error', msg: string) {
  const u = new URL('/integrations', appUrl());
  u.searchParams.set('provider', provider);
  u.searchParams.set('oauth', status);
  u.searchParams.set('msg', msg.slice(0, 300));
  u.hash = `card-${provider}`;
  return NextResponse.redirect(u, { status: 303 });
}

/** Starts the OAuth authorisation-code flow for Gmail / Microsoft 365 (integrations.manage). */
export async function GET(_req: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  const s = await getSession();
  if (!s || (s.user.mfaEnabled && !s.mfaVerified)) return NextResponse.redirect(new URL('/login', appUrl()), { status: 303 });
  if (!s.permissions.has('integrations.manage')) return NextResponse.redirect(new URL('/forbidden', appUrl()), { status: 303 });
  const p = getProvider(params.provider);
  if (!p?.oauth) return NextResponse.json({ error: 'This provider does not use OAuth' }, { status: 404 });

  const result = await withOrg(s.org.id, async (db) => {
    const row = await getConnectionRow(db, s.org.id, p.id);
    if (!row || !row.config?.clientId || !row.secrets_enc) return { error: 'Save the OAuth client ID and client secret first.', url: null };
    const ctx = buildContext(row);
    if (!ctx.secrets.clientSecret) return { error: 'Save the OAuth client secret first.', url: null };
    const state = randomToken(32);
    const redirectUri = oauthRedirectUri(p.id);
    await db.exec('DELETE FROM oauth_states WHERE expires_at < now()');
    await db.exec(
      `INSERT INTO oauth_states (org_id, user_id, connection_id, provider, state_hash, redirect_uri, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes')`,
      [s.org.id, s.user.id, row.id, p.id, sha256Hex(state), redirectUri]);
    await auditAction(db, s, 'integration.oauth_started', 'integration_connection', row.id, { provider: p.id });
    return { error: null, url: p.oauth!.authorizeUrl(ctx, state, redirectUri) };
  });
  if (!result.url) return back(p.id, 'error', result.error ?? 'Could not start authorisation.');
  return NextResponse.redirect(result.url, { status: 303 });
}
