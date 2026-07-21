# @mdbase/connect-sync

Provider-neutral replication protocol and executable reference state machine for
hosted mdbase collections. It models stable record identity, pinned snapshots,
scoped ordered changes, conditional idempotent mutations, conflicts, cursor
reset, revocation, offline queues, and receive-only or writable Markdown
mirrors.

The in-process reference authority remains useful for deterministic contract
tests. Production uses `mdbase-connect-hosted-provider`: normalized encrypted
PostgreSQL storage, durable receipts and snapshot leases, and canonical
operation execution through `mdbase-rs`.

```bash
# Receive-only mirror
mdbase-mirror init ./tasks --server https://sync.mdbase.dev \
  --collection <collection-id> --replica <replica-id>

# Writable mirror (must be enrolled with read_write mode)
mdbase-mirror init ./tasks --server https://sync.mdbase.dev \
  --collection <collection-id> --replica <replica-id> --writable

mdbase-mirror sync ./tasks
mdbase-mirror resolve ./tasks <record-id> --use local
```

The token is read from a hidden prompt or
`MDBASE_CONNECT_REPLICA_TOKEN`. Configuration and type documents are
materialized but never uploaded as ordinary records. Writable changes use
base revisions and a durable mutation journal; concurrent edits stop with a
persisted conflict until the user explicitly chooses local or remote content.
When `--writable` initializes an existing directory, the first sync establishes
the remote baseline and uploads previously unmanaged Markdown in the same run.
Remote/path collisions and resource differences still stop for explicit review.
