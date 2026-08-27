# Application registration and reconciliation

## Decision

An application's immutable identity is its normalized effective manifest digest. The canonical identity includes that digest. A changed effective manifest creates a new application UUID; normalization-equivalent manifests reuse the existing UUID. Grants, tokens, provider capabilities, and notification authorization remain pinned to the exact UUID and signed digest they authorized. There is no application-family grant continuity or automatic version migration.

Registration validates and upserts the exact application and inserts its first job in one database transaction. Failure to enqueue rolls back the application upsert. The job is coalesced by `application_id`; grants are results within that job, not separately claimable jobs. `ON CONFLICT DO NOTHING` is important: registration before, during, or after reconciliation never resets a lease, cursor, retry, or completed schedule and therefore cannot amplify an already-known immutable application. Startup and the infrequent sweep only recover legacy or missing rows. The short ready-job poll does not scan applications.

## Scan and result state

A lease has an explicit `scan` or `retry` phase, so an initial null cursor cannot be confused with retry processing after the end of a scan. The scan advances through active grants in UUID order regardless of individual failures. Each failure creates or updates a compact result keyed by `(application_id, grant_id)` with a closed error class, consecutive attempts, next retry, and timestamps. Success or grant inactivity deletes that result. Due retryable results run in grant UUID order and healthy grants are not replayed. A completed job may retain quarantined results, but cannot retain retryable results.

Malformed-proof and permanent ownership failures are quarantined after three consecutive observations. Provider, relay, timeout, and unknown internal failures remain retryable with capped per-grant exponential backoff. Future scans skip unchanged quarantined rows while still scanning later/new grants. Quarantined rows receive a quiet weekly re-probe so corrected deterministic state recovers automatically; inactivity deletes the result immediately. Registration is not a retry control. Re-probe failures remain identifier-free and do not repeatedly emit an event.

Workers heartbeat independently while bounded provider/relay calls run. Hosted provider calls own an abortable 15-second fetch deadline and may retry three times (about 45.3 seconds worst case); relay policy calls are natively bounded at 5 seconds. The 120-second lease is comfortably above both production bounds. There is deliberately no non-aborting outer `Promise.race`, which could abandon a live operation and overlap a retry. Every durable result, cursor, and job update validates the lease token. Shutdown stops claims and heartbeat renewal and waits at most one second; an unresolved injected/test dependency leaves its lease/result for expiry and durable recovery. A drain handles each selected application at most once, preventing a large immediately-ready application from starving another.

## Retry and unknown-outcome assumptions

Reconciliation operations must be idempotent because timeout or crash can make the remote outcome unknowable:

- provider notification upsert uses the stable grant UUID as identity and replaces the desired projection;
- provider revocation/quarantine is safe to repeat and exact typed missing-resource responses are treated as the existing fail-closed outcome (an arbitrary 404 is not);
- relay policy synchronization sends the complete desired policy under the stable grant UUID rather than an additive mutation;
- local notification narrowing is monotonic/subtractive, and audit insertion follows the same durable local operation. A crash can repeat an audit entry, but cannot restore removed authority.

These assumptions are deliberately narrow. Delivery is at-least-once after an unknown outcome, not exactly-once: job `attempts` counts successful lease claims (including crash recovery), while result `consecutive_attempts` counts consecutive observed grant failures. Reconciliation must not add non-idempotent remote side effects without a durable operation key.

## Observability

Logs and rows contain only the closed event `{phase,errorClass}` and aggregate counters. Raw exceptions and messages are neither logged nor persisted; URLs, response bodies, enumerable properties, and application/grant/account/collection identifiers are excluded. Exact typed provider 404 responses preserve existing fail-closed behavior. Notification reconciliation remains subtractive and derives declaration identity and digest from the grant's signed authorization proof, never mutable discovery data.
