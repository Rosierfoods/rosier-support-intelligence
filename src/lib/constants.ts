// Shared catalogues: roles, channels, statuses, default taxonomy, rubric and alert rules.
// Defaults are seeded into each organisation and are editable from AI Configuration.

export const ROLES = ['super_admin', 'crm_manager', 'team_leader', 'quality_analyst', 'support_agent'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  crm_manager: 'CRM Manager',
  team_leader: 'Team Leader',
  quality_analyst: 'Quality Analyst',
  support_agent: 'Support Agent',
};

export const CHANNELS = ['call', 'chat', 'whatsapp', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Record<Channel, string> = { call: 'Call', chat: 'Chat', whatsapp: 'WhatsApp', email: 'Email' };

export const PLATFORM_LABELS: Record<string, string> = {
  myoperator: 'MyOperator',
  limechat: 'LimeChat',
  whatsapp_cloud: 'WhatsApp Cloud API',
  gmail: 'Gmail',
  m365: 'Microsoft 365',
  manual: 'Manual',
  demo: 'Demo',
};

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PROCESSING_STATUSES = [
  'imported', 'transcription_pending', 'transcribing', 'analysis_pending', 'analyzing', 'completed', 'failed', 'requires_review',
] as const;
export const PROCESSING_LABELS: Record<string, string> = {
  imported: 'Imported', transcription_pending: 'Transcription pending', transcribing: 'Transcribing',
  analysis_pending: 'Analysis pending', analyzing: 'Analyzing', completed: 'Completed', failed: 'Failed', requires_review: 'Requires review',
};

export const RESOLUTION_STATUSES = ['open', 'pending', 'resolved', 'unresolved', 'escalated'] as const;
export const REVIEW_STATUSES = ['not_reviewed', 'in_review', 'reviewed', 'corrected'] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;

export const FLAG_STATUSES = ['new', 'under_review', 'confirmed', 'false_positive', 'coaching_assigned', 'resolved'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];
export const FLAG_STATUS_LABELS: Record<FlagStatus, string> = {
  new: 'New', under_review: 'Under review', confirmed: 'Confirmed', false_positive: 'False positive',
  coaching_assigned: 'Coaching assigned', resolved: 'Resolved',
};
export const OPEN_FLAG_STATUSES: FlagStatus[] = ['new', 'under_review', 'confirmed'];

export const COACHING_STATUSES = ['draft', 'assigned', 'acknowledged', 'in_progress', 'completed', 'reviewed', 'cancelled'] as const;

export const PRODUCTS = [
  'A2 Desi Ghee', 'Cow Ghee', 'Wild Forest Honey', 'Khapli Atta', 'Cold Pressed Mustard Oil', 'Cold Pressed Groundnut Oil',
  'Mango Pickle', 'Mixed Pickle', 'High Protein Oats', 'Peanut Butter', 'Protein Bar', 'Amlaprash', 'Paneer',
] as const;

// ───────────── Default issue taxonomy (spec §11) ─────────────
export const DEFAULT_TAXONOMY: { code: string; name: string; subs: [string, string][] }[] = [
  { code: 'refund', name: 'Refund', subs: [
    ['requested', 'Refund requested'], ['eligibility', 'Refund eligibility question'], ['delayed', 'Refund delayed'],
    ['not_received', 'Refund not received'], ['partial_dispute', 'Partial refund dispute'], ['status', 'Refund status inquiry'],
    ['policy_confusion', 'Refund policy confusion'] ] },
  { code: 'replacement', name: 'Replacement', subs: [
    ['requested', 'Replacement requested'], ['damaged', 'Damaged product'], ['wrong_product', 'Wrong product received'],
    ['missing_item', 'Missing item'], ['expired', 'Expired or near-expiry product'], ['wrong_quantity', 'Incorrect quantity'],
    ['delayed', 'Replacement delayed'], ['eligibility', 'Replacement eligibility inquiry'] ] },
  { code: 'quality', name: 'Product Quality', subs: [
    ['ghee_leak', 'Ghee jar leaking'], ['ghee_broken', 'Broken or cracked ghee jar'], ['ghee_texture', 'Ghee texture or consistency concern'],
    ['ghee_smell_taste', 'Ghee smell or taste concern'], ['oil_leak', 'Oil leakage'], ['oil_quality', 'Oil quality complaint'],
    ['atta_quality', 'Atta quality concern'], ['honey_quality', 'Honey quality concern'], ['pickle_quality', 'Pickle quality concern'],
    ['packaging_damage', 'Packaging damage'], ['authenticity', 'Product authenticity or quality question'] ] },
  { code: 'delivery', name: 'Delivery', subs: [
    ['delayed', 'Order delayed'], ['not_delivered', 'Order not delivered'], ['tracking_wrong', 'Incorrect tracking information'],
    ['partner_issue', 'Delivery partner issue'], ['wrong_address', 'Incorrect delivery address'], ['partial', 'Partial delivery'],
    ['status', 'Delivery status inquiry'] ] },
  { code: 'order_payment', name: 'Order & Payment', subs: [
    ['cancellation', 'Order cancellation'], ['modification', 'Order modification'], ['payment_failed', 'Payment failed'],
    ['duplicate_payment', 'Duplicate payment'], ['cod', 'COD issue'], ['invoice', 'Invoice request'],
    ['no_confirmation', 'Missing order confirmation'] ] },
  { code: 'product_info', name: 'Product Information', subs: [
    ['ingredients', 'Ingredients inquiry'], ['usage', 'Product usage question'], ['shelf_life', 'Shelf-life inquiry'],
    ['storage', 'Storage instructions'], ['availability', 'Product availability'], ['pricing', 'Pricing inquiry'],
    ['promotion', 'Discount or promotion inquiry'], ['comparison', 'Product comparison'] ] },
  { code: 'website_cx', name: 'Website & Customer Experience', subs: [
    ['website', 'Website issue'], ['checkout', 'Checkout failure'], ['login', 'Login issue'], ['coupon', 'Coupon issue'],
    ['loyalty', 'Membership or loyalty question'], ['prior_support', 'Complaint about previous support'] ] },
  { code: 'other', name: 'Other', subs: [
    ['feedback', 'General feedback'], ['appreciation', 'Appreciation'], ['suggestion', 'Suggestion'], ['unclassified', 'Unclassified issue'] ] },
];

// ───────────── Default quality rubric (spec §9) ─────────────
export const RUBRIC_GROUPS = ['communication', 'understanding', 'accuracy', 'policy', 'resolution', 'closure'] as const;
export type RubricGroup = (typeof RUBRIC_GROUPS)[number];
export const RUBRIC_GROUP_LABELS: Record<RubricGroup, string> = {
  communication: 'Communication & empathy',
  understanding: 'Problem understanding',
  accuracy: 'Information accuracy',
  policy: 'Policy compliance',
  resolution: 'Resolution & ownership',
  closure: 'Closure & clarity',
};
export const DEFAULT_GROUP_WEIGHTS: Record<RubricGroup, number> = {
  communication: 20, understanding: 15, accuracy: 20, policy: 20, resolution: 15, closure: 10,
};

export const DEFAULT_CRITERIA: { code: string; name: string; group: RubricGroup; description: string; channels?: Channel[] }[] = [
  { code: 'greeting', name: 'Greeting & introduction', group: 'communication', description: 'Greets the customer and introduces self / Rosier Foods professionally.' },
  { code: 'empathy', name: 'Politeness & empathy', group: 'communication', description: 'Respectful language; acknowledges the inconvenience or feeling expressed.' },
  { code: 'understanding', name: 'Understanding the problem', group: 'understanding', description: 'Identifies the actual issue, asks clarifying questions, does not answer a different question.' },
  { code: 'accuracy', name: 'Accuracy of information', group: 'accuracy', description: 'Statements are factually correct and consistent with the order/case facts.' },
  { code: 'product_policy_info', name: 'Correct product & policy information', group: 'accuracy', description: 'Product claims and policy statements match approved knowledge-base articles.' },
  { code: 'troubleshooting', name: 'Troubleshooting quality', group: 'resolution', description: 'Gathers the right details and works toward a fix in a sensible order.' },
  { code: 'refund_replacement', name: 'Refund / replacement guidance', group: 'policy', description: 'Guidance follows the approved refund and replacement SOP; no unapproved promises.' },
  { code: 'next_steps', name: 'Clear next steps', group: 'closure', description: 'Customer knows what happens next, who acts, and a realistic timeline.' },
  { code: 'escalation', name: 'Proper escalation', group: 'policy', description: 'Escalates when the SOP requires it, to the right team, and tells the customer.' },
  { code: 'closure', name: 'Conversation closure', group: 'closure', description: 'Confirms the customer has nothing else, closes politely.' },
  { code: 'sop_compliance', name: 'SOP compliance', group: 'policy', description: 'Follows internal procedures (verification, documentation, tagging).' },
  { code: 'privacy', name: 'Data privacy', group: 'policy', description: 'Does not request or expose unnecessary personal or payment data.' },
  { code: 'resolution', name: 'Resolution & satisfaction', group: 'resolution', description: 'Issue resolved or properly owned; customer leaves with a clear outcome.' },
];

export const DEFAULT_SCORE_BANDS = [
  { min: 90, label: 'Excellent', tone: 'good' },
  { min: 80, label: 'Good', tone: 'good' },
  { min: 70, label: 'Needs improvement', tone: 'warn' },
  { min: 0, label: 'Requires review', tone: 'bad' },
] as const;

// ───────────── Default alert rules (spec §10) ─────────────
export const DEFAULT_ALERT_RULES: { code: string; name: string; severity: Severity; description: string; min_confidence?: number }[] = [
  { code: 'unauthorized_refund_promise', severity: 'critical', name: 'Possible unauthorized refund promise', description: 'Agent commits to a refund, amount or timeline not permitted by the approved refund SOP.', min_confidence: 0.7 },
  { code: 'sensitive_data_exposure', severity: 'critical', name: 'Potential exposure of sensitive customer data', description: 'Agent asks for or reveals OTPs, full card/UPI details, passwords, or another customer’s data.', min_confidence: 0.7 },
  { code: 'abusive_language', severity: 'critical', name: 'Serious abusive or threatening language', description: 'Agent uses abusive, threatening or demeaning language.', min_confidence: 0.75 },
  { code: 'major_policy_violation', severity: 'critical', name: 'High-confidence major policy violation', description: 'Clear breach of a published SOP with material customer or business impact.', min_confidence: 0.85 },
  { code: 'repeated_critical_failures', severity: 'critical', name: 'Repeated critical service failures', description: 'The same agent has multiple confirmed critical issues in the review window.' },
  { code: 'incorrect_refund_replacement_info', severity: 'high', name: 'Incorrect refund or replacement information', description: 'Eligibility, process or timeline stated differently from the SOP.' },
  { code: 'unprofessional_behavior', severity: 'high', name: 'Unprofessional agent behavior', description: 'Rude, dismissive, sarcastic or blaming tone toward the customer.' },
  { code: 'sla_unresolved', severity: 'high', name: 'Complaint unresolved beyond SLA', description: 'Customer is still waiting past the configured SLA, excluding non-business hours.' },
  { code: 'false_product_info', severity: 'high', name: 'Potentially false product information', description: 'Product claim (ingredients, shelf life, health benefit) not supported by approved claims.' },
  { code: 'issue_not_acknowledged', severity: 'high', name: 'Repeated failure to acknowledge the issue', description: 'Customer restates the problem two or more times without acknowledgment.' },
  { code: 'missing_follow_up', severity: 'medium', name: 'Missing follow-up commitment', description: 'Agent says they will check but gives no follow-up time or owner.' },
  { code: 'scripted_non_answer', severity: 'medium', name: 'Scripted answers that miss the question', description: 'Repeated template replies that do not address what the customer asked.' },
  { code: 'excessive_delay', severity: 'medium', name: 'Excessive response delays', description: 'Agent response gaps exceed the SLA within business hours.' },
  { code: 'incomplete_resolution', severity: 'medium', name: 'Poor explanation or incomplete resolution', description: 'Conversation ends without a clear outcome or explanation.' },
  { code: 'greeting_closing', severity: 'low', name: 'Minor greeting or closing issue', description: 'Missing greeting, introduction or closing.' },
  { code: 'clarity_empathy', severity: 'low', name: 'Opportunity to improve clarity or empathy', description: 'Correct but could be clearer or warmer.' },
];

export const DEFAULT_ORG_SETTINGS = {
  timezone: 'Asia/Kolkata',
  businessHours: { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' },
  sla: { firstResponseMinutes: { chat: 15, whatsapp: 15, email: 240, call: 1 }, resolutionHours: 48 },
  scoreBands: DEFAULT_SCORE_BANDS,
  reviewThreshold: 70,
  rubric: { default: DEFAULT_GROUP_WEIGHTS, overrides: {} as Partial<Record<Channel, Partial<Record<RubricGroup, number>>>> },
  retention: { recordingsDays: 90, transcriptsDays: 365, messagesDays: 365, piiDays: 365, auditDays: 730 },
  repeatContactWindowDays: 7,
  ai: { autoAnalyze: true, translateToEnglish: true, minConfidenceForAlert: 0.6 },
  notifications: { emailCritical: false },
};
export type OrgSettings = typeof DEFAULT_ORG_SETTINGS;

export const KB_DEFAULT_ARTICLES: { slug: string; title: string; category: string }[] = [
  { slug: 'refund-policy', title: 'Refund policy', category: 'Policy' },
  { slug: 'replacement-policy', title: 'Replacement policy', category: 'Policy' },
  { slug: 'damaged-product-handling', title: 'Damaged-product handling', category: 'Procedure' },
  { slug: 'ghee-jar-leakage', title: 'Ghee jar leakage procedure', category: 'Procedure' },
  { slug: 'missing-incorrect-items', title: 'Missing or incorrect items', category: 'Procedure' },
  { slug: 'delivery-delays', title: 'Delivery delays', category: 'Procedure' },
  { slug: 'storage-shelf-life', title: 'Product storage and shelf life', category: 'Product' },
  { slug: 'approved-claims', title: 'Product information and approved claims', category: 'Product' },
  { slug: 'order-tracking', title: 'Order tracking', category: 'Procedure' },
  { slug: 'escalation-rules', title: 'Escalation rules', category: 'Policy' },
  { slug: 'communication-standards', title: 'Customer communication standards', category: 'Standard' },
  { slug: 'response-templates', title: 'Approved response templates', category: 'Templates' },
  { slug: 'privacy-data-handling', title: 'Privacy and customer-data handling', category: 'Policy' },
];
