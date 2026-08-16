-- Keep immutable, potentially TOASTed Base plans/context separate from the
-- narrow single-use keyset cursor that rotates on every page.
CREATE TABLE hosted_provider_base_query_invocations (
  invocation_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL
    REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  scope_epoch bigint NOT NULL CHECK (scope_epoch > 0),
  base_plan jsonb NOT NULL CHECK (
    jsonb_typeof(base_plan) = 'object' AND pg_column_size(base_plan) <= 524288
  ),
  base_context jsonb CHECK (
    base_context IS NULL OR (
      jsonb_typeof(base_context) = 'object'
      AND pg_column_size(base_context) <= 524288
    )
  ),
  base_operation_clock text NOT NULL
    CHECK (octet_length(base_operation_clock) <= 64),
  hard_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hosted_provider_base_query_invocations_expiry_idx
  ON hosted_provider_base_query_invocations (hard_expires_at, invocation_id);

CREATE INDEX hosted_provider_base_query_invocations_collection_expiry_idx
  ON hosted_provider_base_query_invocations (
    collection_id, hard_expires_at, invocation_id
  );

ALTER TABLE hosted_provider_query_cursors
  DROP CONSTRAINT hosted_provider_query_cursors_base_state_check,
  ADD COLUMN base_invocation_id uuid
    REFERENCES hosted_provider_base_query_invocations(invocation_id);

INSERT INTO hosted_provider_base_query_invocations
  (invocation_id, collection_id, replica_id, scope_epoch, base_plan,
   base_context, base_operation_clock, hard_expires_at, created_at)
SELECT cursor_id, collection_id, replica_id, scope_epoch, base_plan,
       base_context, base_operation_clock, hard_expires_at, created_at
FROM hosted_provider_query_cursors
WHERE request_kind = 'obsidian_base';

UPDATE hosted_provider_query_cursors
SET base_invocation_id = cursor_id,
    base_plan = NULL,
    base_context = NULL,
    base_operation_clock = NULL
WHERE request_kind = 'obsidian_base';

ALTER TABLE hosted_provider_query_cursors
  ADD CONSTRAINT hosted_provider_query_cursors_base_state_check CHECK (
    (request_kind = 'obsidian_base' AND (
      (base_invocation_id IS NOT NULL AND base_plan IS NULL
       AND base_context IS NULL AND base_operation_clock IS NULL)
      OR
      (base_invocation_id IS NULL AND base_plan IS NOT NULL
       AND base_operation_clock IS NOT NULL)
    ))
    OR
    (request_kind <> 'obsidian_base' AND base_invocation_id IS NULL
     AND base_plan IS NULL AND base_context IS NULL
     AND base_operation_clock IS NULL)
  );
