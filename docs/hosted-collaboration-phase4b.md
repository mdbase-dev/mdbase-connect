# Hosted collaboration Phase 4B

This development-only slice enables one provider process when
`MDBASE_CONNECT_HOSTED_COLLABORATION_ENABLED=true`. The flag is false by
default, and collaboration is still omitted from the provider readiness
capability response.

The slice provides:

- exact-proof, bearer-authenticated HTTP issuance of short-lived, origin-bound,
  single-use WebSocket tickets;
- a bounded binary WebSocket session with no room data before ticket
  authentication;
- durable state-vector sync, per-batch authorization revalidation, and
  commit-before-acknowledgement;
- bounded process-local post-commit fanout; and
- PostgreSQL 18 acceptance with two real headless WebSocket clients, reconnect,
  replay, malformed and oversized input, exact-origin enforcement, and
  disabled-mode checks.

A collaboration update cannot move the Markdown frontmatter boundary. This
keeps the Y.Text body equal to the ordinary record body's exact bytes. State
snapshots and transport diffs are checked before framing so an oversized state
closes one session rather than panicking the provider.

This is not a production-ready multi-instance transport. Process-local fanout
is only a latency optimization; reconnect correctness comes from durable room
state and SyncStep1. Multi-instance catch-up beyond the internal slice below,
proactive revocation disconnects,
awareness/presence sanitation, typed socket errors and metrics, receipt/ticket
retention maintenance, graceful socket drain, and room repair remain explicit
gates. Conventional writer epoch reconciliation is implemented internally: a
durable per-record epoch fence (surviving record deletion) is the authority for
room epochs; ordinary body changes and deletes transactionally advance it while
retiring old rooms, tickets, updates, and receipts; path moves and
frontmatter-only writes retain the stable record room while refreshing its
materialized revision; and stale epochs are rejected at the database and every
admission boundary. Migration 0043 and its provider binary must be deployed as
one admission-disabled cutover because older binaries do not create epoch
fences. The Editor and SDK do not enable or expose live collaboration yet.

## Internal multi-instance catch-up slice

When the flag is enabled, an accepted collaboration batch queues one
metadata-only notice on the private `mdbase_hosted_collaboration_commit_v1`
PostgreSQL channel as the final action of its transaction, after persistence
and compaction. The strict deny-unknown-fields payload carries exactly
`collection_id`, `record_id`, `collaboration_epoch`, `profile`, and the new
high-water `sequence` — never paths, revisions, digests, mutation or replica
identifiers, or content — and is never logged. Rollbacks and all-replay batches
emit nothing; a notify error aborts the transaction.

Notifications are hints only. Local and remote delivery share one durable
catch-up path that reloads and decrypts authoritative snapshot/update rows from
PostgreSQL each round inside a short transaction, validating the epoch fence,
active lifecycle, record and materialized revisions, ciphertext AAD bindings,
digests, and contiguous sequence metadata before any plaintext reaches a
socket. A cursor behind compaction receives the stored full-state snapshot as
an idempotent Yjs update followed by the later rows. Page count and bytes are
bounded per round; oversized or inauthentic frames fence the room for repair
instead of being delivered. Origin echo is suppressed only by matching the
stored replica id and client mutation id of a session's own acknowledged
contributions; client metadata is never trusted beyond the authenticated
mutation, and identifiers are never exposed on frames.

The wake listener starts explicitly and fails closed when collaboration is
enabled, using a dedicated one-connection pool outside the primary-pool budget.
One listener task and one bounded periodic sweep task serve the whole process;
wakes coalesce into at most one queued high-water mark per active room, unknown
rooms allocate nothing, and no lock is held across SQL, key unwrapping, or
socket I/O. Listener reconnection and the sweep reconcile every active room,
recovering missed terminal notifications without duplicate delivery. Disabled
mode creates no listener or task and routes stay unavailable.

## Internal session drain and revocation slice

The provider now owns a bounded session runtime for upgraded collaboration
sockets with an `Accepting`, `Draining`, `Closing`, `Drained` lifecycle and RAII
socket and in-flight-update guards. One shutdown signal drives the whole exit:
drain begins first, rejecting new tickets, upgrades, and updates while any
already-started update batch finishes and receives its acknowledgement, then
every socket receives a WebSocket close (1001 going away) and the runtime awaits
their exit before the Axum wait completes; the wake runtime and maintenance
tasks stop afterwards.

Every upgraded-socket database operation runs inside the same bounded request
semaphore as ordinary requests plus one runtime-admission transaction, and both
are released before any frame is written to the socket, so slow clients cannot
pin admission. Admission suspension therefore reaches live sessions: they close
at their next reauthorization instead of silently continuing.

Sessions are bound at ticket consumption to the replica credential fingerprint
observed under lock. Token rotation is detected without a scope bump: the local
internal rotate/policy/revoke handlers target-close that replica's sessions
immediately after their commit, and every session additionally reauthorizes
against PostgreSQL every two seconds, so mutations committed on any instance
converge to closure well under four seconds everywhere. The durable batch
boundary also compares the fingerprint, so a rotated-away session cannot land an
update inside the detection window. Awareness and readiness advertisement remain
future gates.
