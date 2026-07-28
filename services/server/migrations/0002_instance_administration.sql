ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS client_name text;

ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE pairing_requests
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE mirror_pairing_requests
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE authority_adoption_requests
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS authentication_challenges_user_idx
  ON authentication_challenges(user_id, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_created_idx
  ON audit_events(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_user_created_idx
  ON audit_events(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS operator_operations (
  operation_id uuid PRIMARY KEY,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
