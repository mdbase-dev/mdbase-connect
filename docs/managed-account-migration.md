# Managed whole-account migration

The managed account driver supports 1–16 held hosted collections for beta.142.
`lab-run` is the existing entry point. The account's one recorded
`next_migration.start`, written only by the control plane's start transition,
selects the job; no caller flag, subcommand or environment alone selects it. An
ordinary archived start (no profile) uses managed orchestration in LAB, staging
and production. The deployment's own environment, origin and credentials still
admit the job independently. Live ordinary-path LAB qualification, independent
SQL/durability review, and production qualification remain pending.

The driver reads the complete sorted distinct set of owned hosted rows except
`transferred`. Transferred rows remain history and are never migrated or cleaned
up by this driver. An ordinary hosted→local promotion leaves the same id as the
owner's active local collection under a connector. Start, capture, flip and
completion do not read or change that local row, and migration routing serves
only held members, so the local collection and any later cloud copy of it keep
the control plane's default route. Importing, transferring, quarantined, or deleted held members
block the entire account. An empty held set, including an all-transferred
account, returns `managed_inventory_empty`: the separately admitted zero-hosted
archive/start/flip path remains responsible for those accounts. The hosted driver
never fabricates an empty migrated array. The 16-member bound does not expand
Ops wave limits or account-wide row, byte, timer, and archive budgets.

The driver runs in two phases. Every member's original Worker run is dispatched
in pause mode, so by itself it can only reach the verified, fenced pre-cutover
pause (native step 8, before revoke/cutover intent). Phase 1 prepares each
member's canonical SHADOW target, dispatches or reconciles its original run,
polls it through drain and verification, imports its original timers and waits
at that pause. Only when every member is at the pause does phase 2 start: for
each member in order the driver sends the sequence-bound resume, waits for the
route, re-imports its timers and confirms its recorded cutover and legacy
retention. It then calls the existing array-capable account flip once with the
complete array and the digest of all recorded cutovers. A failure before the
first resume is therefore pre-cutover for the whole set; after it, the driver
only moves forward. The flip transaction still checks whole-set equality, authority,
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

- `next_migration.managed_run` binds `binding: "two-phase-v1"`, the original
  complete collection array, backup hold, the operator's
  `operator_stop_before_flip` intent and the CP start time in microseconds. It is
  immutable for that account's migration. Retries reject changed sets, holds or
  intent. The Worker's pause mode is not part of the operator intent: it is
  always on for a managed run.
- `next_migration.worker_run_intent` reserves one original dispatch per member
  under the existing account row lock and records `worker_pause: true`. Its
  transaction commits before the Worker call. Concurrent invocations cannot
  both reserve the same dispatch.

