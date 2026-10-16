'use client';
import { useEffect, useRef, useState } from 'react';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Check, Copy, ExternalLink, KeyRound, RefreshCw, ShieldCheck, Unplug, Webhook, History, PlugZap, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { Badge, buttonClass } from '@/components/ui';
import type { ConnectionView } from '@/lib/integrations/connections';
import { integrationAction } from './actions';
import { FREQUENCY_OPTIONS, STATUS_META, type ActionState, type FailedJobView, type ProviderMeta, type SyncRunView, type WebhookEventView } from './types';

function fmt(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function ago(d: string | null) {
  if (!d) return null;
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? STATUS_META.disconnected;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

function CopyField({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <input readOnly value={value} className="input font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label={label} />
        <button type="button" className={buttonClass('secondary', 'md', 'shrink-0')}
          onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } }}>
          {copied ? <Check size={14} /> : <Copy size={14} />}<span className="hidden sm:inline">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {hint && <span className="mt-1 block text-2xs text-ink-faint">{hint}</span>}
    </div>
  );
}

function IntentButton({ intent, children, variant = 'secondary', disabled, confirmText, title }: {
  intent: string; children: React.ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; disabled?: boolean; confirmText?: string; title?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name="intent" value={intent} disabled={disabled || pending} title={title}
      formNoValidate={intent !== 'save'}
      onClick={(e) => { if (confirmText && !window.confirm(confirmText)) e.preventDefault(); }}
      className={buttonClass(variant, 'md')}>
      {children}
    </button>
  );
}

function Pending() {
  const { pending } = useFormStatus();
  return pending ? <span className="text-xs text-ink-muted" role="status">Working…</span> : null;
}

function RetryJob({ provider, jobId }: { provider: string; jobId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(integrationAction, undefined);
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="jobId" value={jobId} />
      <IntentButton intent="retry"><RefreshCw size={13} />Retry</IntentButton>
      {state?.message && <span className={clsx('text-2xs', state.ok ? 'text-emerald-700' : 'text-red-700')}>{state.message}</span>}
    </form>
  );
}

function Disclosure({ title, icon, children, defaultOpen }: { title: string; icon?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-lg border border-line" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-ink hover:bg-brand-50/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="text-ink-faint transition-transform group-open:rotate-90" />
        {icon}{title}
      </summary>
      <div className="border-t border-line px-3 py-3">{children}</div>
    </details>
  );
}

const runTone = (s: string) => (s === 'success' ? 'good' : s === 'partial' ? 'warn' : s === 'failed' ? 'bad' : 'info') as 'good' | 'warn' | 'bad' | 'info';
const evTone = (s: string) => (s === 'processed' ? 'good' : s === 'failed' ? 'bad' : s === 'ignored' ? 'muted' : 'info') as 'good' | 'bad' | 'muted' | 'info';

