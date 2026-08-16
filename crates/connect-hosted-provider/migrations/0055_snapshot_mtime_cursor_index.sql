-- no-transaction
-- The Editor's broad current-record listing orders by canonical file mtime
-- descending and then by canonical path/identity. This is the only measured
-- non-path common ordering admitted to the direct SQL page executor. Keep its
-- complete keyset adjacent so PostgreSQL can stop at the page lookahead row.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hosted_provider_record_projections_snapshot_mtime_cursor_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    file_modified_at DESC NULLS FIRST,
    canonical_path COLLATE "C" ASC,
    record_id ASC,
    valid_from_sequence,
    valid_to_sequence
  );
