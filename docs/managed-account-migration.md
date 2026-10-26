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
complete array and the digest of all recorded cutovers. Before its first resume,
phase 2 commits the account's one-way cutover latch (below). A failure before that
latch is pre-cutover for the whole set; after it, the driver only moves forward,
even if no resume is known to have arrived. The flip transaction still checks whole-set equality, authority,
provider run, timer manifests and target identities, starter reservation, and
cohort completion. A member failure or UNKNOWN leaves the account on legacy.
A changing timer source retries the bounded idempotent import; a flip's
`timers_source_changed` refreshes every member's manifest before retrying the
combined flip. No archive, hold, source, provider, epoch or flip guard is waived.

## Durable progress and recovery

No new tables or SQL migrations are needed. Existing Worker rows retain native
run/checkpoint/outstanding-action state; `next_migration_collections` retains
cutovers. Four new event types in the existing durable `audit_events` ledger
(read and written by `migration-managed-ledger.ts`) prevent a process restart
from replaying an original ambiguous launch and keep rollback and resume apart:

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
- `next_migration.managed_cutover` and `next_migration.managed_route_back` are the
  account's one-way phase latch (metadata: binding, hold, start time). Phase 2
  commits the cutover latch before its first resume; route-back commits the
  route-back latch before its first rollback. Each is written under the account
  row lock and refuses while the other exists (`managed_cutover_started`,
  `managed_route_back_started`); rewriting the same one is a no-op. A dispatch
  reservation refuses under either latch.

The latch closes a whole-account race that per-member Worker serialization
cannot: a resume whose reply was lost may still be in flight. If route-back
judged only current cutover rows and Worker status, that resume could arrive
after its checks, so one member cut over while a sibling rolled back, and a
scoped archive's original fence cannot be retaken. With the latch, no resume is
sent unless the cutover latch committed first, and route-back then refuses.
Conversely, once route-back has latched, `lab-run` and `resume` stop at
preflight with `managed_route_back_started` and send nothing, so route-back
continues alone.

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
and derives the phase from it. The cutover latch, a member that consumed its
resume, a member at or past Worker cutover intent, or a recorded cutover means
phase 2: every invocation, `lab-run` or `resume`, only moves forward. A visible run must match
the original hold and be in pause mode. With a durable launch intent and no
visible Worker run, the driver stops at `worker_run_outcome_unknown` before
target preparation; it never resends `Worker.run`. A crash between intent commit
and dispatch therefore also stops for reconciliation. An unknown CP commit stops
before dispatch. There is deliberately no automatic reset or replay command.

In phase 2 a rerun of `lab-run <account> <original-hold>` or `resume <account>`
reconciles every original member, including ones already routed to NEXT. Routed
members do not re-enter target creation, replace service keys, or rerun their
Worker launch or resume. A lost resume reply stops; the rerun finds the run
resumed and does not resend it. A Worker whose cutover (Route) reply was lost
retries the same idempotent CP cutover while it still holds that action's
ticket. Cutover and timer evidence are reconfirmed before the single flip. Whole-account source capture/start is not repeated
after cutover; the accepted original archive and its source fences remain in
place. Existing provider/Worker paths retain their own original-source checks.

With `--stop-before-flip`, `lab-run` returns `operator_pause_before_cutover`
at the shared barrier: every member paused, timers imported, nothing cut over.
`resume` crosses the barrier only from a complete pause pass; otherwise it stops
with `managed_pause_incomplete` and changes nothing, and rerunning `lab-run`
with the same flag completes the pass. It then imports every member's timers
(the same idempotent importer) before the cutover latch, so a failed import
stops before any latch or resume. The binding, every dispatch reservation and
the cutover latch recheck, under the account lock and before they commit, that
the held set still matches and every member is still eligible
(`collections_mismatch`, or `collections_unsettled` with each member's
predicate); the held rows stay share-locked until that commit. Without the flag, `lab-run` crosses the
barrier itself.

`status` reports every held member, its CP cutover, whether it has a durable
dispatch intent and its Worker outcome, including UNKNOWN. When admission
refuses (an unsettled member, a changed set, an invalid or legacy binding) it
still lists the set and reports the refusal code; `collections_unsettled` and
`collections_mismatch` carry bounded `details` (member UUIDs with a predicate,
or added/missing UUIDs).

`route-back` inspects the complete set before mutating any member:

- a cutover latch refuses the entire command with `managed_cutover_started`
  before any Worker read, as does a member that consumed a resume without one;
- a recorded cutover or a Worker at or past cutover intent refuses the entire
  command with `migration_post_cutover`, preserving routed serving custody;
  partial cutover is forward only;
- a durable dispatch intent with no visible run refuses the entire command with
  `worker_run_outcome_unknown` until the intent is older than 420 s on the
  database clock (the Worker's 300 s held-ticket deadline, its 60 s run request
  timeout and a 60 s margin); after that it counts as never dispatched;
- a member with no run, no native checkpoint or outstanding action (and no
  recent intent) was never dispatched: it is restored through the canonical
  started-claim unfence (`next_migration.unfence`) and listed in
  `not_dispatched`; an unscoped account with nothing dispatched and no intent
  stops with `managed_nothing_dispatched` and changes nothing;
