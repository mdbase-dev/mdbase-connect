# Hosted migration provider fronts

The dedicated migration token can call these bounded, audited control-plane routes:

- `GET /internal/v1/next/migration/collections/:id/source`: exact provider lifecycle,
  migration run, head, hold/retention timestamps and journal counters. The
  provider's notification watermark from the same snapshot is returned unchanged
  as the strong `ETag` header (never in the body) and recorded in the source
  audit event. A missing or malformed provider watermark is refused with 503.
- `POST /internal/v1/next/migration/collections/:id/fence` with `{}`: the existing
  provider `active → migrating` transition, or the same current fence on retry.

The canonical non-nil legacy collection UUID is preserved. Both routes require a
current started legacy-owner claim, settled/unquarantined collection, no accepted
terminal exclusion, collection-deletion floor, completed cutover or account flip.
The claim is rechecked after provider awaits, including microsecond start changes.
Started internal migration preserves suspension; it does not change user access.
Every successful result is audited and returned with `Cache-Control: no-store`.
Provider replies are checked within 4 KiB before parsing; malformed, imprecise,
foreign-collection or unavailable replies never become successful driver outcomes.
No caller-selected head, lifecycle, retention, restore IDs or reverse-verification
facts are accepted. A retained/migrated source cannot be re-fenced here.

For Driver `DrainStatus`, only `in_flight` counts writes that could still apply.
`unresolved` and `applied_unreceipted` are retained journal evidence, not a second
pending-write queue. These routes return source facts, not native target admission
or a stable read transaction; the existing signed source-witness path and native
source/target adapters still qualify migration effects and readback.

## Receipted pre-cutover rollback

The native rollback adapter has no provider credentials; Connect is its only
front to the provider's receipted rollback. Both routes take the migration token
and the same body:

```
POST /internal/v1/next/migration/collections/:id/rollback
POST /internal/v1/next/migration/collections/:id/rollback-receipt
{ owner_account, started_us, migration_id, authority_epoch, fixed_head,
  driver_id, action_id, replica_ids }
```

`owner_account` + `started_us` must be the current claim, `authority_epoch` the
collection's current epoch, and `replica_ids` canonical, sorted and unique (may be
empty). Both refuse once the cutover policy is queued. The provider binding is
`{owner_account_id: owner_account, provider_migration_id: migration_id,
authority_epoch, fixed_head, driver_id, action_id, replica_ids}`.

- `rollback`: the first dispatch for a run requires the provider source fenced on
  `migration_id` and a scope that covers every revocation the run owns; Connect
  records the exact binding (`next_migration.rollback_intent`) before calling the
  provider once. A replay must present the same binding and returns the same
  receipt.
- `rollback-receipt`: read-only settlement after a lost reply. It requires the
  recorded binding (`404 migration_rollback_unknown` otherwise, including when
  the provider has no receipt) and never retries the restore.

Both return the provider receipt unchanged,
`{collection_id, binding, restored_ids, recorded_at}`, after checking that it
names this collection, echoes the exact binding and restores only requested
replicas (`503 migration_source_unavailable` otherwise). The first verified
receipt is recorded once as `next_migration.rollback`. Any other binding for a
recorded run (driver, action, head, scope) is refused with
`409 migration_rollback_binding_conflict`; a stale epoch with
`409 migration_epoch_not_current`. A lost reply stays UNKNOWN until a receipt
read answers.

## Deliberately not exposed yet

No SHADOW creation, backup hold acquisition/renewal, Base or cutover append,
target serving, routing or account flip is added by these fronts. A rollback must have a durable pre-CutoverIntent barrier and perform provider
active+restore in one transaction. After a lost rollback reply, active state alone
cannot prove which replicas were restored: exact run-owned receipt/lookup evidence
is required, otherwise the result stays UNKNOWN. Never invoke standalone restore
after unfreeze or infer readiness from HTTP acceptance.

The LAB archive capture/verifier/acceptance profile and supported one-collection
operator remain separate prerequisites. Local synthetic PostgreSQL tests exercise
claim races and typed mocked provider replies, not managed migration qualification.
