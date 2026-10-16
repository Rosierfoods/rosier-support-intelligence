import { Mail, MessageCircle, MessagesSquare, Phone } from 'lucide-react';
import { Badge, type Tone } from './ui';
import { CHANNEL_LABELS, FLAG_STATUS_LABELS, PLATFORM_LABELS, PROCESSING_LABELS, type FlagStatus } from '@/lib/constants';
import { titleCase } from '@/lib/format';

export function SeverityBadge({ severity }: { severity: string }) {
  const tone: Tone = severity === 'critical' ? 'bad' : severity === 'high' ? 'warn' : severity === 'medium' ? 'neutral' : 'muted';
  return <Badge tone={tone} className={severity === 'critical' ? 'font-semibold' : undefined}>{titleCase(severity)}</Badge>;
}

export function FlagStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === 'new' ? 'brand' : status === 'under_review' ? 'info' : status === 'confirmed' ? 'warn'
    : status === 'false_positive' ? 'muted' : status === 'coaching_assigned' ? 'neutral' : 'good';
  return <Badge tone={tone}>{FLAG_STATUS_LABELS[status as FlagStatus] ?? titleCase(status)}</Badge>;
}

export function ProcessingBadge({ status }: { status: string }) {
  const tone: Tone = status === 'completed' ? 'good' : status === 'failed' ? 'bad' : status === 'requires_review' ? 'warn' : 'info';
  return <Badge tone={tone}>{PROCESSING_LABELS[status] ?? titleCase(status)}</Badge>;
}

export function ResolutionBadge({ status }: { status: string }) {
  const tone: Tone = status === 'resolved' ? 'good' : status === 'escalated' ? 'warn' : status === 'unresolved' ? 'bad' : 'neutral';
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

export function ReviewBadge({ status }: { status: string }) {
  const tone: Tone = status === 'reviewed' ? 'good' : status === 'corrected' ? 'info' : status === 'in_review' ? 'brand' : 'muted';
  return <Badge tone={tone}>{titleCase(status)}</Badge>;
}

export function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return <span className="text-ink-faint">—</span>;
  const tone: Tone = sentiment === 'positive' ? 'good' : sentiment === 'negative' ? 'bad' : sentiment === 'mixed' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{titleCase(sentiment)}</Badge>;
}

export function ScoreBadge({ score, band }: { score: number | string | null; band?: string | null }) {
  if (score === null || score === undefined) return <span className="text-ink-faint">—</span>;
  const n = Number(score);
  const tone: Tone = n >= 80 ? 'good' : n >= 70 ? 'warn' : 'bad';
  return <Badge tone={tone} title={band ?? undefined}><span className="tabular-nums">{Math.round(n)}</span></Badge>;
}

export function ChannelBadge({ channel, platform }: { channel: string; platform?: string }) {
  const Icon = channel === 'call' ? Phone : channel === 'email' ? Mail : channel === 'whatsapp' ? MessageCircle : MessagesSquare;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink" title={platform ? PLATFORM_LABELS[platform] ?? platform : undefined}>
      <Icon size={14} className="text-brand-500" />
      {CHANNEL_LABELS[channel as keyof typeof CHANNEL_LABELS] ?? channel}
    </span>
  );
}
