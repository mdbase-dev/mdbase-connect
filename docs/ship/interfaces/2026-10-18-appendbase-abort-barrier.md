# Proposed AppendBase abort barrier (G5)

Status: rollback-only negative fence and rooted-prefix publication-exclusion
proof approved and implemented behind authenticated migration-service operations.
No deployment or live operator authority. Targets mdbase-next main and a
separately reviewed Connect CP route.

## Why an owned CP operation is needed

An AppendBase UNKNOWN can still have an HTTP append in flight. Native caught-up
absence, a new CPP claim and invalidated local handles cannot fence that request:
the blind log checks its own ACL/token/epoch, not the migration claim. Its exact
sealed bytes can still win their conditional position. Cancellation requires an
irrevocably occupied log position, not an absence inference.

The existing `members-policy` endpoint cannot serve as a barrier: when members
already match it queues zero items. `cutover-policy` is not usable before Base
and would change authority. No general policy refresh route was found. Hosted
self-key-grants are explicitly invalid; grants to users are neither guaranteed
available nor an appropriate recovery mechanism. Do not relax those rules.

## Preferred minimal proposal: rollback-only negative policy fence

Add an owned CP endpoint:

```
POST /internal/v1/next/migration/collections/:id/appendbase-abort-barrier
Authorization: existing migration-service token
```

Closed request DATA, constructed only from the native operator scope:

```json
{
  "owner_account":"<canonical uuid>",
  "started_us":"<original claim timestamp>",
  "migration_id":"<original provider run uuid>",
  "driver_id":"<native driver uuid>",
  "action_id":"<original AppendBase action uuid>",
  "run_sequence":1,
  "action_sequence":186,
  "fingerprint":"<64 lowercase hex>",
  "checkpoint_digest":"<64 lowercase hex>"
}
```

This does not assert outcome, base absence or authorization. The CP independently
qualifies the exact owner/provider run, drained fenced migrating source, current
SHADOW cloud-copy target and absence of queued cutover before emitting. Operator
input still supplies only collection, operation and the two expected sequences.
No caller-supplied source proof, signed policy, force or replacement binding.

The CP creates one immutable correlation record and its outbox row atomically,
keyed by collection/driver/action with full-payload equality on readback. A
conflicting binding refuses. A lost reply never authorizes a second barrier:
read-only lookup reconciles the same record/batch. Existing outbox preserves
identical signed bytes after uncertain send; its ordinary conditional head-moved
handling must not silently substitute an unrelated correlation.

Emit one genuine CP-signed policy item using **existing wire semantics**:

```
policy[freeze true, reason = correlation digest]
```

The digest is domain-separated over the exact request tuple, encoded canonically.
The reason is its bounded, fixed-format correlation, not an arbitrary message.
This is a **negative fence, not a no-op**. It never unfreezes, changes membership,
grants keys, rotates epoch or cuts over. The new log remains frozen after rollback;
removing that fence/reprovisioning a target is a separate explicit product flow.
The legacy fence is cleared only by the original receipt-qualified rollback.

The rollback-only distinction is explicit and approved. An actual policy no-op would require
an explicit policy wire extension (empty ops are currently forbidden), plus log
service and client compatibility work. Do not disguise such an extension as a
self-key-grant or clear a real freeze with `freeze false`.

## Response and native qualification

Response is bounded DATA, not a permission receipt:

```json
{
  "schema":"mdbase-appendbase-abort-barrier/1",
  "collection_id":"<uuid>",
  "driver_id":"<uuid>",
  "action_id":"<uuid>",
  "digest":"<64 lowercase hex>",
  "state":"queued",
  "sequence":null,
  "item_sha256":null
}
```

Once durably appended, `state` is `appended`, with safe-positive sequence and
64-lowercase-hex item hash. Queued, sent, parked, missing and unknown outcomes do
not authorize cancellation. Readback uses the same closed correlation tuple.
HTTP success or reported appended state is not sufficient proof.

