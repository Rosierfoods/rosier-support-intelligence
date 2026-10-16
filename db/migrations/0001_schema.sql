-- Rosier Support Intelligence — core schema
-- Every business table carries org_id for organisation-level isolation (enforced by RLS in 0002).
-- Internal identifiers are UUIDs; provider identifiers live in separate source_* / external_* columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION rsi_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ───────────────────────── Organisation, people, access ─────────────────────────
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  lead_user_id uuid,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin','crm_manager','team_leader','quality_analyst','support_agent')),
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  agent_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE teams ADD CONSTRAINT teams_lead_fk FOREIGN KEY (lead_user_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  email citext,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"myoperator":"<user id>","limechat":"<agent id>","email":"a@x"}
  working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_org_team_idx ON agents(org_id, team_id);
CREATE INDEX agents_external_ids_idx ON agents USING gin (external_ids);
ALTER TABLE users ADD CONSTRAINT users_agent_fk FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

CREATE TABLE role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL,
  permission text NOT NULL,
  allowed boolean NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, role, permission)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  mfa_verified boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ───────────────────────── Integrations & ingestion ─────────────────────────
CREATE TABLE integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,                    -- myoperator | limechat | whatsapp_cloud | gmail | m365 | sarvam | anthropic | ...
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected','configured','connected','error','paused')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret settings only
  secrets_enc text,                            -- AES-256-GCM encrypted JSON; never returned to the browser
  webhook_path_token text UNIQUE,              -- random path segment for the inbound webhook URL
  webhook_verified_at timestamptz,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  sync_enabled boolean NOT NULL DEFAULT false,
  sync_frequency_minutes int NOT NULL DEFAULT 30,
  historical_from date,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_message text,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  token_expires_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE integration_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('manual','schedule','webhook','historical')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  records_fetched int NOT NULL DEFAULT 0,
  records_created int NOT NULL DEFAULT 0,
  records_duplicate int NOT NULL DEFAULT 0,
  records_failed int NOT NULL DEFAULT 0,
  checkpoint_before jsonb,
  checkpoint_after jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_runs_conn_idx ON integration_sync_runs(connection_id, started_at DESC);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  provider text NOT NULL,
  event_key text NOT NULL,                    -- provider event id, or sha256 of the raw body when none is supplied
  signature_valid boolean,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb, -- sanitised (no auth headers)
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (connection_id, event_key)
);
CREATE INDEX webhook_events_org_idx ON webhook_events(org_id, received_at DESC);

-- ───────────────────────── Customers & interactions ─────────────────────────
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text,
  phone text,
  email citext,
  phone_hash text,                            -- sha256(normalised phone) for matching without exposing the number
  email_hash text,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_phone_hash_uq ON customers(org_id, phone_hash) WHERE phone_hash IS NOT NULL;
CREATE UNIQUE INDEX customers_email_hash_uq ON customers(org_id, email_hash) WHERE email_hash IS NOT NULL AND phone_hash IS NULL;

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id text,
  source text,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  subject text,
  status text NOT NULL DEFAULT 'open',
  order_ref text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, external_id)
);

CREATE TABLE interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ref text NOT NULL,                          -- human-readable interaction ID, e.g. RSI-24A9F1
  source_platform text NOT NULL,              -- myoperator | limechat | whatsapp_cloud | gmail | m365 | manual | demo
  source_record_id text NOT NULL,             -- provider's own ID; (org, platform, source id) is unique → idempotent imports
  connection_id uuid REFERENCES integration_connections(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('call','chat','whatsapp','email')),
  direction text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  ticket_id uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  ended_at timestamptz,
  subject text,
  preview text,
  processing_status text NOT NULL DEFAULT 'imported' CHECK (processing_status IN
    ('imported','transcription_pending','transcribing','analysis_pending','analyzing','completed','failed','requires_review')),
  processing_error text,
  resolution_status text NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open','pending','resolved','unresolved','escalated')),
  review_status text NOT NULL DEFAULT 'not_reviewed' CHECK (review_status IN ('not_reviewed','in_review','reviewed','corrected')),
  first_response_seconds int,
  resolution_seconds int,
  awaiting_agent_since timestamptz,           -- last unanswered customer message; used for SLA checks
  product text,
  sentiment text CHECK (sentiment IN ('positive','neutral','negative','mixed')),
  quality_score numeric(5,2),
  quality_band text,
  ai_summary text,
  customer_intent text,
  is_repeat_contact boolean NOT NULL DEFAULT false,
  reopened boolean NOT NULL DEFAULT false,
  csat smallint,
  search_text text NOT NULL DEFAULT '',
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(search_text, ''))) STORED,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source_platform, source_record_id),
  UNIQUE (org_id, ref)
);
CREATE INDEX interactions_org_time_idx ON interactions(org_id, occurred_at DESC);
CREATE INDEX interactions_agent_idx ON interactions(org_id, agent_id, occurred_at DESC);
CREATE INDEX interactions_channel_idx ON interactions(org_id, channel, occurred_at DESC);
CREATE INDEX interactions_status_idx ON interactions(org_id, processing_status);
CREATE INDEX interactions_resolution_idx ON interactions(org_id, resolution_status);
CREATE INDEX interactions_customer_idx ON interactions(org_id, customer_id, occurred_at);
CREATE INDEX interactions_search_idx ON interactions USING gin (search_tsv);
CREATE INDEX interactions_search_trgm_idx ON interactions USING gin (search_text gin_trgm_ops);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
  call_status text NOT NULL CHECK (call_status IN ('answered','missed','voicemail','failed')),
  duration_seconds int,
  ring_seconds int,
  from_number_masked text,
  to_number_masked text,
  recording_available boolean NOT NULL DEFAULT false,
  recording_source_ref text,                  -- provider recording URL / id (fetched server-side only)
  recording_storage_key text,                 -- private storage key when a copy is retained
  recording_mime text,
  language_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE call_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text,
  language text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  error text,
  attempt int NOT NULL DEFAULT 0,
  diarized boolean NOT NULL DEFAULT false,
  full_text text,
  translation_en text,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_transcripts_interaction_idx ON call_transcripts(interaction_id, is_current);

