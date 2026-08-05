-- mdbase:skip-if-missing-table applications
-- Authorization binding v4 signs the stable application declaration id used
-- by atomic collection setup. Older proofs cannot be upgraded in place.

ALTER TABLE authorization_requests
  DROP CONSTRAINT IF EXISTS authorization_requests_application_identity_required;

ALTER TABLE grants
  DROP CONSTRAINT IF EXISTS grants_local_application_authorization_required;

DELETE FROM authorization_requests
WHERE application_authorization IS NULL
   OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '4';

UPDATE access_tokens
SET revoked_at = COALESCE(revoked_at, now())
WHERE grant_id IN (
  SELECT id FROM grants
  WHERE collection_id IS NOT NULL
    AND (
      application_authorization IS NULL
      OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '4'
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
      OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '4'
      OR application_installation_id IS NULL
    )
);

UPDATE grants
SET revoked_at = COALESCE(revoked_at, now()),
    reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
    reauthorization_reason = COALESCE(
      reauthorization_reason,
      'authorization_binding_v4_required'
    )
WHERE collection_id IS NOT NULL
  AND (
    application_authorization IS NULL
    OR COALESCE(application_authorization->'binding'->>'protocol_version', '') <> '4'
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
      AND application_authorization->'binding'->>'protocol_version' = '4'
    )
  );

ALTER TABLE authorization_requests
  ADD CONSTRAINT authorization_requests_application_identity_required
  CHECK (
    application_authorization IS NOT NULL
    AND application_installation_id IS NOT NULL
    AND application_authorization->'binding'->>'protocol_version' = '4'
  );
