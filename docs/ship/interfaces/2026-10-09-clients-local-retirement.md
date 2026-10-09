# Local connector retirement — source contract

This is source qualification, not deployment, successful takeover, native
publication, custody or LAB acceptance evidence.

## Daemon request and response

`POST /v1/next/migration/local-takeover` uses an ordinary current connector
bearer, never a scoped installation token. The caller must be a current native
desktop/CLI device on the same unsuspended next-backed account as the target.

The strict body has exactly `legacy_connector_id`, `legacy_collection_ids` and
`taken_over_at`. IDs are non-nil UUIDs; the collection list is nonempty, unique
and bounded at 1,000 entries. The observation timestamp is a bounded ISO datetime
with an optional timezone offset, not evidence or the server retirement time.
Input IDs are canonicalized and sorted before exact registered-inventory
comparison. Registered `collections.local_id` is PostgreSQL `uuid`, not text:
its lowercase output and byte ordering match canonical JavaScript UUID order
without text collation or case folding. PostgreSQL enforces UUID uniqueness per
connector; case-equivalent duplicate input is invalid, never deduplicated into
success.
The success body is only `{ retired: true, legacy_connector_id }`.

The target cannot be the caller, foreign, missing, or linked to any historical
or current next device. Positive registered `present`/not-removed collection rows
must match the full input inventory, including rows whose authority is already
retired. Missing or removed rows never authorize an empty or partial success.

## Transaction and recovery boundaries

All three paths lock/check the account before locking connector identities.
Retirement locks its current account and native caller, then the exact legacy
target, then its collection rows. Device enrollment takes the same connector
lock and rechecks the original request bearer, current owner, suspension and
revocation before challenge consumption or device insertion. Legacy inventory
rechecks those same account/credential facts before either accepting a new
revision or returning a legitimate stale-revision `accepted: false` result.
A stale authenticated identity is refused, not reported as a stale-revision
success. Lock/statement timeouts remain bounded and surface as 503 `busy`.

Retirement stamps the server revocation time and advances the connector relay
generation once, disables and retires the exact present authorities, and keeps
collection, legacy grant and rollback-binding rows. It does not rotate keys,
activate grants or change the account backend. Exact replay preserves timestamp
and generation after all current caller, target and inventory checks.

Relay closure follows commit. Failed immediate broker closure never rolls back
the committed credential/generation fence; the existing bounded relay lease
converges. An exact replay can attempt closure again without another generation
or timestamp change.

## Qualification and limits

- 35 targeted real-Postgres cases pass, including native UUID case/order,
  collation independence, duplicate registration/input refusal, and both inventory/retirement and
  enrollment/retirement lock orderings with actual blocking transactions,
  post-authentication digest/owner/suspension/revocation refusals, challenge
  preservation, positive inventory, exact replay and bounded HTTP503.
- Six adapted fixture-caller suites pass against individually fresh disposable
  Postgres containers: 119 cases, unchanged assertions. Combined targeted total:
  154 real-Postgres cases (35 retirement plus the six previously qualified callers).
  File isolation does not replace concurrent requests
  inside the race cases or weaken product timeouts.
- `pnpm ci:local --node` passes every selected gate, including existing inventory
  behavior tests; Rust/container/upgrade/system lanes are not local claims.
- A separate seven-file parallel attempt failed in migration `beforeAll` on the
  global advisory lock. It is retained as a failed attempt, not counted as
  passing CI or claimed resolved by the unrelated schema metadata helper fix.
  GitHub CI and exact-head implementation review remain required.

No LAB runtime/account operation, backend change or rendered READ is inferred.
