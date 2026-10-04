-- mdbase-next migration of hosted collections (mdbase-next docs/ship/migration.md H6-H10).
-- 'migrating' freezes a collection for cutover; 'migrated' keeps it read-only and
-- undeletable until legacy_retain_until, so rollback stays possible (gate 3).
-- Every write, upload and read path already requires state = 'active', so the
-- previous release treats both states as unavailable.
ALTER TABLE hosted_provider_collections
  DROP CONSTRAINT hosted_provider_collections_state_check;

ALTER TABLE hosted_provider_collections
  ADD CONSTRAINT hosted_provider_collections_state_check CHECK (
    state IN (
      'active', 'indexing', 'importing', 'transferring', 'transferred', 'deleting',
      'migrating', 'migrated'
    )
  );

ALTER TABLE hosted_provider_collections
  ADD COLUMN legacy_migration_started_at timestamptz,
  ADD COLUMN legacy_retain_until timestamptz;
