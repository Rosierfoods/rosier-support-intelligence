import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { withOrg, withSystem } from '@/lib/db';
import { sha256Hex } from '@/lib/crypto';
import { getProvider } from '@/lib/providers/registry';
import { errorMessage } from '@/lib/providers/http';
import { appUrl, buildContext, getConnectionRow, storeOAuthTokens, testConnection, type Actor } from '@/lib/integrations/connections';

export const dynamic = 'force-dynamic';

function back(provider: string, status: 'ok' | 'error', msg: string) {
  const u = new URL('/integrations', appUrl());
  u.searchParams.set('provider', provider);
  u.searchParams.set('oauth', status);
  u.searchParams.set('msg', msg.slice(0, 300));
  u.hash = `card-${provider}`;
  return NextResponse.redirect(u, { status: 303 });
}

/**
 * OAuth redirect target. Validates the single-use state (10-minute expiry, same signed-in user), exchanges the code
 * for tokens (stored encrypted), then runs Test connection — the integration becomes "connected" only if that passes.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  const p = getProvider(params.provider);
  if (!p?.oauth) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const sp = req.nextUrl.searchParams;
  const state = sp.get('state') ?? '';
  const code = sp.get('code') ?? '';
  const providerError = sp.get('error');

  if (!state) return back(p.id, 'error', 'Missing OAuth state. Start again from the Integrations page.');
  const st = await withSystem((db) => db.one<{ id: string; org_id: string; user_id: string; connection_id: string; redirect_uri: string }>(
    `UPDATE oauth_states SET used_at = now()
      WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING id, org_id, user_id, connection_id, redirect_uri`, [sha256Hex(state), p.id]));
  if (!st) return back(p.id, 'error', 'This authorisation link has expired or was already used. Click Connect again.');

  const s = await getSession();
  if (!s || s.user.id !== st.user_id || s.org.id !== st.org_id || !s.permissions.has('integrations.manage')) {
    return back(p.id, 'error', 'Sign in as the administrator who started the connection, then try again.');
  }
  if (providerError) {
    const desc = (sp.get('error_description') ?? providerError).replace(/[^\w\s.,:'()-]/g, ' ').slice(0, 200);
    return back(p.id, 'error', `Authorisation was not granted: ${desc}`);
  }
  if (!code) return back(p.id, 'error', 'No authorisation code was returned.');

  const actor: Actor = { orgId: s.org.id, userId: s.user.id };
  try {
    const result = await withOrg(s.org.id, async (db) => {
      const row = await getConnectionRow(db, s.org.id, p.id);
      if (!row || row.id !== st.connection_id) throw new Error('Connection not found.');
      const tokens = await p.oauth!.exchangeCode(buildContext(row), code, st.redirect_uri);
      await storeOAuthTokens(db, actor, p.id, tokens.secrets, tokens.expiresAt ?? null, tokens.account);
      return testConnection(db, actor, p.id);
    });
    return back(p.id, result.ok ? 'ok' : 'error', result.ok ? `Authorised. ${result.message}` : `Authorised, but the connection test failed: ${result.message}`);
  } catch (e) {
    return back(p.id, 'error', `Could not complete authorisation: ${errorMessage(e, 200)}`);
  }
}
