# Managed whole-account migration

The managed account driver supports 1–16 held hosted collections for beta.142.
Deployment configuration selects managed orchestration for staging and production;
`lab-run` is the existing entry point. No caller flag selects this capability.
Live ordinary-path LAB qualification, independent SQL/durability review, and
production qualification remain pending.

The driver reads the complete sorted distinct set of owned hosted rows except
`transferred`. Transferred rows remain history and are never migrated or cleaned
up by this driver. Importing, transferring, quarantined, or deleted held members
block the entire account. An empty held set, including an all-transferred
account, returns `managed_inventory_empty`: the separately admitted zero-hosted
archive/start/flip path remains responsible for those accounts. The hosted driver
never fabricates an empty migrated array. The 16-member bound does not expand
Ops wave limits or account-wide row, byte, timer, and archive budgets.

Every member uses the same per-collection behavior: prepare its canonical SHADOW
target, dispatch or reconcile its original Worker run, poll through drain and
verification, import its original timers, and confirm its recorded cutover and
legacy retention. After all members succeed, the driver calls the existing
array-capable account flip once with the complete array and the digest of all
recorded cutovers. Its transaction still checks whole-set equality, authority,
provider run, timer manifests and target identities, starter reservation, and
cohort completion. A member failure or UNKNOWN leaves the account on legacy.
A changing timer source retries the bounded idempotent import; a flip's
`timers_source_changed` refreshes every member's manifest before retrying the
combined flip. No archive, hold, source, provider, epoch or flip guard is waived.

## Durable progress and recovery

No new tables or SQL migrations are needed. Existing Worker rows retain native
run/checkpoint/outstanding-action state; `next_migration_collections` retains
cutovers. Two new event types in the existing durable `audit_events` ledger
prevent a process restart from replaying an original ambiguous launch:

- `next_migration.managed_run` binds the original complete collection array,
  backup hold, pause intent, and CP start time in microseconds. It is immutable
  for that account's migration. Retries reject changed sets, holds or intent.
- `next_migration.worker_run_intent` reserves one original dispatch per member
  under the existing account row lock. Its transaction commits before the
  Worker call. Concurrent invocations cannot both reserve the same dispatch.

A managed retry reads Worker status before launching anything. A visible run
must match the original hold and pause intent. With an existing launch intent
and no visible Worker run, recovery stops at `worker_run_outcome_unknown`; it
never resends `Worker.run`. A crash between intent commit and dispatch therefore
also stops for reconciliation. An unknown CP commit stops before dispatch.
There is deliberately no automatic reset or replay command.

A rerun of `lab-run <account> <original-hold>` or managed `resume <account>`
reconciles every original member, including ones already routed to NEXT. Routed
members do not re-enter target creation, replace service keys, or rerun their
Worker launch. Their cutover and timer evidence are reconfirmed before the
single flip. Whole-account source capture/start is not repeated after cutover;
the accepted original archive and its source fences remain in place. Existing
provider/Worker paths retain their own original-source checks.

With `--stop-before-flip`, each member reaches the existing verified pre-cutover
pause and imports its timers. Only when all are paused does the account command
return the operator pause. Managed `resume` consumes each paused member's
sequence-bound resume intent and continues the same account run; an unknown
operator reply stops. A later member that had not started is prepared and driven
through the same pause/resume behavior.

`status` reports every held member, its CP cutover and its Worker outcome,
including UNKNOWN. `route-back` inspects the complete set before mutating any
member. Any recorded cutover or Worker cutover intent refuses the entire command
with `migration_post_cutover`, preserving routed serving custody. Before that
point, eligible members use the existing per-collection rollback, timer cleanup,
restart and refence behavior. Partial cutover requires forward reconciliation.

## Operator output and qualification boundary

Managed completion is `{done:{account_id,collection_ids,backend:"next",
migration_complete:true}}`, where `collection_ids` is the complete sorted array.
Managed member progress and stops include `collection_id`; account stops also
include `collection_ids`. Status and route-back return explicit per-member
arrays. Ops must consume this managed completion shape, retaining its fixed
pre-hold multi-collection gate until the product implementation ships and its
separate qualification is accepted.

LAB fixture output remains `{done:{account_id,collection_id,backend:"next",
lab_complete:true}}`; fixture preflight still requires exactly one settled
collection and a `lab-fixture-v1` start. Local rehearsal builds retain that
fixture contract. Ordinary managed starts cannot use it as an archive bypass.
Guarded ordinary-path LAB admission must be coordinated separately; current LAB
fixture admission is not real managed-array qualification.

Hermetic coverage uses the real PostgreSQL adapter, archive/start intake, timer
snapshot importer, cutover/retention, combined flip SQL and strict terminal
readback with synthetic archive metadata and a scripted Worker. It covers two
active members, transferred history, all-transferred refusal, second-member
failure/UNKNOWN, no launch replay, partial-cutover resume, subset/duplicate
refusal, pause/resume, timer-source changes and the 16/17 boundary. It proves
these control-plane contracts, not native/Worker execution, cloud custody,
archive signature verification, deployed provider parity or live qualification.
