-- mdbase:skip-if-missing-table applications
-- Replace the unreleased first-contact ceremony with signed application
-- identity. Protocol-v1 local grants cannot be authenticated by the new
-- connector and are deliberately invalidated; hosted grants remain available
-- for one-time adoption by the first v2 authorization from that application.

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS application_installation_id text;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS application_installation_id text;

DELETE FROM authorization_requests
WHERE application_authorization IS NULL
   OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '2'
   OR COALESCE(
        application_authorization->'binding'->>'application_installation_id',
        ''
      ) = '';

UPDATE authorization_requests
SET application_installation_id =
  application_authorization->'binding'->>'application_installation_id';

UPDATE grants
SET application_installation_id =
  application_authorization->'binding'->>'application_installation_id'
WHERE application_authorization->'binding'->>'protocol_version' = '2'
  AND COALESCE(
        application_authorization->'binding'->>'application_installation_id',
        ''
      ) <> '';

DELETE FROM grants
WHERE collection_id IS NOT NULL
  AND (
    application_authorization IS NULL
    OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '2'
    OR application_installation_id IS NULL
  );

ALTER TABLE grants
  DROP CONSTRAINT IF EXISTS grants_local_application_trust_required;

ALTER TABLE grants
  ADD CONSTRAINT grants_local_application_authorization_required
  CHECK (
    collection_id IS NULL
    OR (
      application_authorization IS NOT NULL
      AND application_installation_id IS NOT NULL
      AND application_authorization->'binding'->>'protocol_version' = '2'
    )
  );

ALTER TABLE authorization_requests
  ADD CONSTRAINT authorization_requests_application_identity_required
  CHECK (
    application_authorization IS NOT NULL
    AND application_installation_id IS NOT NULL
    AND application_authorization->'binding'->>'protocol_version' = '2'
  );

CREATE UNIQUE INDEX IF NOT EXISTS grants_active_hosted_application_installation_idx
  ON grants(user_id, application_id, application_installation_id, hosted_collection_id)
  WHERE hosted_collection_id IS NOT NULL
    AND application_installation_id IS NOT NULL
    AND revoked_at IS NULL;

ALTER TABLE authorization_requests
  DROP COLUMN IF EXISTS first_contact,
  DROP COLUMN IF EXISTS trust_required_at,
  DROP COLUMN IF EXISTS portal_approved_at,
  DROP COLUMN IF EXISTS approval_snapshot,
  DROP COLUMN IF EXISTS poll_consumed_at;

ALTER TABLE grants
  DROP COLUMN IF EXISTS first_contact;
