-- Order numbers heard / typed in the conversation (verified one by one against Shopify). NULL = not scanned yet.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS order_candidates text[];

-- Founder listen list: who listened to a flagged call and when.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS founder_reviewed_at timestamptz;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS founder_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS founder_note text;
CREATE INDEX IF NOT EXISTS interactions_founder_review_idx ON interactions(org_id, occurred_at DESC) WHERE founder_reviewed_at IS NULL;

-- What MyOperator told us about the agent side of a call when no agent could be matched (name / number), for one-click mapping.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS agent_hint text;
