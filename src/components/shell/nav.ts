import type { Permission } from '@/lib/auth/rbac';

export interface NavItem { href: string; label: string; icon: string; perm?: Permission; anyPerm?: Permission[]; group: string; agentLabel?: string }

export const NAV: NavItem[] = [
  { group: 'Monitor', href: '/', label: 'Overview Dashboard', icon: 'LayoutDashboard', perm: 'dashboard.view' },
  { group: 'Monitor', href: '/inbox', label: 'Unified Inbox', icon: 'Inbox', perm: 'interactions.view' },
  { group: 'Monitor', href: '/calls', label: 'Calls & Transcriptions', icon: 'Phone', perm: 'interactions.view' },
  { group: 'Monitor', href: '/chats', label: 'Chat & WhatsApp', icon: 'MessageCircle', perm: 'interactions.view' },
  { group: 'Monitor', href: '/emails', label: 'Email Conversations', icon: 'Mail', perm: 'interactions.view' },
  { group: 'Quality', href: '/quality', label: 'AI Quality Monitoring', icon: 'ShieldAlert', perm: 'flags.review' },
  { group: 'Quality', href: '/issues', label: 'Customer Issues & Root Causes', icon: 'PieChart', perm: 'reports.view' },
  { group: 'Quality', href: '/agents', label: 'Agent Performance', icon: 'Users', anyPerm: ['reports.view'], agentLabel: 'My Performance' },
  { group: 'Quality', href: '/coaching', label: 'Coaching & Improvement', icon: 'GraduationCap', perm: 'interactions.view', agentLabel: 'My Coaching' },
  { group: 'Quality', href: '/reports', label: 'Reports & Analytics', icon: 'FileBarChart', perm: 'reports.view' },
  { group: 'Configure', href: '/integrations', label: 'Integrations & API Settings', icon: 'Plug', perm: 'integrations.manage' },
  { group: 'Configure', href: '/ai-config', label: 'AI Configuration', icon: 'Sparkles', perm: 'ai_config.manage' },
  { group: 'Configure', href: '/knowledge-base', label: 'Knowledge Base', icon: 'BookOpen', perm: 'kb.view' },
  { group: 'Configure', href: '/team', label: 'Team Management', icon: 'UserCog', perm: 'team.manage' },
  { group: 'Configure', href: '/audit', label: 'Audit Logs & Security', icon: 'ScrollText', perm: 'audit.view' },
  { group: 'Configure', href: '/settings', label: 'System Settings', icon: 'Settings', perm: 'settings.manage' },
];
