ALTER TABLE hosted_provider_changes
  ADD COLUMN IF NOT EXISTS source_replica_id uuid;

CREATE INDEX IF NOT EXISTS hosted_provider_changes_source_replica_idx
  ON hosted_provider_changes(source_replica_id)
  WHERE source_replica_id IS NOT NULL;
