ALTER TABLE hosted_provider_replicas
  ADD COLUMN collaboration_capability jsonb;

ALTER TABLE hosted_provider_replicas
  ADD CONSTRAINT hosted_provider_replicas_collaboration_capability_valid
  CHECK (
    collaboration_capability IS NULL
    OR (
      purpose = 'application'
      AND grant_id IS NOT NULL
      AND application_declaration_id IS NOT NULL
      AND application_declaration_digest IS NOT NULL
      AND allowed_origin IS NOT NULL
      AND proof_public_key IS NOT NULL
      AND full_collection = true
      AND contract_scope = '[]'::jsonb
      AND 'read' = ANY(allowed_operations)
      AND jsonb_typeof(collaboration_capability) = 'object'
      AND collaboration_capability->'contract_version' = '1'::jsonb
      AND collaboration_capability->'profiles' = '["markdown-body-yjs-v13"]'::jsonb
      AND collaboration_capability->>'access' IN ('read_only', 'read_write')
      AND (
        collaboration_capability->>'access' = 'read_only'
        OR (
          mode = 'read_write'
          AND 'update' = ANY(allowed_operations)
        )
      )
    )
  );
