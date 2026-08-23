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

The durable collaboration batch writer is intentionally disabled in this
review boundary. The existing ordinary mutation write-set committer still owns
record/version/change/head/receipt persistence; no parallel collaboration
persistence path, acknowledgement, broadcast, transport, readiness signal, or
Editor behavior has been introduced. Batch writes will be enabled only after
that committer is extracted and shared by both mutation paths.
