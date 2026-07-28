-- Compatibility foundation for installations upgrading directly from beta.8
-- or another pre-password-authentication release. The filename intentionally
-- orders this after collaboration foundations and before instance administration.
-- mdbase:skip-if-table authentication_settings

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_epoch bigint;

UPDATE users
SET session_epoch = 1
WHERE session_epoch IS NULL;

ALTER TABLE users
  ALTER COLUMN session_epoch SET DEFAULT 1;

ALTER TABLE users
  ALTER COLUMN session_epoch SET NOT NULL;

ALTER TABLE external_identities
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

ALTER TABLE external_identities
  ADD COLUMN IF NOT EXISTS normalized_email text;

ALTER TABLE external_identities
  ADD COLUMN IF NOT EXISTS email_normalization_version integer;

-- Version 1 normalization lower-cases both parts and trims the address. SQL can
-- reproduce it safely for legacy ASCII addresses; non-ASCII addresses remain
-- unlinked until their identity provider next verifies them in application code.
UPDATE external_identities
SET normalized_email = lower(email),
    email_normalization_version = 1
WHERE email_verified = true
  AND email IS NOT NULL
  AND COALESCE(normalized_email, '') = ''
  AND email LIKE '_%@_%'
  AND email NOT LIKE '% %';

CREATE INDEX IF NOT EXISTS external_identities_verified_email_idx
  ON external_identities(normalized_email)
  WHERE email_verified = true AND normalized_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  normalized_email text NOT NULL,
  normalization_version integer NOT NULL DEFAULT 1,
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_identities_active_email_idx
  ON email_identities(normalized_email) WHERE retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS email_identities_primary_user_idx
  ON email_identities(user_id) WHERE is_primary = true AND retired_at IS NULL;

CREATE INDEX IF NOT EXISTS email_identities_user_idx
  ON email_identities(user_id);

CREATE TABLE IF NOT EXISTS password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  credential_version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_agreements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document text NOT NULL,
  version text NOT NULL,
  acceptance_method text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, document, version)
);

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  normalized_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  terms_version text,
  privacy_version text,
  expires_at timestamptz NOT NULL,
  accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  send_count integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_active_email_idx
  ON invitations(normalized_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invitations_expiry_idx
  ON invitations(expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS authentication_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  normalized_email text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  invitation_id uuid REFERENCES invitations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS authentication_challenges_active_email_idx
  ON authentication_challenges(purpose, normalized_email)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS authentication_challenges_expiry_idx
  ON authentication_challenges(expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_rate_limit_buckets (
  scope text NOT NULL,
  key_digest text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope, key_digest),
  CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS auth_rate_limit_buckets_updated_idx
  ON auth_rate_limit_buckets(updated_at);

CREATE TABLE IF NOT EXISTS authentication_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  registration_mode text NOT NULL
    CHECK (registration_mode IN ('closed', 'invite', 'open')),
  password_auth_enabled boolean NOT NULL DEFAULT false,
  email_delivery_enabled boolean NOT NULL DEFAULT false,
  terms_version text,
  privacy_version text,
  revision bigint NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  update_reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authentication_settings_history (
  revision bigint PRIMARY KEY,
  registration_mode text NOT NULL
    CHECK (registration_mode IN ('closed', 'invite', 'open')),
  password_auth_enabled boolean NOT NULL,
  email_delivery_enabled boolean NOT NULL,
  terms_version text,
  privacy_version text,
  updated_by text NOT NULL,
  update_reason text NOT NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS account_session_epoch bigint;

UPDATE sessions
SET account_session_epoch = 1
WHERE account_session_epoch IS NULL;

ALTER TABLE sessions
  ALTER COLUMN account_session_epoch SET DEFAULT 1;

ALTER TABLE sessions
  ALTER COLUMN account_session_epoch SET NOT NULL;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

UPDATE sessions
SET last_seen_at = created_at
WHERE last_seen_at IS NULL;

ALTER TABLE sessions
  ALTER COLUMN last_seen_at SET DEFAULT now();

ALTER TABLE sessions
  ALTER COLUMN last_seen_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS authority_adoption_requests (
  id uuid PRIMARY KEY,
  secret_hash text NOT NULL UNIQUE,
  collection_id uuid NOT NULL,
  display_name text NOT NULL,
  source_name text NOT NULL,
  retain_mirror boolean NOT NULL DEFAULT true,
  mirror_name text,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN (
      'requested', 'approved', 'prepared', 'activating', 'completed',
      'cancelled', 'expired'
    )),
  next_authority_epoch bigint NOT NULL DEFAULT 2,
  final_head bigint,
  manifest_digest text,
  source_revision text,
  contracts jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  prepared_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cleanup_completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS authority_adoption_requests_collection_idx
  ON authority_adoption_requests(collection_id, state);
