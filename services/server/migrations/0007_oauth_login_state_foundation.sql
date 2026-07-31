-- mdbase:skip-if-table oauth_login_states
-- Compatibility foundation for installations upgrading directly from beta.8,
-- before OAuth login state was part of the frozen legacy baseline.

CREATE TABLE oauth_login_states (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  state_hash text NOT NULL UNIQUE,
  return_to text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
