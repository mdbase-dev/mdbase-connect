-- Provider proof is short-lived and is not an account or a session. Never
-- persist provider access tokens or raw Google credentials at this boundary.
CREATE TABLE IF NOT EXISTS external_signup_challenges (
  token_hash text PRIMARY KEY,
  identity jsonb NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS external_signup_challenges_expiry_idx
  ON external_signup_challenges(expires_at);
