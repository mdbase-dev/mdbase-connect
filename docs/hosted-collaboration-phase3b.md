# Hosted collaboration Phase 3B slice

This slice adds the provider-side transactional room rehydration boundary,
without advertising collaboration or adding HTTP/WebSocket routes.

A room is initialized under the ordinary stable-record `FOR UPDATE` lock from
the encrypted Markdown record. Its epoch is positive and its profile is the
exact `markdown-body-yjs-v13` profile; initial Yrs state contains only
`Y.Text("body")`. Existing snapshots and updates are authenticated, replayed
in sequence, bounded, and compared byte-for-byte with the authoritative body
and revision. A mismatch fences the row as `rebuilding` and returns a repair
error without content logging.

Checkpointing writes a full encrypted snapshot and state vector before deleting
covered update rows in the same transaction. Because the snapshot is a full
state update, old state vectors remain synchronizable. Metadata-only repair
fences active epochs and creates the next epoch from the authoritative record.

A later Phase 3C review boundary extracted the ordinary hosted write-set
committer and added a crate-private collaboration batch path that uses it for
the same record/version/change/head/projection/outbox transaction. The batch
path also persists encrypted Yrs updates and idempotent receipts, exact
ciphertext quota totals, and bounded compaction in that transaction. It remains
unreachable from HTTP or WebSocket routes and cannot acknowledge or broadcast:
transport, tickets, readiness advertisement, and Editor behavior are still
disabled pending Phase 4 authorization and crash/restart acceptance.