Native must verify the actual retained CP-signed policy/effect in its own caught-up
log, matching correlation and item/position, and confirm no installed Base.
Qualification cannot use a caller-provided bool or unvalidated nullable projection.
A missing, pruned, void, foreign or unavailable barrier refuses. A successful
original Base wins the race: resolve normally, never cancel it as absent.
This is a **publication-exclusion proof**, not original-slot equality. Verify
the COMPLETE contiguous, bounded, hash-chained control-only prefix from the
trusted root through the correlated freeze and to the final read-back head
(at most 64 positions and 256 KiB of retained item bytes).
No missing, unreadable, oversized or unverified slot is permitted. No installed
Base or cutover is permitted. Sealing requires an applied unfrozen head, so
every original seal is at or before this freeze; every such position is now
positively occupied. The original action cannot reseal. It therefore can never
newly publish, even if the new log is unfrozen later. Physical/generation/claim
fences are rechecked after all async work. No original sealed-position witness
is added: that is possible future hardening, not a requirement or fallback for
this approved exclusion proof.

Consuming the barrier advances the authenticated head and invalidates the
original CPP observation. End that owned claim before the canonical pump, then
acquire a fresh owned claim on the SAME physical Engine/generation. Re-read the
native original scope and require exact full-tuple equality before cancellation.
Do not refresh/extend an old claim or relax its strict native currentness check.
A racing context change refuses; a retry uses the same immutable barrier intent.

The interface does not prescribe extra positive native admission. Existing
hosted read admission/serving is independent of the policy's frozen-write flag;
rollback still needs the original owned CPP/provider context and receipt.

## Immutable local cancellation and closure

Only then atomically record a cancellation disposition and enter RollingBack/20.
Keep the original action at settled=0 with its original checkpoint/fingerprint;
exclude it only through the canonical active-pending view. Bind the disposition
digest to original run/action/context, before/after checkpoints and barrier proof.
Invalidate old RAM custody/tickets; leave unrooted objects intact. No positive
AppendBase settlement is manufactured. Require actual storage.sync confirmation.

Operator intents:

```json
{"collection":"<uuid>","operation":"abort-appendbase","expected_run_sequence":1,"expected_action_sequence":186}
{"collection":"<uuid>","operation":"resolve-appendbase-abort","expected_run_sequence":1,"expected_action_sequence":186}
```

The latter reconciles an already-recorded cancellation after lost ACK; it cannot
create one or resend the external barrier. Exact currentness and physical ACK
are required before scheduling the ordinary receipt-backed Unfence continuation.
A recorded cancellation at step20 is not closure. Only the original valid
rollback receipt permits RolledBack/21, fenced=false.

Proposed exact status addition, independent of the existing gen0_abort field:

```json
"appendbase_abort": null
```

or exactly:

```json
"appendbase_abort":{"sequence":186,"run_sequence":1,"disposition":"cancelled","digest":"<64 lowercase hex>"}
```

Absent means unsupported predecessor. Closure requires the four-field record
bound to native.run_sequence, checkpoint.step=21, fenced=false, outstanding=null
and quiescence. No barrier permission is inferred just from this status proposal.

## Rollout and compatibility

Receipted rollback requires the separately reviewed owner-namespace correction:
provider migration49/v2 routes before Connect #878, with no v1 fallback or
provider downgrade beneath v2 consumers/receipts. Native warm-Driver repair
#911 is a separate prerequisite for reliable same-instance recovery.

Make the CP barrier routes available before this native consumer. An old CP
refusal is not permission to synthesize a barrier. Older status readers see the
new cancellation capability as unsupported, never as an empty positive proof.
Do not downgrade a native writer after it has recorded an AppendBase
cancellation: the predecessor does not validate that disposition/publication
proof. Recovery writers must understand both immutable cancellation tables and
the canonical pending projection. No historical action or intent is translated.

These changes authorize neither deployment nor a live recovery. Only the
original receipted rollback and physical acknowledgement can establish closure.

## G6 recommendation

Do not attach a fresh hold or reopen S0 into retained checkpoints after the
original hold lapses. Recovery is receipt-backed rollback; a subsequent fresh
migration needs a new explicitly supplied hold and separately qualified target.
The current restart reuses the old hold and cannot solve expiry. Assess an early
closed refusal rather than creating a doomed restarted run; do not silently renew
custody, substitute a snapshot or extend the original run's deadline.