CREATE TABLE transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transcript_id uuid NOT NULL REFERENCES call_transcripts(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  speaker text NOT NULL DEFAULT 'unknown' CHECK (speaker IN ('agent','customer','unknown')),
  start_ms int NOT NULL,
  end_ms int NOT NULL,
  text text NOT NULL,
  text_en text,
  UNIQUE (transcript_id, seq)
);
CREATE INDEX transcript_segments_interaction_idx ON transcript_segments(interaction_id, seq);
CREATE INDEX transcript_segments_text_idx ON transcript_segments USING gin (to_tsvector('simple', text));

CREATE TABLE conversation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL UNIQUE REFERENCES interactions(id) ON DELETE CASCADE,
  external_thread_id text,
  status text,
  assigned_queue text,
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  external_message_id text NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('customer','agent','bot','system')),
  sender_name text,
  body text NOT NULL DEFAULT '',
  sent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, external_message_id)
);
CREATE INDEX conversation_messages_interaction_idx ON conversation_messages(interaction_id, sent_at, seq);

CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  external_message_id text NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('customer','agent','system')),
  subject text,
  from_address text,
  to_addresses text[] NOT NULL DEFAULT '{}',
  cc_addresses text[] NOT NULL DEFAULT '{}',
  sent_at timestamptz NOT NULL,
  body_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, external_message_id)
);
CREATE INDEX email_messages_interaction_idx ON email_messages(interaction_id, sent_at);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  conversation_message_id uuid REFERENCES conversation_messages(id) ON DELETE CASCADE,
  email_message_id uuid REFERENCES email_messages(id) ON DELETE CASCADE,
  file_name text,
  mime_type text,
  size_bytes bigint,
  source_ref text,
  storage_key text,
  is_retained boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_interaction_idx ON attachments(interaction_id);

CREATE TABLE customer_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid REFERENCES interactions(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  csat smallint CHECK (csat BETWEEN 1 AND 5),
  nps smallint CHECK (nps BETWEEN 0 AND 10),
  comment text,
  source text,
  received_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_feedback_interaction_idx ON customer_feedback(org_id, interaction_id);

-- ───────────────────────── Issue taxonomy ─────────────────────────
CREATE TABLE issue_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES issue_categories(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE interaction_issue_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES issue_categories(id),
  subcategory_id uuid REFERENCES issue_categories(id),
  is_primary boolean NOT NULL DEFAULT false,
  product text,
  variant text,
  customer_reason text,
  agent_reason text,
  severity text CHECK (severity IN ('critical','high','medium','low')),
  resolution_requested text,
  resolution_provided text,
  order_ref text,
  refund_amount numeric(12,2),                -- only from actual records (refund_amount_source must be set)
  refund_amount_source text,
  replacement_status text,
  escalated boolean NOT NULL DEFAULT false,
  confidence numeric(4,3),
  evidence text,
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','human')),
  is_active boolean NOT NULL DEFAULT true,     -- false when a reviewer removes an AI label (kept for audit)
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX issue_labels_interaction_idx ON interaction_issue_labels(interaction_id);
CREATE INDEX issue_labels_category_idx ON interaction_issue_labels(org_id, category_id, subcategory_id) WHERE is_active;

CREATE TABLE issue_root_causes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES interaction_issue_labels(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  cause text NOT NULL,
  status text NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected','confirmed','rejected')),
  is_ai_inference boolean NOT NULL DEFAULT true,
  evidence text,
  confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX root_causes_label_idx ON issue_root_causes(label_id);

-- ───────────────────────── Knowledge base ─────────────────────────
CREATE TABLE knowledge_base_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  current_version_id uuid,                     -- latest *published* version
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE knowledge_base_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES knowledge_base_articles(id) ON DELETE CASCADE,
  version int NOT NULL,
  body text NOT NULL,
  change_note text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);
ALTER TABLE knowledge_base_articles ADD CONSTRAINT kb_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES knowledge_base_versions(id) ON DELETE SET NULL;

-- ───────────────────────── AI analysis & quality ─────────────────────────
CREATE TABLE ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('full','coaching')),
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  kb_version_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('completed','failed')),
  output jsonb,
  error text,
  input_tokens int,
  output_tokens int,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_analyses_interaction_idx ON ai_analyses(interaction_id, is_current);

