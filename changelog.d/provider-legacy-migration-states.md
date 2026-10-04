## Added

- The hosted provider has `migrating` and `migrated` collection states for the
  mdbase-next migration. Both refuse every write and read path. They also block
  deletion and compaction: `migrating` for its whole duration, and `migrated` until
  `legacy_retain_until`, which must be at least 30 days after cutover. Internal
  routes set the state and restore exactly the replicas revoked since the migration
  started (rollback). Nothing calls them until the migration runs.
