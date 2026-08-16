-- no-transaction
-- Default hosted ordering is the canonical path plus stable record identity.
-- Keep the complete keyset adjacent in the btree so later pages can seek
-- directly instead of rechecking every earlier path. Temporal bounds remain in
-- the key because repeatable-read cursors may legitimately retain a row that an
-- ordinary concurrent write has since closed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS hosted_provider_record_projections_snapshot_path_cursor_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    canonical_path COLLATE "C",
    record_id,
    valid_from_sequence,
    valid_to_sequence
  );
