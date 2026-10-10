# Hosted migration provider fronts

The dedicated migration token can call these bounded, audited control-plane routes:

- `GET /internal/v1/next/migration/collections/:id/source`: exact provider lifecycle,
  migration run, head, hold/retention timestamps and journal counters.
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

## Deliberately not exposed yet

No SHADOW creation, backup hold acquisition/renewal, revocation, rollback, Base or
cutover append, target serving, routing or account flip is added by these fronts.
A rollback must have a durable pre-CutoverIntent barrier and perform provider
active+restore in one transaction. After a lost rollback reply, active state alone
cannot prove which replicas were restored: exact run-owned receipt/lookup evidence
is required, otherwise the result stays UNKNOWN. Never invoke standalone restore
after unfreeze or infer readiness from HTTP acceptance.

The LAB archive capture/verifier/acceptance profile and supported one-collection
operator remain separate prerequisites. Local synthetic PostgreSQL tests exercise
claim races and typed mocked provider replies, not managed migration qualification.
