-- Ordinary queries can pin the exact record-version head when a derived
-- semantic projection generation is absent or stale. Canonical saved views
-- still require their generation-bound plan.
ALTER TABLE hosted_provider_query_cursors
  DROP CONSTRAINT hosted_provider_query_cursors_generation_state_check,
  ADD CONSTRAINT hosted_provider_query_cursors_generation_state_check CHECK (
    generation_id IS NOT NULL OR request_kind IN ('query', 'obsidian_base')
  );
