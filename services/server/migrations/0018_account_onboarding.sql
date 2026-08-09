CREATE TABLE IF NOT EXISTS account_onboarding (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  starter_collection_id uuid NOT NULL UNIQUE,
  template_version text NOT NULL,
  timezone text NOT NULL,
  provisioning_started_at timestamptz,
  provisioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_onboarding_pending_idx
  ON account_onboarding (created_at)
  WHERE provisioned_at IS NULL;
