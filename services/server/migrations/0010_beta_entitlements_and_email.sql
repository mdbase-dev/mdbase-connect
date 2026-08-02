CREATE TABLE entitlement_profiles (
  code text PRIMARY KEY,
  hosted_storage_bytes bigint NOT NULL CHECK (hosted_storage_bytes > 0),
  retained_file_bytes bigint NOT NULL CHECK (retained_file_bytes >= hosted_storage_bytes),
  max_document_bytes bigint NOT NULL CHECK (max_document_bytes > 0),
  max_single_file_bytes bigint NOT NULL CHECK (max_single_file_bytes > 0),
  max_replicas_per_collection bigint NOT NULL CHECK (max_replicas_per_collection > 0),
  max_hosted_collections bigint NOT NULL CHECK (max_hosted_collections > 0),
  max_files_per_collection bigint NOT NULL CHECK (max_files_per_collection > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO entitlement_profiles
  (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
   max_single_file_bytes, max_replicas_per_collection,
   max_hosted_collections, max_files_per_collection)
VALUES
  ('beta_v1', 1073741824, 2147483648, 2097152, 262144000, 10, 10, 10000);

CREATE TABLE invitation_entitlements (
  invitation_id uuid PRIMARY KEY REFERENCES invitations(id) ON DELETE CASCADE,
  profile_code text NOT NULL REFERENCES entitlement_profiles(code),
  assigned_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_entitlement_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_code text NOT NULL REFERENCES entitlement_profiles(code),
  source text NOT NULL CHECK (source IN ('invitation', 'operator', 'subscription')),
  source_reference text,
  source_invitation_id uuid REFERENCES invitations(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (
    (source = 'invitation' AND source_invitation_id IS NOT NULL)
    OR source <> 'invitation'
  )
);

CREATE UNIQUE INDEX account_entitlement_grants_invitation_idx
  ON account_entitlement_grants(source_invitation_id)
  WHERE source_invitation_id IS NOT NULL;

CREATE UNIQUE INDEX account_entitlement_grants_source_reference_idx
  ON account_entitlement_grants(user_id, source, source_reference)
  WHERE source_reference IS NOT NULL;

CREATE INDEX account_entitlement_grants_active_idx
  ON account_entitlement_grants(user_id, starts_at, ends_at)
  WHERE revoked_at IS NULL;

CREATE TABLE account_storage_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_account_id uuid NOT NULL UNIQUE,
  entitlement_revision bigint NOT NULL DEFAULT 1 CHECK (entitlement_revision > 0),
  provider_revision bigint NOT NULL DEFAULT 0 CHECK (provider_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider_revision <= entitlement_revision)
);

CREATE TABLE account_email_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  onboarding_enabled boolean NOT NULL DEFAULT true,
  product_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Accounts that predate the Beta invitation flow are themselves early Beta
-- users. Preserve that status explicitly so hosted storage never falls back to
-- an implicit, unmetered tier during rollout.
INSERT INTO account_entitlement_grants
  (id, user_id, profile_code, source, source_reference)
SELECT account.id, account.id, 'beta_v1', 'operator', 'beta_v1_existing_account'
FROM users account
ON CONFLICT DO NOTHING;

INSERT INTO account_storage_accounts (user_id, provider_account_id)
SELECT account.id, account.id
FROM users account
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO account_email_preferences (user_id)
SELECT account.id
FROM users account
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE email_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_identity_id uuid NOT NULL REFERENCES email_identities(id) ON DELETE CASCADE,
  message_kind text NOT NULL,
  template_version integer NOT NULL CHECK (template_version > 0),
  category text NOT NULL CHECK (category IN ('essential', 'onboarding', 'product')),
  deduplication_key text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled', 'sending', 'accepted', 'delivered', 'failed', 'cancelled', 'uncertain')),
  scheduled_for timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider text,
  provider_message_id text,
  last_error_code text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  last_provider_event_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((provider IS NULL) = (provider_message_id IS NULL)),
  CHECK (next_attempt_at >= scheduled_for)
);

CREATE INDEX email_jobs_due_idx
  ON email_jobs(next_attempt_at, id)
  WHERE state IN ('scheduled', 'sending');

CREATE TABLE email_delivery_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES email_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (state IN ('started', 'accepted', 'failed', 'uncertain')),
  provider text,
  provider_message_id text,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(job_id, attempt_number)
);

CREATE TABLE email_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  provider_message_id text NOT NULL,
  event_type text NOT NULL,
  event_created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, event_id)
);

CREATE INDEX email_provider_events_message_idx
  ON email_provider_events(provider, provider_message_id, event_created_at);

CREATE TABLE email_suppressions (
  email_identity_id uuid PRIMARY KEY REFERENCES email_identities(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'operator')),
  source_event_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
