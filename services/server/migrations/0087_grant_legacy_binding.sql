-- A grant carried over from a taken-over local collection to its Private
-- collection keeps the legacy target and relay binding it left, so a fenced
-- local rollback can return the app to the old connector. Both are cleared
-- when the rollback restores them; neither is ever an authorization by itself.
ALTER TABLE grants
  ADD COLUMN legacy_collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
  ADD COLUMN legacy_encryption jsonb;
CREATE INDEX grants_legacy_collection_idx ON grants(legacy_collection_id)
  WHERE legacy_collection_id IS NOT NULL;