- every other member is rolled back through the Worker's sequence-bound
  rollback (the CP's receipted rollback route), and its imported timers are
  removed once the legacy source is active again. A run that rolled back before
  its Fence never unfenced, so its source is then restored like a
  never-dispatched one.

That unfence is bound to the accepted original archive fence: a still-fenced
source must be exactly that fence (`migration_archive_source_changed`
otherwise), and an observed later run is never adopted. An already active source
must be settled (no run, start or retention), though its head may have moved. A
scoped account route-back directly after its start, before any binding, latches
on the recorded start and the exact eligible held set, without inventing a hold
or binding.

If anything needs restoring (a dispatched member, an intent, or a scoped
archive, whose sources are fenced since the archive), route-back first commits
its latch (losing to a cutover latch refuses as above), then inspects the whole
set again under it with fresh Worker reads: no dispatch reservation or resume
can begin after the latch, and from then on the CP fence route refuses every
member with `managed_route_back_started` (`collection_id`, predicate
`route_back_latch`), so an original run that arrives late cannot fence. Reads,
rollback and unfence are unaffected. The second inspection is the one that
acts. A repeated route-back finds its latch and inspects once.

A managed route-back is terminal for the attempt and never restarts a member: it
ends with `disposition: "legacy_post_bulk_follow_up"`, the account on legacy and
every member's source verified active (rolled back or unfenced); it is never
done while any source is unverified. A start whose accepted archive is scoped
(`mdbase-recovery-set/scoped-hosted-v1`) can only ever take its archived original
fence: once the source is restored the CP refuses it with
`migration_archive_source_changed`, so a restarted run could never fence again.
For other archives a restart would re-fence the source, but under the route-back
latch nothing could resume it, and without the latch a failed restart beside a
cut-over sibling would strand the account. Its rolled-back runs are terminal for
the binding; the account stays legacy and its `next_migration.managed_route_back`
latch event puts it on the post-bulk follow-up list.
The fixture job keeps the restart and re-fence.

## Re-arm after route-back

`next-migration-lab re-arm <account>` lets a routed-back managed account migrate
again through a fresh attempt. It re-runs the idempotent route-back, requires
every member's Worker idle (no run, or stopped/done at RolledBack, unfenced,
nothing outstanding) and then re-arms in the CP: a fresh provider read must
show every held source settled active, and one transaction under the account
lock (`migration-rearm.ts`) refuses unless the account is legacy, its started
member is not excluded, the route-back latch is recorded and no cutover latch,
collection row or flip exists, the held set matches the bound run, and every
dispatch intent is quiet or settled by a run under the attempt's hold that the
driver observed idle. It then records the account, previous cohort, start and
held set in `next_migration_rearms` (migration 0087) together with the
attempt's ledger events (start, run binding, dispatch intents, phase latch),
deletes the member row and audits `next_migration.rearm`. A replay returns the
recorded re-arm with `already_rearmed: true`.

Every ledger read then ignores the retired events, so the account is a legacy
account in no cohort. The next attempt needs a new cohort, archive, acceptance
and start; the old archive is never adopted, and `add` never re-adds the
account to its old cohort. The old cohort keeps counting the account from the
history row with its recorded collections, so its revision, membership digest
and accepted archive stay current and its completion counts it. Its receiving
and capture snapshots refuse a re-armed member.

The Worker DOs keep the old rolled-back runs. For a re-armed account the
driver treats a run under an earlier hold that is stopped/done at RolledBack,
unfenced and with nothing outstanding as not dispatched. The Worker's `run`
with the new hold supersedes such a run and natively starts a new run for the
strictly newer start; anything else is still `migration_run_exists`. The
supersede is also refused when the target can no longer import generation 0:
a run rolled back after its `base` reached the log (step 4 `BaseAppended` or
later) leaves that base there, and hosted migration is fence-first with no
replay of a later legacy difference, so a fresh run could only fence legacy and
then stop.

## Known gaps

- `lab-run` and `resume` never resolve an intent with no visible run; only
  route-back does, after the quiet period. The CP cannot read provider holds;
  the route-back fence refusal, not hold release, is what stops a late run.
- A routed-back account stays legacy until an operator re-arms it (above).
  Re-arm needs the hosted Worker that supersedes a rolled-back run; with an
  older Worker the fresh attempt stops at `worker_run` with
  `migration_run_exists` for every member that was dispatched before.
- An account with a member whose earlier run appended its `base` cannot
  migrate again through re-arm: that member's fresh run answers
  `migration_run_exists` before any change. Before planning a fresh attempt,
  check the earlier attempt's evidence for a member whose last native
  `checkpoint_step` was 4 or more; such an account stays legacy.
- A phase 2 Worker stop with an unsettled forward action (an outstanding
  non-rollback action, or a Route whose ticket was already released) has no
  driver operation to settle it; the account stays stopped forward-only, as a
  singleton run would. Escalate.

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
route and the refused re-fence, never-dispatched members unfenced (and a late
fence refused), intent-without-run UNKNOWN until its quiet period, phase 2
interruption, lost resume and Route replies and a failed last-member import
completing forward, a first resume that has not yet arrived (route-back refuses;
its late arrival completes the set), both latch races (route-back after its
inspection, phase 2 after its preflight), latch mutual exclusion under a held
account lock, re-inspection under the route-back latch, a phase 2 Worker stop
that route-back refuses, the legacy
binding refusal, bounded unsettled details, the account-lock/foreign-key
deadlock case, subset/duplicate refusal, pause/resume, timer-source changes and
the 16/17 boundary. Several cases run as ordinary LAB starts. Fixture and ordinary LAB accounts share one adapter, and
missing, repeated, unknown and cross-environment starts refuse. Transferred
history has the promoted local row and connector an ordinary promotion leaves,
and routing is checked for held members, that history, a later cloud copy of it
and a native cloud copy, after start, at the pause and after the flip. It proves
these control-plane contracts, not native/Worker execution, cloud custody,
archive signature verification, deployed provider parity or live qualification.
