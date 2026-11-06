## Fixed

- A large hosted or escrow collection can open again: rebuilding derived data and the query index at open now commits in byte-bounded batches, and reading resources pages past the hosted row limit. Before this, one oversized page failed the open on every retry and the object stayed dark.
- A query index backfill refused for size no longer stops an object from opening. It reports an incident and keeps the index unready, so queries stay complete or decline visibly.

## Changed

- Hosted open failures name the step that failed, and a SQL budget refusal logs the operation and table, with no identifiers or content.
