## Added

- The hosted provider has `migrating` and `migrated` collection states for the
  mdbase-next migration.
  - Both refuse writes and reads. Replica registration and token rotation answer
    a distinct `collection_migrating` (409), never a not-found.
  - `migrated` needs at least 90 days of `legacy_retain_until`, never shortened.
    The provider refuses it while accepted writes are still in flight.
  - Once cut over, a collection returns to `active` (directly or through
    `migrating`) only with `reverse_verified`. Rollback to `active` can restore the
    replicas revoked during the migration in the same transaction.
  - Compaction is refused and the blob deletion worker never removes a retained
    collection's objects, whatever queued them. Retention is rechecked under the
    collection lock right before each deletion.
  - Deleting a collection or account is immediate and terminal, even during
    retention: its objects are purged and no rollback path accepts it.
  - A drain status route reports the head and the accepted mutations still
    holding a live lease.
  - Nothing calls these routes until the migration runs.
