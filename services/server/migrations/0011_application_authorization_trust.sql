-- mdbase:skip-if-missing-table applications
-- First-contact application trust is a clean pre-release protocol break.
-- Existing local grants cannot be authenticated retroactively, so they are
-- removed and must be approved again with a signed application authorization.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS manifest_digest text;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS application_authorization jsonb;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS first_contact jsonb;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS trust_required_at timestamptz;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS portal_approved_at timestamptz;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS approval_snapshot jsonb;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS poll_consumed_at timestamptz;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS application_authorization jsonb;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS first_contact jsonb;

DELETE FROM grants WHERE collection_id IS NOT NULL
  AND (application_authorization IS NULL OR first_contact IS NULL);

ALTER TABLE grants
  DROP CONSTRAINT IF EXISTS grants_local_application_trust_required;

ALTER TABLE grants
  ADD CONSTRAINT grants_local_application_trust_required
  CHECK (
    collection_id IS NULL
    OR (application_authorization IS NOT NULL AND first_contact IS NOT NULL)
  );
