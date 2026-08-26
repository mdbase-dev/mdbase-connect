-- mdbase:skip-if-missing-table applications
-- Expansion phase: v6 signs the optional collaboration contract and profile
-- request. Frozen v4/v5 authorizations remain valid and collaboration-disabled.

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
      AND application_authorization->'binding'->>'protocol_version' IN ('4', '5', '6')
    )
  );

ALTER TABLE authorization_requests
  ADD CONSTRAINT authorization_requests_application_identity_required
  CHECK (
    application_authorization IS NOT NULL
    AND application_installation_id IS NOT NULL
    AND application_authorization->'binding'->>'protocol_version' IN ('4', '5', '6')
  );
