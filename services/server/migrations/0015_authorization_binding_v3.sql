-- mdbase:skip-if-missing-table applications
-- Authorization binding v3 signs the independent operation transport,
-- semantic capability, and durable-mutation requirements. Pending requests
-- and local grants using v2 cannot be upgraded without invalidating their
-- signatures, so revoke their credentials and mark the durable grant record
-- for reauthorization while preserving collection data and audit history.

ALTER TABLE authorization_requests
  DROP CONSTRAINT IF EXISTS authorization_requests_application_identity_required;

ALTER TABLE grants
  DROP CONSTRAINT IF EXISTS grants_local_application_authorization_required;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS reauthorization_required_at timestamptz,
  ADD COLUMN IF NOT EXISTS reauthorization_reason text;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS operation_transport_protocol integer;

UPDATE authorization_requests
SET operation_transport_protocol = relay_protocol
WHERE operation_transport_protocol IS NULL;

ALTER TABLE authorization_requests
  DROP COLUMN IF EXISTS relay_protocol;

DELETE FROM authorization_requests
WHERE application_authorization IS NULL
   OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '3';

UPDATE authorization_requests
SET application_installation_id =
  application_authorization->'binding'->>'application_installation_id';

UPDATE grants
SET application_installation_id =
  application_authorization->'binding'->>'application_installation_id'
WHERE application_authorization->'binding'->>'protocol_version' = '3';

UPDATE access_tokens
SET revoked_at = COALESCE(revoked_at, now())
WHERE grant_id IN (
  SELECT id FROM grants
  WHERE collection_id IS NOT NULL
    AND (
      application_authorization IS NULL
      OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '3'
      OR application_installation_id IS NULL
    )
);

UPDATE refresh_tokens
SET revoked_at = COALESCE(revoked_at, now())
WHERE grant_id IN (
  SELECT id FROM grants
  WHERE collection_id IS NOT NULL
    AND (
      application_authorization IS NULL
      OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '3'
      OR application_installation_id IS NULL
    )
);

UPDATE grants
SET revoked_at = COALESCE(revoked_at, now()),
    reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
    reauthorization_reason = COALESCE(
      reauthorization_reason,
      'authorization_binding_v3_required'
    )
WHERE collection_id IS NOT NULL
  AND (
    application_authorization IS NULL
    OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '3'
    OR application_installation_id IS NULL
  );

ALTER TABLE grants
  ADD CONSTRAINT grants_local_application_authorization_required
  CHECK (
    collection_id IS NULL
    OR reauthorization_required_at IS NOT NULL
    OR (
      application_authorization IS NOT NULL
      AND application_installation_id IS NOT NULL
      AND application_authorization->'binding'->>'protocol_version' = '3'
    )
  );

ALTER TABLE authorization_requests
  ADD CONSTRAINT authorization_requests_application_identity_required
  CHECK (
    application_authorization IS NOT NULL
    AND application_installation_id IS NOT NULL
    AND application_authorization->'binding'->>'protocol_version' = '3'
  );
