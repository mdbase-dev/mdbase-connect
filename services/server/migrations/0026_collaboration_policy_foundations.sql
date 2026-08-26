-- mdbase:skip-if-missing-table applications
-- Collaboration remains disabled for every existing policy, invitation, grant,
-- and replica. Only newly materialized v2 policy snapshots can opt in.

ALTER TABLE collection_membership_policies
  ADD COLUMN collaboration_ceiling jsonb;

ALTER TABLE collection_invitations
  ADD COLUMN collaboration_ceiling jsonb;

ALTER TABLE grants
  ADD COLUMN collaboration_capability jsonb;

ALTER TABLE hosted_replicas
  ADD COLUMN collaboration_capability jsonb;

ALTER TABLE collection_membership_policies
  ADD CONSTRAINT collection_membership_policies_collaboration_ceiling_valid
  CHECK (
    collaboration_ceiling IS NULL
    OR (
      jsonb_typeof(collaboration_ceiling) = 'object'
      AND collaboration_ceiling->'contract_version' = '1'::jsonb
      AND collaboration_ceiling->'profiles' = '["markdown-body-yjs-v13"]'::jsonb
      AND collaboration_ceiling->>'access' IN ('read_only', 'read_write')
    )
  );

ALTER TABLE collection_invitations
  ADD CONSTRAINT collection_invitations_collaboration_ceiling_valid
  CHECK (
    collaboration_ceiling IS NULL
    OR (
      jsonb_typeof(collaboration_ceiling) = 'object'
      AND collaboration_ceiling->'contract_version' = '1'::jsonb
      AND collaboration_ceiling->'profiles' = '["markdown-body-yjs-v13"]'::jsonb
      AND collaboration_ceiling->>'access' IN ('read_only', 'read_write')
    )
  );

ALTER TABLE grants
  ADD CONSTRAINT grants_collaboration_capability_valid
  CHECK (
    collaboration_capability IS NULL
    OR (
      jsonb_typeof(collaboration_capability) = 'object'
      AND collaboration_capability->'contract_version' = '1'::jsonb
      AND collaboration_capability->'profiles' = '["markdown-body-yjs-v13"]'::jsonb
      AND collaboration_capability->>'access' IN ('read_only', 'read_write')
      AND scope->>'access' = 'full_collection'
      AND operations @> '["read"]'::jsonb
      AND (
        collaboration_capability->>'access' = 'read_only'
        OR operations @> '["update"]'::jsonb
      )
    )
  );

ALTER TABLE hosted_replicas
  ADD CONSTRAINT hosted_replicas_collaboration_capability_valid
  CHECK (
    collaboration_capability IS NULL
    OR (
      purpose = 'application'
      AND jsonb_typeof(collaboration_capability) = 'object'
      AND collaboration_capability->'contract_version' = '1'::jsonb
      AND collaboration_capability->'profiles' = '["markdown-body-yjs-v13"]'::jsonb
      AND collaboration_capability->>'access' IN ('read_only', 'read_write')
      AND (
        collaboration_capability->>'access' = 'read_only'
        OR mode = 'read_write'
      )
    )
  );
