ALTER TABLE hosted_provider_replicas
  ADD COLUMN IF NOT EXISTS application_declaration_id text,
  ADD COLUMN IF NOT EXISTS application_declaration_digest text;

UPDATE hosted_provider_replicas
SET revoked_at = COALESCE(revoked_at, now())
WHERE purpose = 'application'
  AND 'apply_collection_setup' = ANY(allowed_operations)
  AND (
    application_declaration_id IS NULL
    OR application_declaration_digest IS NULL
  );

ALTER TABLE hosted_provider_replicas
  ADD CONSTRAINT hosted_provider_setup_declaration_binding
  CHECK (
    NOT ('apply_collection_setup' = ANY(allowed_operations))
    OR (
      purpose = 'application'
      AND application_declaration_id IS NOT NULL
      AND application_declaration_id ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)+$'
      AND application_declaration_digest ~ '^sha256:[0-9a-f]{64}$'
    )
  );
