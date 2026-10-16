/**
 * Provider adapter contract. Each external service (LimeChat, MyOperator, WhatsApp Cloud API, Gmail, Microsoft 365,
 * Sarvam speech-to-text, Anthropic Claude) is one ProviderDefinition. Adapters run server-side only.
 * Field values are never logged; secrets come decrypted from integration_connections.secrets_enc.
 */
export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select' | 'number';
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface ProviderContext {
  orgId: string;
  connectionId: string;
  config: Record<string, any>;
  secrets: Record<string, string>;
  appUrl: string;
  /** Persist refreshed OAuth tokens etc. (encrypted by caller). */
  updateSecrets?: (patch: Record<string, string>, tokenExpiresAt?: Date | null) => Promise<void>;
}

export interface TestResult { ok: boolean; message: string; details?: Record<string, unknown> }

export interface NormalizedMessage {
  externalId: string;
  senderType: 'customer' | 'agent' | 'bot' | 'system';
  senderName?: string | null;
  body: string;
  sentAt: Date;
  attachments?: { fileName?: string | null; mimeType?: string | null; sizeBytes?: number | null; sourceRef?: string | null }[];
}

export interface NormalizedEmail {
  externalId: string;
  senderType: 'customer' | 'agent' | 'system';
  subject?: string | null;
  from?: string | null;
  to?: string[];
  cc?: string[];
  sentAt: Date;
  bodyText: string;
  attachments?: { fileName?: string | null; mimeType?: string | null; sizeBytes?: number | null; sourceRef?: string | null }[];
}

/** One provider record mapped to our model. (sourcePlatform, sourceRecordId) must be stable for idempotency. */
export interface NormalizedInteraction {
  sourcePlatform: string;              // 'myoperator' | 'limechat' | 'whatsapp_cloud' | 'gmail' | 'm365'
  sourceRecordId: string;              // provider's call / conversation / thread id
  channel: 'call' | 'chat' | 'whatsapp' | 'email';
  direction?: 'inbound' | 'outbound';
  occurredAt: Date;
  endedAt?: Date | null;
  subject?: string | null;
  customer?: { name?: string | null; phone?: string | null; email?: string | null; externalId?: string | null };
  agent?: { externalId?: string | null; name?: string | null; email?: string | null };
  status?: string | null;              // provider conversation status (open/closed/...)
  resolutionStatus?: 'open' | 'pending' | 'resolved' | 'unresolved' | 'escalated';
  ticket?: { externalId: string; subject?: string | null; status?: string | null; orderRef?: string | null } | null;
  call?: {
    status: 'answered' | 'missed' | 'voicemail' | 'failed';
    durationSeconds?: number | null;
    ringSeconds?: number | null;
    fromNumber?: string | null;
    toNumber?: string | null;
    recordingRef?: string | null;      // URL or provider file id; fetched server-side by the transcription job
    languageHint?: string | null;
  };
  messages?: NormalizedMessage[];      // chat / WhatsApp
  emails?: NormalizedEmail[];          // email thread
  raw?: unknown;                       // kept only in webhook_events, not on interactions
}

export interface FetchResult { records: NormalizedInteraction[]; checkpoint: Record<string, any>; hasMore: boolean }

export interface WebhookInput { headers: Record<string, string>; rawBody: string; query: Record<string, string>; method: string }
export interface WebhookResult {
  verified: boolean;
  /** For verification handshakes (e.g. Meta GET hub.challenge). */
  response?: { status: number; body: string; contentType?: string };
  events: { key: string; records: NormalizedInteraction[] }[];
}

export interface ProviderDefinition {
  id: string;
  name: string;
  category: 'conversations' | 'calls' | 'email' | 'speech_to_text' | 'ai' | 'other';
  description: string;
  docsUrl: string;
  authType: 'api_key' | 'oauth2' | 'token' | 'none';
  configFields: FieldDef[];
  secretFields: FieldDef[];
  scopes: { key: string; label: string; description: string }[];
  dataImported: string[];
  setupSteps: string[];
  supportsWebhook: boolean;
  supportsPolling: boolean;
  /** Capability notes / caveats shown to admins (e.g. "recordings only if enabled on your plan"). */
  limitations?: string[];
  testConnection(ctx: ProviderContext): Promise<TestResult>;
  fetchSince?(ctx: ProviderContext, checkpoint: Record<string, any>, opts: { from?: Date; limit?: number }): Promise<FetchResult>;
  handleWebhook?(ctx: ProviderContext, input: WebhookInput): Promise<WebhookResult>;
  oauth?: {
    authorizeUrl(ctx: ProviderContext, state: string, redirectUri: string): string;
    exchangeCode(ctx: ProviderContext, code: string, redirectUri: string): Promise<{ secrets: Record<string, string>; expiresAt?: Date | null; account?: string }>;
  };
}
