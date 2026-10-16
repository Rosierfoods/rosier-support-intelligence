// Shared (server + client) shapes for the Integrations page. No functions, no secrets.
import type { FieldDef, ProviderDefinition } from '@/lib/providers/types';

export interface ProviderMeta {
  id: string;
  name: string;
  category: ProviderDefinition['category'];
  description: string;
  docsUrl: string;
  authType: ProviderDefinition['authType'];
  configFields: FieldDef[];
  secretFields: FieldDef[];
  scopes: { key: string; label: string; description: string }[];
  dataImported: string[];
  setupSteps: string[];
  limitations: string[];
  supportsWebhook: boolean;
  supportsPolling: boolean;
  hasOAuth: boolean;
  redirectUri: string | null;
}

export interface SyncRunView {
  id: string; trigger: string; status: string; startedAt: string; finishedAt: string | null;
  fetched: number; created: number; duplicate: number; failed: number; error: string | null;
}
export interface WebhookEventView {
  id: string; status: string; signatureValid: boolean | null; receivedAt: string; eventKey: string; error: string | null;
}
export interface FailedJobView {
  id: string; type: string; status: string; attempts: number; lastError: string | null; updatedAt: string;
}

export type ActionState = { ok?: boolean; message?: string; intent?: string; at?: number } | undefined;

export const STATUS_META: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' | 'neutral' }> = {
  connected: { label: 'Connected', tone: 'good' },
  configured: { label: 'Configured – not tested', tone: 'warn' },
  error: { label: 'Error', tone: 'bad' },
  disconnected: { label: 'Not connected', tone: 'muted' },
  paused: { label: 'Paused', tone: 'neutral' },
};

export const FREQUENCY_OPTIONS: { value: number; label: string }[] = [
  { value: 5, label: 'Every 5 minutes' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Hourly' },
  { value: 180, label: 'Every 3 hours' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Daily' },
];
