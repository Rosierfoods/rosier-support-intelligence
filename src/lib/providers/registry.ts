/**
 * Provider registry: every external service the platform can connect to.
 * New integrations (e.g. a CSAT or order-management system) are added by implementing ProviderDefinition
 * (src/lib/providers/types.ts) and listing it here — the Integrations page, webhook route, OAuth routes and
 * sync runner pick it up automatically.
 */
import type { ProviderDefinition } from './types';
import { limechatProvider } from './limechat';
import { whatsappCloudProvider } from './whatsapp-cloud';
import { myoperatorProvider } from './myoperator';
import { gmailProvider } from './gmail';
import { m365Provider } from './m365';
import { sarvamProvider } from './sarvam';
import { anthropicProvider } from './anthropic';

export const PROVIDERS: ProviderDefinition[] = [
  limechatProvider,
  whatsappCloudProvider,
  myoperatorProvider,
  gmailProvider,
  m365Provider,
  sarvamProvider,
  anthropicProvider,
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string | null | undefined): ProviderDefinition | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function isProviderId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

export const PROVIDER_GROUPS: { key: ProviderDefinition['category']; label: string; description: string }[] = [
  { key: 'conversations', label: 'Conversations', description: 'Chat and WhatsApp threads' },
  { key: 'calls', label: 'Calls', description: 'Call logs and recordings' },
  { key: 'email', label: 'Email', description: 'Support mailboxes' },
  { key: 'speech_to_text', label: 'Speech-to-text', description: 'Transcribes call recordings' },
  { key: 'ai', label: 'AI analysis', description: 'Summaries, classification and quality scoring' },
];
