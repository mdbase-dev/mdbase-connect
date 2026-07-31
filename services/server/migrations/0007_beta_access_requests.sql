CREATE TABLE IF NOT EXISTS beta_access_requests (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  normalized_email text NOT NULL UNIQUE,
  email_normalization_version integer NOT NULL DEFAULT 1,
  invitation_id uuid REFERENCES invitations(id) ON DELETE SET NULL,
  invited_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email_normalization_version = 1),
  CHECK (invitation_id IS NULL OR invited_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS beta_access_requests_requested_idx
  ON beta_access_requests(requested_at DESC, id DESC);