An unversioned binding (`{collections, backup_hold, stop_before_flip,
started_us}`, where the Worker's pause mode followed the operator flag) is never
reinterpreted. Every command refuses it with `managed_run_legacy_binding`, and
`status` reports that refusal with the held set. This change never wrote one,
but its absence from a deployed database cannot be proven from source.

Run binding and dispatch reservation lock the account row `FOR NO KEY UPDATE`.
That still serializes with start, flip, topology, hosted creation and deletion,
but not with the foreign-key `KEY SHARE` check of a writer that locked a hosted
row first (for example hosted approval), so the two cannot deadlock.

A managed retry reads every member's Worker status before launching anything,
and derives the phase from it. A member that consumed its resume, a member at
or past Worker cutover intent, or a recorded cutover means phase 2: every
invocation, `lab-run` or `resume`, only moves forward. A visible run must match
the original hold and be in pause mode. With a durable launch intent and no
visible Worker run, the driver stops at `worker_run_outcome_unknown` before
target preparation; it never resends `Worker.run`. A crash between intent commit
and dispatch therefore also stops for reconciliation. An unknown CP commit stops
before dispatch. There is deliberately no automatic reset or replay command.

In phase 2 a rerun of `lab-run <account> <original-hold>` or `resume <account>`
reconciles every original member, including ones already routed to NEXT. Routed
members do not re-enter target creation, replace service keys, or rerun their
Worker launch or resume. A lost resume reply stops; the rerun finds the run
resumed and does not resend it. Cutover and timer evidence are reconfirmed
before the single flip. Whole-account source capture/start is not repeated
after cutover; the accepted original archive and its source fences remain in
place. Existing provider/Worker paths retain their own original-source checks.

With `--stop-before-flip`, `lab-run` returns `operator_pause_before_cutover`
at the shared barrier: every member paused, timers imported, nothing cut over.
`resume` crosses the barrier only from a complete pause pass; otherwise it stops
with `managed_pause_incomplete` and changes nothing, and rerunning `lab-run`
with the same flag completes the pass. Without the flag, `lab-run` crosses the
barrier itself.

`status` reports every held member, its CP cutover, whether it has a durable
dispatch intent and its Worker outcome, including UNKNOWN. When admission
refuses (an unsettled member, a changed set, an invalid or legacy binding) it
still lists the set and reports the refusal code; `collections_unsettled` and
`collections_mismatch` carry bounded `details` (member UUIDs with a predicate,
or added/missing UUIDs).

`route-back` inspects the complete set before mutating any member:

- a recorded cutover or a Worker at or past cutover intent refuses the entire
  command with `migration_post_cutover`, preserving routed serving custody;
  partial cutover is forward only;
- a durable dispatch intent with no visible run refuses the entire command with
  `worker_run_outcome_unknown`;
- a member with no run, no native checkpoint or outstanding action and no intent
  was never dispatched: it is left untouched and listed in `not_dispatched`
  (`managed_nothing_dispatched` if that is every member);
- every other member is rolled back through the Worker's sequence-bound
  rollback (the CP's receipted rollback route), and its imported timers are
  removed once the legacy source is active again.

A start whose accepted archive is scoped (`mdbase-recovery-set/scoped-hosted-v1`)
can only ever take its archived original fence: once the source is restored the
CP refuses it with `migration_archive_source_changed`, so a restarted run could
never fence again. Route-back therefore does not restart such members and ends
with `disposition: "fresh_attempt_required"`. The account stays on legacy, its
rolled-back runs are terminal for the binding, and a never-dispatched member
keeps its original pre-archive fence. Other archives keep the existing restart
and re-fence.

## Known gaps

- An intent with no visible run cannot be resolved: the Worker has no CP-minted
  dispatch identity or exactly-once admission to prove the original dispatch
  never took effect. Such an account stays stopped.
- After a scoped route-back, continuing needs a whole-account fresh attempt:
  restoring never-dispatched pre-archive-fenced members, retiring the original
  attempt with durable evidence, and a fresh archive, start and Worker run. None
  of this exists yet.
- A phase 2 Worker stop with an unsettled forward action (an outstanding
  non-rollback action) has no driver operation to settle it; the account stays
  stopped forward-only, as a singleton run would.

## Operator output and qualification boundary

Managed completion is `{done:{account_id,collection_ids,backend:"next",
migration_complete:true}}`, where `collection_ids` is the complete sorted array.
Managed member progress and stops include `collection_id`; account stops also
include `collection_ids` and `phase` (`prepare` before the barrier, `cutover`
after it). Status and route-back return explicit per-member arrays. Ops must consume this managed completion shape, retaining its fixed
pre-hold multi-collection gate until the product implementation ships and its
separate qualification is accepted.

A `lab-fixture-v1` start keeps the singleton fixture job only in a LAB
deployment or the explicit local build. Its output remains
`{done:{account_id,collection_id,backend:"next",lab_complete:true}}`, and its
preflight still requires exactly one settled collection. A missing, repeated or
unrecognized start, or a fixture start in staging or production, stops with
`start_profile_invalid`. Run binding and each original dispatch reservation
re-read the same recorded start under the account row lock. Ordinary starts
already required the cohort's current accepted archive, and their completion
readback accepts only that archive: the LAB completion event applies only to a
bound fixture start. Ops' ordinary LAB start and admission are coordinated
separately; a fixture run is not managed-array qualification.

Hermetic coverage uses the real PostgreSQL adapter, archive/start intake, timer
snapshot importer, cutover/retention, combined flip SQL, the CP's fence, source
and receipted rollback routes, timer cleanup and strict terminal readback, with
synthetic archive metadata and a modeled pause-mode Worker that calls those
routes. It covers the two-phase order (no cutover before the last member's
pause), a one-member ordinary LAB start, transferred history, all-transferred
refusal, phase 1 failure with whole-set route-back through the real rollback
route and the refused re-fence, a never-dispatched member left untouched,
intent-without-run UNKNOWN, phase 2 interruption and lost resume replies
completing forward, a phase 2 Worker stop that route-back refuses, the legacy
binding refusal, bounded unsettled details, the account-lock/foreign-key
deadlock case, subset/duplicate refusal, pause/resume, timer-source changes and
the 16/17 boundary. Several cases run as ordinary LAB starts. Fixture and ordinary LAB accounts share one adapter, and
missing, repeated, unknown and cross-environment starts refuse. Transferred
history has the promoted local row and connector an ordinary promotion leaves,
and routing is checked for held members, that history, a later cloud copy of it
and a native cloud copy, after start, at the pause and after the flip. It proves
these control-plane contracts, not native/Worker execution, cloud custody,
archive signature verification, deployed provider parity or live qualification.
