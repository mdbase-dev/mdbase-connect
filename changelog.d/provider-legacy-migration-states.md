## Added

- The hosted provider has `migrating` and `migrated` collection states for the
  mdbase-next migration. Both refuse every write and read path. They also block
  deletion and compaction: `migrating` for its whole duration, and `migrated` until
  `legacy_retain_until`, which must be at least 90 days after cutover, and the blob
  deletion worker never removes a retained collection's objects, whatever queued
  them. Internal routes set the state and restore exactly the replicas revoked since
  the migration started (rollback); rolling back after cutover requires the runbook to
  state that the reverse export was verified. Nothing calls them until the migration
  runs.
