-- OAuth authorisation state for Gmail / Microsoft 365 "Connect" flows.
-- Single use, expires after 10 minutes; only the SHA-256 of the state value is stored.
CREATE TABLE oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  redirect_uri text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);

ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON oauth_states TO rsi_app USING (org_id = rsi_current_org()) WITH CHECK (org_id = rsi_current_org());
DO $$ BEGIN
  EXECUTE format('CREATE POLICY owner_all ON oauth_states TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_states TO rsi_app;