CREATE TABLE quality_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  group_code text NOT NULL,                    -- communication | understanding | accuracy | policy | resolution | closure
  channels text[] NOT NULL DEFAULT '{call,chat,whatsapp,email}',
  sort int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE quality_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  analysis_id uuid REFERENCES ai_analyses(id) ON DELETE SET NULL,
  evaluator_type text NOT NULL CHECK (evaluator_type IN ('ai','human')),
  evaluator_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  overall_score numeric(5,2),
  band text,
  criterion_scores jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{code,score(0-5)|null,na,evidence,rationale}]
  group_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  positives jsonb NOT NULL DEFAULT '[]'::jsonb,
  missed_opportunities jsonb NOT NULL DEFAULT '[]'::jsonb,
  incorrect_statements jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  frustration_indicators jsonb NOT NULL DEFAULT '[]'::jsonb,
  improved_response text,
  confidence numeric(4,3),
  policy_uncertain boolean NOT NULL DEFAULT false,
  policy_uncertainty_note text,
  rubric_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  kb_version_ids uuid[] NOT NULL DEFAULT '{}',
  notes text,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_evaluations_interaction_idx ON quality_evaluations(interaction_id, is_current);

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  min_confidence numeric(4,3) NOT NULL DEFAULT 0.6,
  channels text[] NOT NULL DEFAULT '{call,chat,whatsapp,email}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE quality_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  evaluation_id uuid REFERENCES quality_evaluations(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  rule_code text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  excerpt text NOT NULL,
  evidence_ref jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"segment_seq":4,"start_ms":51000} or {"message_external_id":"..","sent_at":".."}
  criterion_code text,
  policy_article_id uuid REFERENCES knowledge_base_articles(id) ON DELETE SET NULL,
  policy_version_id uuid REFERENCES knowledge_base_versions(id) ON DELETE SET NULL,
  confidence numeric(4,3),
  recommended_correction text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','under_review','confirmed','false_positive','coaching_assigned','resolved')),
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  escalated boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_flags_org_status_idx ON quality_flags(org_id, status, severity, created_at DESC);
CREATE INDEX quality_flags_interaction_idx ON quality_flags(interaction_id);
CREATE INDEX quality_flags_agent_idx ON quality_flags(org_id, agent_id);

CREATE TABLE reviewer_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('flag','evaluation','issue_label','root_cause','interaction')),
  target_id uuid NOT NULL,
  interaction_id uuid REFERENCES interactions(id) ON DELETE CASCADE,
  reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decision text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviewer_decisions_target_idx ON reviewer_decisions(target_type, target_id);
CREATE INDEX reviewer_decisions_interaction_idx ON reviewer_decisions(interaction_id);

-- ───────────────────────── Coaching ─────────────────────────
CREATE TABLE coaching_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  flag_id uuid REFERENCES quality_flags(id) ON DELETE SET NULL,
  interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  title text NOT NULL,
  what_went_wrong text NOT NULL,
  why_it_matters text NOT NULL,
  evidence text,
  sop_reference text,
  policy_version_id uuid REFERENCES knowledge_base_versions(id) ON DELETE SET NULL,
  better_response text,
  recommended_action text,
  exercise text,
  review_date date,
  target_metric text,                          -- e.g. criterion code or 'quality_score'
  target_value numeric(6,2),
  baseline_value numeric(6,2),
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai','manual')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','assigned','acknowledged','in_progress','completed','reviewed','cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coaching_actions_agent_idx ON coaching_actions(org_id, agent_id, status);

CREATE TABLE coaching_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  coaching_action_id uuid NOT NULL REFERENCES coaching_actions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  goal text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  agent_comment text,
  completed_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome text CHECK (outcome IN ('improved','no_change','worsened')),
  outcome_value numeric(6,2),
  outcome_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coaching_assignments_action_idx ON coaching_assignments(coaching_action_id);

-- ───────────────────────── Governance, notifications, jobs ─────────────────────────
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_time_idx ON audit_logs(org_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs(org_id, action);

CREATE TABLE notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  severity text,
  title text NOT NULL,
  body text,
  link text,
  channel text NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email')),
  read_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_events_user_idx ON notification_events(user_id, read_at, created_at DESC);

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('sync','historical_import','webhook_process','transcribe','analyze','notify','retention','sla_check')),
  interaction_id uuid REFERENCES interactions(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead','cancelled')),
  priority int NOT NULL DEFAULT 100,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_claim_idx ON processing_jobs(status, run_after, priority) WHERE status = 'queued';
CREATE UNIQUE INDEX processing_jobs_dedupe_uq ON processing_jobs(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX processing_jobs_org_idx ON processing_jobs(org_id, status, created_at DESC);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION rsi_touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;
