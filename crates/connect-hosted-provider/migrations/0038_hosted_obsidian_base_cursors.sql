-- Obsidian Base cursors reuse the hosted query snapshot/keyset lifecycle while
-- retaining their dedicated mdbase-rs semantic plan and projection context.
ALTER TABLE hosted_provider_query_cursors
  DROP CONSTRAINT hosted_provider_query_cursors_request_kind_check,
  ADD CONSTRAINT hosted_provider_query_cursors_request_kind_check
    CHECK (request_kind IN ('query', 'canonical_view', 'obsidian_base')),
  ADD COLUMN base_plan jsonb CHECK (
    base_plan IS NULL OR (
      jsonb_typeof(base_plan) = 'object'
      AND pg_column_size(base_plan) <= 524288
    )
  ),
  ADD COLUMN base_context jsonb CHECK (
    base_context IS NULL OR (
      jsonb_typeof(base_context) = 'object'
      AND pg_column_size(base_context) <= 524288
    )
  ),
  ADD COLUMN base_operation_clock text CHECK (
    base_operation_clock IS NULL OR octet_length(base_operation_clock) <= 64
  ),
  ADD CONSTRAINT hosted_provider_query_cursors_base_state_check CHECK (
    (request_kind = 'obsidian_base') = (base_plan IS NOT NULL)
    AND (request_kind = 'obsidian_base') = (base_operation_clock IS NOT NULL)
    AND (request_kind = 'obsidian_base' OR base_context IS NULL)
  );