export function IntegrationCard({ meta, view, runs, events, jobs, canRetry }: {
  meta: ProviderMeta; view: ConnectionView; runs: SyncRunView[]; events: WebhookEventView[]; jobs: FailedJobView[]; canRetry: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(integrationAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // Clear typed secrets after a successful save so they don't linger in the DOM.
    if (state?.ok && state.intent === 'save') formRef.current?.querySelectorAll<HTMLInputElement>('input[type=password]').forEach((i) => { i.value = ''; });
  }, [state]);

  const connected = view.status === 'connected' || (view.status === 'error' && !!view.lastSuccessAt);
  const saved = view.status !== 'disconnected';
  const hasActivity = meta.supportsPolling || meta.supportsWebhook;

  return (
    <section id={`card-${meta.id}`} className="card scroll-mt-20 overflow-hidden">
      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{meta.name}</h3>
            <StatusBadge status={view.status} />
            {meta.supportsWebhook && <Badge tone="muted"><Webhook size={11} />Webhook</Badge>}
            {meta.supportsPolling && <Badge tone="muted"><RefreshCw size={11} />Scheduled sync</Badge>}
            {meta.hasOAuth && <Badge tone="muted"><KeyRound size={11} />OAuth</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-ink-muted">{meta.description}</p>
        </div>
        <a href={meta.docsUrl} target="_blank" rel="noreferrer noopener" className={buttonClass('ghost', 'sm', 'shrink-0 self-start')}>
          Provider docs <ExternalLink size={12} />
        </a>
      </div>

      <div className="space-y-4 p-4">
        {/* Health */}
        <dl className="grid grid-cols-1 gap-3 rounded-lg bg-canvas/60 p-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Connection health</dt>
            <dd className={clsx('mt-0.5 break-words', view.lastTestOk === false ? 'text-red-800' : 'text-ink')}>
              {view.lastTestedAt ? <>{view.lastTestOk ? 'Test passed' : 'Test failed'} · {ago(view.lastTestedAt)}</> : 'Not tested yet'}
              {view.lastTestMessage && <span className="mt-0.5 block text-xs text-ink-muted">{view.lastTestMessage}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Last successful sync</dt>
            <dd className="mt-0.5 text-ink">{!hasActivity ? <span className="text-ink-muted">Not applicable — used on demand by the processing pipeline</span> : view.lastSuccessAt ? <>{fmt(view.lastSuccessAt)} <span className="text-xs text-ink-muted">({ago(view.lastSuccessAt)})</span></> : '—'}
              {meta.supportsPolling && <span className="block text-xs text-ink-muted">Scheduled sync {view.syncEnabled ? 'on' : 'off'}</span>}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">Last error</dt>
            <dd className={clsx('mt-0.5 break-words', view.lastError ? 'text-red-800' : 'text-ink')}>
              {view.lastError ? <><span className="line-clamp-3">{view.lastError}</span><span className="text-xs text-ink-muted">{fmt(view.lastErrorAt)}</span></> : 'None'}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{meta.supportsWebhook ? 'Webhook' : meta.hasOAuth ? 'Authorised account' : 'Mode'}</dt>
            <dd className="mt-0.5 text-ink">
              {meta.supportsWebhook ? (view.webhookVerifiedAt
                ? <span className="inline-flex items-center gap-1 text-emerald-800"><ShieldCheck size={14} />Verified {ago(view.webhookVerifiedAt)}</span>
                : <span className="text-ink-muted">Not yet verified</span>)
                : meta.hasOAuth ? (view.oauthAuthorized ? <span className="break-all">{view.accountEmail ?? 'Authorised'}</span> : <span className="text-ink-muted">Not authorised</span>)
                : <span className="text-ink-muted">API key</span>}
            </dd>
          </div>
        </dl>

        {/* Permissions & data */}
        <Disclosure title="Permissions required & data imported" icon={<ShieldCheck size={14} className="text-brand-500" />} defaultOpen={!connected}>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Access requested</p>
              <ul className="space-y-1.5 text-sm">
                {meta.scopes.length === 0 && <li className="text-ink-muted">An API key only — this service reads no account data; it processes what this platform sends it.</li>}
                {meta.scopes.map((sc) => (
                  <li key={sc.key}><span className="font-medium text-ink">{sc.label}</span><span className="block text-xs text-ink-muted">{sc.description}</span></li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-ink-muted">What will be imported</p>
              <ul className="list-disc space-y-1 pl-4 text-sm text-ink">{meta.dataImported.map((d) => <li key={d}>{d}</li>)}</ul>
            </div>
          </div>
          {meta.limitations.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs font-semibold text-amber-900">Known limitations</p>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-amber-900">{meta.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          )}
        </Disclosure>

        {/* Configuration form */}
        <form ref={formRef} action={action} className="space-y-4" autoComplete="off">
          <input type="hidden" name="provider" value={meta.id} />
          {(meta.configFields.length > 0 || meta.secretFields.length > 0) && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {meta.configFields.map((f) => (
                <label key={f.key} className="block">
                  <span className="label">{f.label}{f.required && <span className="text-red-700"> *</span>}</span>
                  {f.type === 'select' ? (
                    <select name={`config.${f.key}`} defaultValue={view.config[f.key] ?? f.options?.[0]?.value ?? ''} className="input">
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input name={`config.${f.key}`} type={f.type === 'url' ? 'url' : f.type === 'number' ? 'number' : 'text'} defaultValue={view.config[f.key] ?? ''}
                      placeholder={f.placeholder} className="input" spellCheck={false} />
                  )}
                  {f.help && <span className="mt-1 block text-2xs text-ink-faint">{f.help}</span>}
                </label>
              ))}
              {meta.secretFields.map((f) => {
                const s = view.secrets[f.key];
                return (
                  <div key={f.key}>
                    <label className="block">
                      <span className="label">{f.label}{f.required && <span className="text-red-700"> *</span>}</span>
                      <input name={`secret.${f.key}`} type="password" autoComplete="new-password" spellCheck={false}
                        placeholder={s?.saved ? `${s.masked} (saved — leave blank to keep)` : f.placeholder ?? 'Not set'} className="input font-mono" />
                    </label>
                    <span className="mt-1 flex flex-wrap items-center gap-x-3 text-2xs text-ink-faint">
                      {f.help && <span>{f.help}</span>}
                      {s?.saved && !f.required && (
                        <label className="inline-flex items-center gap-1"><input type="checkbox" name={`clear.${f.key}`} className="h-3 w-3" />Remove saved value</label>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {meta.supportsPolling && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="label">Sync frequency</span>
                <select name="syncFrequencyMinutes" defaultValue={String(view.syncFrequencyMinutes)} className="input">
                  {FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="label">Historical import from</span>
                <input type="date" name="historicalFrom" defaultValue={view.historicalFrom ?? ''} max={new Date().toISOString().slice(0, 10)} className="input" />
                <span className="mt-1 block text-2xs text-ink-faint">Used by “Run historical import”. Older data is imported once, in the background.</span>
              </label>
            </div>
          )}

          {meta.supportsWebhook && (
            view.webhookUrl
              ? <CopyField label="Webhook URL (register this with the provider)" value={view.webhookUrl}
                  hint={<>Keep this URL private — it identifies your account. Verification: {view.webhookVerifiedAt ? `verified ${fmt(view.webhookVerifiedAt)}` : 'waiting for the first verified request'}.</>} />
              : <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-muted">Save the configuration to generate this integration’s private webhook URL.</p>
          )}
          {meta.hasOAuth && meta.redirectUri && (
            <CopyField label="Authorised redirect URI (add to your OAuth app)" value={meta.redirectUri} />
          )}

          {state?.message && (
            <p role="status" className={clsx('rounded-lg px-3 py-2 text-sm', state.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-800')}>{state.message}</p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <IntentButton intent="save" variant="primary">Save</IntentButton>
            <IntentButton intent="test" disabled={!saved} title={!saved ? 'Save first' : undefined}><PlugZap size={14} />Test connection</IntentButton>
            {meta.hasOAuth && (
              saved && view.config.clientId && view.secrets.clientSecret?.saved
                ? <a href={`/api/oauth/${meta.id}/start`} className={buttonClass('secondary', 'md')}><KeyRound size={14} />{view.oauthAuthorized ? 'Re-authorise' : `Connect with ${meta.id === 'gmail' ? 'Google' : 'Microsoft'}`}</a>
                : <span className={buttonClass('secondary', 'md', 'pointer-events-none opacity-50')} title="Save client ID and secret first"><KeyRound size={14} />Connect with {meta.id === 'gmail' ? 'Google' : 'Microsoft'}</span>
            )}
            {meta.supportsPolling && (
              <>
                <IntentButton intent="sync" disabled={!connected} title={!connected ? 'Test the connection first' : undefined}><RefreshCw size={14} />Sync now</IntentButton>
                <IntentButton intent="historical" disabled={!connected} title={!connected ? 'Test the connection first' : undefined}><History size={14} />Run historical import</IntentButton>
                <IntentButton intent={view.syncEnabled ? 'disable_sync' : 'enable_sync'} disabled={!view.syncEnabled && view.status !== 'connected'}
                  title={!view.syncEnabled && view.status !== 'connected' ? 'Available after a successful connection test' : undefined}>
                  <span className={clsx('inline-block h-3.5 w-6 rounded-full p-0.5 transition-colors', view.syncEnabled ? 'bg-emerald-600' : 'bg-stone-300')} aria-hidden>
                    <span className={clsx('block h-2.5 w-2.5 rounded-full bg-white transition-transform', view.syncEnabled && 'translate-x-2.5')} />
                  </span>
                  {view.syncEnabled ? 'Scheduled sync on' : 'Enable scheduled sync'}
                </IntentButton>
              </>
            )}
            <span className="flex-1" />
            <Pending />
            {saved && (
              <IntentButton intent="disconnect" variant="ghost" confirmText={`Disconnect ${meta.name}? Saved credentials will be deleted and the webhook URL revoked. Imported data is kept.`}>
                <Unplug size={14} />Disconnect
              </IntentButton>
            )}
          </div>
        </form>

        <Disclosure title="Setup instructions" icon={<KeyRound size={14} className="text-brand-500" />}>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink">{meta.setupSteps.map((s) => <li key={s}>{s}</li>)}</ol>
          <p className="mt-2 text-xs text-ink-muted">Full reference: <span className="font-mono">docs/INTEGRATIONS.md</span> in the deployment repository · <a className="underline" href={meta.docsUrl} target="_blank" rel="noreferrer noopener">provider documentation</a>.</p>
        </Disclosure>

        {hasActivity && saved && (
          <Disclosure title={`Activity — ${runs.length} sync runs · ${events.length} webhook events · ${jobs.length} failed jobs`} icon={<History size={14} className="text-brand-500" />} defaultOpen={jobs.length > 0}>
            <div className="space-y-4">
              {meta.supportsPolling && (
                <div>
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Recent sync runs</p>
                  {runs.length === 0 ? <p className="text-sm text-ink-muted">No sync runs yet.</p> : (
                    <div className="overflow-x-auto scrollbar-thin">
                      <table className="min-w-full divide-y divide-line text-sm">
                        <thead><tr><th className="th">Started</th><th className="th">Trigger</th><th className="th">Status</th><th className="th text-right">Fetched</th><th className="th text-right">New</th><th className="th text-right">Existing</th><th className="th text-right">Failed</th><th className="th">Error</th></tr></thead>
                        <tbody className="divide-y divide-line">
                          {runs.map((r) => (
                            <tr key={r.id}>
                              <td className="td whitespace-nowrap">{fmt(r.startedAt)}</td>
                              <td className="td capitalize">{r.trigger}</td>
                              <td className="td"><Badge tone={runTone(r.status)}>{r.status}</Badge></td>
                              <td className="td text-right tabular-nums">{r.fetched}</td>
                              <td className="td text-right tabular-nums">{r.created}</td>
                              <td className="td text-right tabular-nums">{r.duplicate}</td>
                              <td className="td text-right tabular-nums">{r.failed}</td>
                              <td className="td max-w-xs text-xs text-red-800"><span className="line-clamp-2">{r.error ?? ''}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              {meta.supportsWebhook && (
                <div>
                  <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Recent webhook events</p>
                  {events.length === 0 ? <p className="text-sm text-ink-muted">No webhook deliveries received yet.</p> : (
                    <div className="overflow-x-auto scrollbar-thin">
                      <table className="min-w-full divide-y divide-line text-sm">
                        <thead><tr><th className="th">Received</th><th className="th">Event</th><th className="th">Signature</th><th className="th">Status</th><th className="th">Error</th></tr></thead>
                        <tbody className="divide-y divide-line">
                          {events.map((e) => (
                            <tr key={e.id}>
                              <td className="td whitespace-nowrap">{fmt(e.receivedAt)}</td>
                              <td className="td max-w-[14rem] truncate font-mono text-xs" title={e.eventKey}>{e.eventKey}</td>
                              <td className="td">{e.signatureValid === null ? '—' : e.signatureValid ? <Badge tone="good">Valid</Badge> : <Badge tone="bad">Invalid</Badge>}</td>
                              <td className="td"><Badge tone={evTone(e.status)}>{e.status}</Badge></td>
                              <td className="td max-w-xs text-xs text-red-800"><span className="line-clamp-2">{e.error ?? ''}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              <div>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Failed processing jobs</p>
                {jobs.length === 0 ? <p className="text-sm text-ink-muted">No failed jobs.</p> : (
                  <div className="overflow-x-auto scrollbar-thin">
                    <table className="min-w-full divide-y divide-line text-sm">
                      <thead><tr><th className="th">Updated</th><th className="th">Job</th><th className="th">Status</th><th className="th text-right">Attempts</th><th className="th">Error</th><th className="th" /></tr></thead>
                      <tbody className="divide-y divide-line">
                        {jobs.map((j) => (
                          <tr key={j.id}>
                            <td className="td whitespace-nowrap">{fmt(j.updatedAt)}</td>
                            <td className="td">{j.type.replace('_', ' ')}</td>
                            <td className="td"><Badge tone={j.status === 'dead' ? 'bad' : 'warn'}>{j.status === 'dead' ? 'failed' : j.status}</Badge></td>
                            <td className="td text-right tabular-nums">{j.attempts}</td>
                            <td className="td max-w-sm text-xs text-red-800"><span className="line-clamp-2">{j.lastError ?? ''}</span></td>
                            <td className="td">{canRetry ? <RetryJob provider={meta.id} jobId={j.id} /> : null}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </Disclosure>
        )}
      </div>
    </section>
  );
}
