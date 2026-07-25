# @mdbase/connect-sync

Provider-neutral replication protocol and executable reference state machine for
hosted mdbase collections. It models stable record identity, pinned snapshots,
scoped ordered changes, conditional idempotent mutations, conflicts, cursor
reset, revocation, offline queues, and receive-only or writable Markdown
mirrors.

Application replicas resolve a stale record explicitly with
`resolveConflict(recordId, "local" | "remote")`. Keeping the local version
rebases it as a new idempotent mutation; keeping the remote version discards
only that record's queued mutations.

The in-process reference authority remains useful for deterministic contract
tests. Production uses `mdbase-connect-hosted-provider`: normalized encrypted
PostgreSQL storage, durable receipts and snapshot leases, and canonical
operation execution through `mdbase-rs`.

```bash
# Recommended: approve the folder in a browser and sync both ways
mdbase-mirror connect ./tasks --server https://connect.mdbase.dev \
  --collection <collection-id>

# Receive-only browser enrollment
mdbase-mirror connect ./tasks --server https://connect.mdbase.dev \
  --collection <collection-id> --read-only

mdbase-mirror sync ./tasks
mdbase-mirror status ./tasks
mdbase-mirror resolve ./tasks <record-id> --use local

# Move authority from mdbase cloud to this computer
mdbase-mirror promote ./tasks
```

`connect` creates a short-lived browser approval request. The resulting
collection-scoped access and renewal credentials are stored in the device's
owner-only application-state directory, never inside the mirrored folder.
Access tokens renew automatically until the mirror is revoked.

`promote` requires a converged, full writable mirror and a running local
`mdbase-connect` agent. It opens a browser confirmation, freezes hosted writes
at a final sequence, proves that the directory is exact, and registers the
folder locally under the collection's stable ID. Completion advances the
authority epoch and revokes the old hosted replicas and application grants.
Before cutover, cancellation or expiry restores hosted writes. If the command
is interrupted after local registration, run it again to resume completion.

The lower-level `init` command remains available for automation and migration.
It reads a pre-provisioned token from a hidden prompt or
`MDBASE_CONNECT_REPLICA_TOKEN`.

Configuration and type documents are materialized but never uploaded as
ordinary records. Writable changes use base revisions and a durable mutation
journal. A concurrent edit isolates only the affected record while unrelated
records continue synchronizing. `status` identifies the records that need an
explicit local or remote choice. When a writable mirror connects an existing
directory, the first sync compares the complete remote snapshot before writing
or uploading anything. Differing paths stop for explicit review; matching
Markdown keeps its local file and previously unmanaged Markdown is uploaded.
