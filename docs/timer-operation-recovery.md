# Timer operation recovery

A timer receipt records a committed CP metadata mutation, not notification delivery.
A timer list, cancellation ID or fire count does not recover an uncertain original operation.

## Fixed HTTP profile

- `GET /v1/next/collections/:collection/timers/:namespace` returns the current `intent_revision` with the timer snapshot.
- `POST .../:namespace/reconcile` optionally adds `recovery: {protocol_version: 1, operation_id, expected_revision}` to the existing criterion/timers body.
- `GET .../:namespace/operations/:operation_id` returns `{outcome: "committed", receipt}` or `{outcome: "unknown", namespace, operation_id}`.

Recovery mutations and lookup require the retained grant's existing AuthorityProofV1/P256 signing proof. The proof covers the exact HTTP target, token and original request bytes. The consenting account is the grant account, not the collection creator. Token, grant and account rows are held current; capability and collection authorization are rechecked after lock waits and before commit. PRIVATE remains denied by the default resolver.

Clients allocate and persist a UUIDv7, canonical desired snapshot and exact safe-integer revision before first dispatch. Unknown outcomes retain that identity and namespace fence. Clients must not mint a replacement identity, replay periodically, refresh/adopt different consent or interpret missing lookup as no effect. Existing SDK ports without recovery fields cannot use this profile yet.

## Atomicity and retention

Each accepted put, cancel (including no-op), reconcile and winning import advances the namespace intent revision. An old first application conflicts after a newer intent. Exact retained replay returns the original receipt without changing timer generations; changed body, namespace, revision or immutable consent conflicts.

Mutation, revision and metadata-only receipt commit together. Receipt results exclude timer data and unknown future fields. Lock/statement waits are capped at five seconds; the metadata transaction has a nine-second deadline within the client's ten-second whole-request cap. Request bodies are at most 2 MiB and responses at most 1 MiB. Oversized receipt forecasts fail before invoking the timer mutator; no truncation.

New operation admission requires the UUIDv7 timestamp within five minutes of server time. `operation_not_admitted` with reason `operation_clock_window` describes clock-window rejection without guessing CP time; its original outcome remains unknown. Retained lookup and exact replay are not subject to this initial-admission window.

Receipts are retained for seven days, with write-side cleanup only. Missing older identities cannot execute again. Namespace revisions are never reset or pruned. Atomic grant limits are 8,192 receipts, 32 MiB of receipt metadata and 256 namespaces; capacity failures reject the whole transaction. Prospective and final stored-byte charges use PostgreSQL's `jsonb::text` representation, matching the existing stored sum; compact wire JSON has its separate response bound. Read-only lookup neither cleans up nor creates namespaces or wakes the timer worker.

Legacy cutover imports acquire grant/namespace locks before reading current authority. Active account/grant and existing collection-mode rows remain share-locked; scope, criterion and service credential are rechecked after waits and before COMMIT. Changed or PRIVATE authority cannot publish stale imported timer data or advance an intent.

## Qualification

Local PostgreSQL fixtures exercise concurrent deduplication, delayed intent rejection, changed bindings, rollback, retention, metadata bounds, PRIVATE denial, actual HTTP response loss after COMMIT followed by signed lookup, and token expiry/revocation during real lock waits. Synthetic fixture grants do not qualify native enrollment, applied PRIVATE approval or provider delivery. Publication, client wiring and LAB activation require their own evidence.
