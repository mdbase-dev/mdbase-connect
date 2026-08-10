-- mdbase:skip-if-missing-table applications
-- Expansion phase: accept the frozen v4 binding used by beta55/beta56 while
-- new beta57 authorizations use v5 to sign an explicit mutation-recovery
-- transport. Existing grants and tokens remain valid.

ALTER TABLE authorization_requests
  DROP CONSTRAINT IF EXISTS authorization_requests_application_identity_required;

ALTER TABLE grants
  DROP CONSTRAINT IF EXISTS grants_local_application_authorization_required;

ALTER TABLE grants
  ADD CONSTRAINT grants_local_application_authorization_required
  CHECK (
    collection_id IS NULL
    OR reauthorization_required_at IS NOT NULL
    OR (
      application_authorization IS NOT NULL
      AND application_installation_id IS NOT NULL
      AND application_authorization->'binding'->>'protocol_version' IN ('4', '5')
    )
  );

ALTER TABLE authorization_requests
  ADD CONSTRAINT authorization_requests_application_identity_required
  CHECK (
    application_authorization IS NOT NULL
    AND application_installation_id IS NOT NULL
    AND application_authorization->'binding'->>'protocol_version' IN ('4', '5')
  );
