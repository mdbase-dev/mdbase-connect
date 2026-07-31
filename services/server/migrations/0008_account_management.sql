ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';

ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS account_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE oauth_login_states
  ADD COLUMN IF NOT EXISTS account_session_id uuid REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE oauth_login_states
  DROP CONSTRAINT IF EXISTS oauth_login_states_account_flow_check;

ALTER TABLE oauth_login_states
  ADD CONSTRAINT oauth_login_states_account_flow_check CHECK (
    (purpose = 'login' AND account_user_id IS NULL AND account_session_id IS NULL)
    OR
    (purpose IN ('link', 'reauth_delete') AND account_user_id IS NOT NULL AND account_session_id IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS account_action_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('delete_account')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_action_tokens_active_idx
  ON account_action_tokens(user_id, session_id, purpose, expires_at)
  WHERE consumed_at IS NULL;
