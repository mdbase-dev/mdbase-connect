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
state and SyncStep1. Multi-instance catch-up, proactive revocation disconnects,
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
