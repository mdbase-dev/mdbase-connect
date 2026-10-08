# Permanent collection-deletion denial foundation

Migration `0061_next_collection_deletion_facts.sql` deliberately has no foreign keys to live collection, user, grant or job rows. Removing those rows cannot erase denial. It is the CP journal/denial component only: it does not accept a user deletion, call native deletion, open a startup gate, acknowledge `Deleted`, or purge content.

`collection-deletion.ts` has three internal consumers-to-be:

- `recordCollectionDeletionIntent`: called only in an already authorized/confirmed owner transaction holding the existing collection lock. It chooses the first immutable CP deletion identity and terminal lifecycle epoch1 (previous untracked lifecycle0), retaining actor/time metadata. An existing independently observed floor is returned without creating another CP intent. Retries cannot replace the first CP intent. Returning a local fact is not a native receipt.
- `mergeCollectionDeletionFloors`: called only after authenticating and strictly validating a current nil-registry page against the configured log-service environment. Bounded128-row pages are copied/validated before any insert. Caller commits a page atomically. Union retains local, older and higher denial evidence; conflicting identities never become optimistic receipt success. The native authority still owns exactly one immutable tuple per collection; retaining conflicting restored CP evidence does not create native successors.
- `requireCollectionNotDeleted`: presence of ANY fact denies that UUID, independent of live rows. It is not a liveness proof when no fact exists. Final publication callers must integrate it with their existing lock/currentness transaction, not check once before network awaits.

Lifecycle epochs are independent of policy-key epochs, native wakes, fault generation and migration run IDs. PostgreSQL numeric(20,0) retains the full positive u64; code accepts checked bigint and passes its decimal string, never a lossy JS number. SQL-to-Node reads use decimal text. The database is one configured environment; no caller-selected environment or source URL is added.

## Remaining integration

Coordinator-approved native contract is strict typed-only, one immutable `(collection,deletion_id,lifecycle_epoch)` ever. Independent permanent nil-registry floor precedes collection-log Gone, hosted retirement and physical purge. `Deleted` requires BOTH matching typed floor and Gone receipts; a bool, 404, missing row or CP timestamp is insufficient. Native delete_log must independently inspect the durable matching nil floor before serialized Gone.

Before a restored CP serves keys, imports or routes, it must union the NONRESTORED nil registry into this ledger and finish an authenticated complete/current-generation scan. Lost/partial/stale/conflicting scans remain unavailable. Existing tupleless Gone also denies even without a registry/CP fact; exact terminal-status API is required for that check. The CP database/signing key cannot certify itself latest after restore. No new signing authority is added. A completed startup scan is not a later effect-time liveness lease.

Next work wires native record/page/typed Gone/status transport, the fail-closed startup union gate and denial into every registration/key/route/migration/restore path, then existing owner/account deletion and durable cleanup fanout. These primitives alone provide none of those gates or operations.

## Qualification

Disposable PostgreSQL tests cover concurrent first intent, immutable retries, live user/collection cascades, MAXu64, union/idempotency/conflict retention, malformed full-page rejection and surrounding transaction rollback. They do not perform native deletion, restore, hosted retirement or service operations.
