-- Obsidian Base exact fallback can pin the versioned record head even when a
-- collection has no usable projection generation. Other query kinds still
-- require a generation-bound cursor.
ALTER TABLE hosted_provider_query_cursors
  ALTER COLUMN generation_id DROP NOT NULL,
  ADD CONSTRAINT hosted_provider_query_cursors_generation_state_check CHECK (
    generation_id IS NOT NULL OR request_kind = 'obsidian_base'
  );
