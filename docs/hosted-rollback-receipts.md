# Hosted provider rollback receipts (internal v1)

This is provider-local evidence, not native migration authorization or readiness.
The CP rollback front must remain withheld until its native adapter can freshly
validate the current started-owner/source-target claim, the actual saved
RollingBack/pre-CutoverIntent/pending action, and settled or ineligible competing
target effects. Driver/action UUIDs are correlation only. Operator approval is
still required for each managed operation.

## Exact atomic operation

`POST /internal/v1/collections/:id/legacy-migration/rollback` uses the existing
provider internal authentication and the same collection-first locked transition
and migration-owned restore implementation as the existing state endpoint.
It accepts a strict object:

- `owner_account_id`, `provider_migration_id`: nonzero UUIDs matching the locked
  provider collection row;
- `authority_epoch`, `fixed_head`: the existing source authority epoch and exact
  fixed drained head, not an invented CP version;
- `driver_id`, `action_id`: nonzero UUIDs from the durable native pending action;
- `replica_ids`: at most 1000 distinct nonzero UUIDs, canonicalized by sorting.

Before effects, the provider requires its exact current owner/epoch/run/head,
`migrating`, an existing start timestamp, no cutover retention, and the existing
zero-live-accepted-mutations drain predicate. Mismatches refuse in the transaction.
It never accepts a `reverse_verified` or readiness flag.

The transaction restores only unchanged revocations owned by that provider run,
sets the source active, and persists a receipt binding the complete request,
collection, actual restored IDs and database recording time. Independent/user
revocations stay revoked. Receipt insertion or state-update failure rolls back
all effects. The old-write front effectively reopens in this transaction.
Existing admin/reverse-export state APIs keep their existing semantics and do
not produce this native pending-action receipt.

## Lost response and replay

`POST /internal/v1/collections/:id/legacy-migration/rollback-receipt` accepts the
same binding and performs only exact receipt lookup with current locked source
checks. Missing evidence refuses; it never attempts another restore or infers
success from an active collection. An identical mutation request can return its
original exact receipt without performing another effect. A different
Driver/action/source/requested-ID binding refuses.

Source writes can advance the head after rollback: receipt lookup requires the
current head not to precede the fixed head, while owner and authority epoch must
still match and the source must be active without a migration/retention marker.
A new provider migration supersedes replay eligibility in the same existing
transition transaction. Historical receipts remain stored, but cannot be revived
by rolling that later migration back to active. Deleted/replaced sources refuse.
A receipt is evidence of the original transaction, never fresh permission.

The native host must persist the full exact receipt before Driver.complete
clears its revoked IDs, retain it through reopen and terminal state, and use its
original request identity for later Unfence verification. Nonempty Unrevoke
executes the atomic operation; subsequent Unfence checks receipt plus current
active source. Empty IDs execute the atomic operation only when Driver emits
Unfence. Missing/partial/wrong-run evidence stays UNKNOWN/stop; no blind retry,
standalone restore or deletion of frozen new-log evidence.
