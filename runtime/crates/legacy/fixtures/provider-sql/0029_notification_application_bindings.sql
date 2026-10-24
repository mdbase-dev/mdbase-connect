-- Beta.33 binds newly approved grants to their exact application declaration.
-- Notification grants persisted by earlier betas predate that identity. They
-- must remain executable after upgrade, but the missing values must not be
-- mistaken for a current declaration or acquire application-setup authority.
-- Preserve the grant under an explicit legacy namespace and an unknown digest;
-- its already-stored operation list remains the authority ceiling.
UPDATE hosted_provider_notification_grants
SET grant_json = grant_json
      || CASE
        WHEN NOT grant_json ? 'application_declaration_id' THEN
          jsonb_build_object(
            'application_declaration_id',
            'legacy.unbound.' || replace(grant_json ->> 'application_id', '-', '')
          )
        ELSE '{}'::jsonb
      END
      || CASE
        WHEN NOT grant_json ? 'application_manifest_digest' THEN
          jsonb_build_object(
            'application_manifest_digest',
            'sha256:' || repeat('0', 64)
          )
        ELSE '{}'::jsonb
      END,
    updated_at = now()
WHERE (
    NOT grant_json ? 'application_declaration_id'
    OR NOT grant_json ? 'application_manifest_digest'
  )
  AND grant_json ->> 'application_id'
    ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
