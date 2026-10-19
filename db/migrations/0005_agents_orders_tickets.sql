-- Agent phone matching, order matching (AI + Shopify) and auto-created support tickets.

-- Agents are matched to calls by their own mobile number(s) (normalised digits, e.g. 919812345678).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS phone_numbers text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS agents_phone_numbers_idx ON agents USING gin (phone_numbers);

-- The agent-side number of a call (normalised), so agents can be re-matched after numbers are added.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_phone text;
CREATE INDEX IF NOT EXISTS calls_agent_phone_idx ON calls(org_id, agent_phone) WHERE agent_phone IS NOT NULL;

-- Order linked to an interaction. order_source: 'ai' (mentioned in the conversation), 'shopify' (customer's order found by phone),
-- 'manual'. order_verified = confirmed to exist in Shopify.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS order_ref text;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS order_source text;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS order_verified boolean NOT NULL DEFAULT false;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS order_details jsonb;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS order_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS interactions_order_ref_idx ON interactions(org_id, order_ref) WHERE order_ref IS NOT NULL;

-- Tickets created automatically from each analysed call / chat / email.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS interaction_id uuid REFERENCES interactions(id) ON DELETE CASCADE;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS problem text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS action_taken text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_type text;      -- refund | replacement | information | escalated | other | none
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS auto_created boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_interaction_uq ON support_tickets(interaction_id) WHERE interaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_tickets_org_opened_idx ON support_tickets(org_id, opened_at DESC);
