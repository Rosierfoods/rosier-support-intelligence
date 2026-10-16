import { Lock, Plug, Puzzle } from 'lucide-react';
import { requirePermission, can } from '@/lib/auth/session';
import { withOrg } from '@/lib/db';
import { Notice, PageHeader, Badge } from '@/components/ui';
import { PROVIDER_GROUPS, PROVIDERS } from '@/lib/providers/registry';
import { listConnectionViews, oauthRedirectUri } from '@/lib/integrations/connections';
import { IntegrationCard, StatusBadge } from './IntegrationCard';
import type { FailedJobView, ProviderMeta, SyncRunView, WebhookEventView } from './types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Integrations & API Settings' };

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export default async function IntegrationsPage(
  props: { searchParams: Promise<Record<string, string | string[] | undefined>> }
) {
  const searchParams = await props.searchParams;
  const s = await requirePermission('integrations.manage');
  const canRetry = can(s, 'processing.retry');

  const data = await withOrg(s.org.id, async (db) => {
    const views = await listConnectionViews(db, s.org.id);
    const runs = await db.query(
      `SELECT * FROM (
         SELECT r.*, c.provider, row_number() OVER (PARTITION BY r.connection_id ORDER BY r.started_at DESC) AS rn
           FROM integration_sync_runs r JOIN integration_connections c ON c.id = r.connection_id) x
        WHERE rn <= 8 ORDER BY started_at DESC`);
    const events = await db.query(
      `SELECT * FROM (
         SELECT e.id, e.status, e.signature_valid, e.received_at, e.event_key, e.error, e.provider,
                row_number() OVER (PARTITION BY e.connection_id ORDER BY e.received_at DESC) AS rn
           FROM webhook_events e) x
        WHERE rn <= 10 ORDER BY received_at DESC`);
    const jobs = await db.query(
      `SELECT j.id, j.type, j.status, j.attempts, j.last_error, j.updated_at, c.provider
         FROM processing_jobs j JOIN integration_connections c ON c.id = j.connection_id
        WHERE j.status IN ('dead','failed') OR (j.status = 'queued' AND j.attempts > 0 AND j.last_error IS NOT NULL)
        ORDER BY j.updated_at DESC LIMIT 100`);
    return { views, runs, events, jobs };
  });

  const metas: ProviderMeta[] = PROVIDERS.map((p) => ({
    id: p.id, name: p.name, category: p.category, description: p.description, docsUrl: p.docsUrl, authType: p.authType,
    configFields: p.configFields, secretFields: p.secretFields, scopes: p.scopes, dataImported: p.dataImported, setupSteps: p.setupSteps,
    limitations: p.limitations ?? [], supportsWebhook: p.supportsWebhook, supportsPolling: p.supportsPolling,
    hasOAuth: !!p.oauth, redirectUri: p.oauth ? oauthRedirectUri(p.id) : null,
  }));
  const viewBy = new Map(data.views.map((v) => [v.provider, v]));
  const runsFor = (pid: string): SyncRunView[] => data.runs.filter((r: any) => r.provider === pid).map((r: any) => ({
    id: r.id, trigger: r.trigger, status: r.status, startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at),
    fetched: r.records_fetched, created: r.records_created, duplicate: r.records_duplicate, failed: r.records_failed, error: r.error,
  }));
  const eventsFor = (pid: string): WebhookEventView[] => data.events.filter((e: any) => e.provider === pid).map((e: any) => ({
    id: e.id, status: e.status, signatureValid: e.signature_valid, receivedAt: iso(e.received_at)!, eventKey: e.event_key, error: e.error,
  }));
  const jobsFor = (pid: string): FailedJobView[] => data.jobs.filter((j: any) => j.provider === pid).slice(0, 10).map((j: any) => ({
    id: j.id, type: j.type, status: j.status, attempts: j.attempts, lastError: j.last_error, updatedAt: iso(j.updated_at)!,
  }));

  const oauth = typeof searchParams.oauth === 'string' ? searchParams.oauth : null;
  const oauthMsg = typeof searchParams.msg === 'string' ? searchParams.msg.slice(0, 300) : null;
  const oauthProvider = typeof searchParams.provider === 'string' ? PROVIDERS.find((p) => p.id === searchParams.provider)?.name : null;
  const connectedCount = data.views.filter((v) => v.status === 'connected').length;

  return (
    <div className="space-y-6">
      <PageHeader title="Integrations & API Settings"
        description="Connect the platforms Rosier's support team uses. Data is imported read-only; credentials never leave the server." />

      {oauth && oauthMsg && (
        <Notice tone={oauth === 'ok' ? 'good' : 'bad'} title={oauthProvider ? `${oauthProvider} authorisation` : 'Authorisation'}>{oauthMsg}</Notice>
      )}

      <div className="grid items-start gap-3 lg:grid-cols-3">
        <div className="card flex items-start gap-3 p-4 lg:col-span-2">
          <Lock size={18} className="mt-0.5 shrink-0 text-brand-500" />
          <div className="text-sm text-ink">
            <p className="font-medium">How credentials are handled</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">
              API keys, tokens and webhook secrets are encrypted (AES-256-GCM) before they are stored and are only shown masked. Provider calls are made from the server only.
              An integration is marked <span className="font-medium text-ink">Connected</span> only after a successful connection test (or a verified, signed webhook).
              Every change is recorded in the audit log, without secret values.
            </p>
          </div>
        </div>
        <div className="card p-4">
          <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Status</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{connectedCount}<span className="text-base font-normal text-ink-muted"> / {PROVIDERS.length} connected</span></p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {metas.map((m) => (
              <li key={m.id}>
                <a href={`#card-${m.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink hover:bg-brand-50">
                  {m.name.split(' (')[0].split(' /')[0]} <StatusBadge status={viewBy.get(m.id)?.status ?? 'disconnected'} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {PROVIDER_GROUPS.map((g) => {
        const items = metas.filter((m) => m.category === g.key);
        if (!items.length) return null;
        return (
          <section key={g.key} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-ink">{g.label}</h2>
              <span className="text-xs text-ink-muted">{g.description}</span>
            </div>
            {items.map((m) => (
              <IntegrationCard key={m.id} meta={m} view={viewBy.get(m.id)!} runs={runsFor(m.id)} events={eventsFor(m.id)} jobs={jobsFor(m.id)} canRetry={canRetry} />
            ))}
          </section>
        );
      })}

      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-ink">Optional</h2>
          <span className="text-xs text-ink-muted">Customer satisfaction & order systems</span>
        </div>
        <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
          <Puzzle size={20} className="shrink-0 text-brand-500" />
          <div className="min-w-0 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-ink">CSAT survey / order-management system</h3>
              <Badge tone="muted">Not configured</Badge>
            </div>
            <p className="mt-1 text-ink-muted">
              Link CSAT scores and order details (order ID, delivery status, refund state) to interactions. No CSAT or order system is connected yet —
              tell us which tool Rosier uses (e.g. Shopify, Unicommerce, a survey tool) and it can be added through the same adapter interface used by the
              integrations above: implement <span className="font-mono text-xs">ProviderDefinition</span> in <span className="font-mono text-xs">src/lib/providers/</span> and
              register it in <span className="font-mono text-xs">registry.ts</span>. It then gets this page’s credential storage, testing, webhooks, scheduled sync and audit trail automatically.
            </p>
          </div>
        </div>
      </section>

      <Notice tone="info" title="Background processing">
        Webhooks are acknowledged immediately and processed by the background worker (<span className="font-mono text-xs">npm run worker</span>), which also runs scheduled syncs.
        An external scheduler can trigger due syncs with <span className="font-mono text-xs">POST /api/cron/tick</span> and the <span className="font-mono text-xs">CRON_SECRET</span> bearer token.
        <span className="ml-1 inline-flex items-center gap-1"><Plug size={12} />Imported records appear in the Unified Inbox once processed.</span>
      </Notice>
    </div>
  );
}
