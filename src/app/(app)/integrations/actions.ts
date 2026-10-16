'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertPermission, auditAction, requestMeta } from '@/lib/auth/session';
import { isUuid, withOrg } from '@/lib/db';
import { retryJob } from '@/lib/pipeline/jobs';
import { getProvider } from '@/lib/providers/registry';
import { errorMessage } from '@/lib/providers/http';
import {
  disconnect, requestSync, saveConnection, setSyncEnabled, testConnection, ValidationError, type Actor,
} from '@/lib/integrations/connections';
import type { ActionState } from './types';

const Intent = z.enum(['save', 'test', 'sync', 'historical', 'enable_sync', 'disable_sync', 'disconnect', 'retry']);

function done(intent: string, ok: boolean, message: string): ActionState {
  return { ok, message, intent, at: Date.now() };
}

/** Single entry point for every button on an integration card (intent = which button). */
export async function integrationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const intentParsed = Intent.safeParse(fd.get('intent'));
  const intent = intentParsed.success ? intentParsed.data : 'save';
  let s;
  try {
    s = await assertPermission(intent === 'retry' ? 'processing.retry' : 'integrations.manage');
  } catch (e) {
    return done(intent, false, errorMessage(e));
  }
  const providerId = String(fd.get('provider') ?? '');
  const p = getProvider(providerId);
  if (!p) return done(intent, false, 'Unknown integration.');
  let meta: { ip?: string; userAgent?: string } = {};
  try { meta = await requestMeta(); } catch { /* ignore */ }
  const actor: Actor = { orgId: s.org.id, userId: s.user.id, ...meta };
  const session = s;

  try {
    const result = await withOrg(s.org.id, async (db): Promise<ActionState> => {
      switch (intent) {
        case 'save': {
          const config: Record<string, string> = {};
          for (const f of p.configFields) if (fd.has(`config.${f.key}`)) config[f.key] = String(fd.get(`config.${f.key}`) ?? '');
          const secrets: Record<string, string> = {};
          for (const f of p.secretFields) secrets[f.key] = String(fd.get(`secret.${f.key}`) ?? '');
          const clearSecrets = p.secretFields.filter((f) => fd.get(`clear.${f.key}`) === 'on').map((f) => f.key);
          const freqRaw = fd.get('syncFrequencyMinutes');
          const histRaw = fd.get('historicalFrom');
          const row = await saveConnection(db, actor, p.id, {
            config, secrets, clearSecrets,
            syncFrequencyMinutes: freqRaw ? Number(freqRaw) : undefined,
            historicalFrom: histRaw === null ? undefined : String(histRaw),
          });
          return done(intent, true, row.status === 'configured'
            ? 'Saved. Credentials are stored encrypted — now click "Test connection".'
            : 'Saved.');
        }
        case 'test': {
          const r = await testConnection(db, actor, p.id);
          return done(intent, r.ok, r.message);
        }
        case 'sync': {
          const r = await requestSync(db, actor, p.id, 'sync');
          return done(intent, r.queued, r.message);
        }
        case 'historical': {
          const from = String(fd.get('historicalFrom') ?? '') || null;
          const r = await requestSync(db, actor, p.id, 'historical_import', from);
          return done(intent, r.queued, r.message);
        }
        case 'enable_sync':
        case 'disable_sync': {
          await setSyncEnabled(db, actor, p.id, intent === 'enable_sync');
          return done(intent, true, intent === 'enable_sync' ? 'Scheduled sync enabled.' : 'Scheduled sync paused.');
        }
        case 'disconnect': {
          await disconnect(db, actor, p.id);
          return done(intent, true, `${p.name} disconnected. Saved credentials were deleted and the webhook URL was revoked.`);
        }
        case 'retry': {
          const jobId = String(fd.get('jobId') ?? '');
          if (!isUuid(jobId)) return done(intent, false, 'Invalid job.');
          const job = await db.one<{ id: string; type: string }>(
            `SELECT j.id, j.type FROM processing_jobs j JOIN integration_connections c ON c.id = j.connection_id
              WHERE j.id = $1 AND c.provider = $2`, [jobId, p.id]);
          if (!job) return done(intent, false, 'Job not found.');
          const n = await retryJob(db, jobId);
          await auditAction(db, session, 'processing.retry', 'processing_job', jobId, { type: job.type, provider: p.id });
          return done(intent, n > 0, n > 0 ? 'Job re-queued.' : 'This job is not in a retryable state.');
        }
      }
    });
    revalidatePath('/integrations');
    return result;
  } catch (e) {
    if (e instanceof ValidationError) return done(intent, false, e.message);
    return done(intent, false, `Could not complete the request: ${errorMessage(e, 300)}`);
  }
}
