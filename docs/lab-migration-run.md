# LAB migration run and route-back

`next-migration-lab` (`services/server/src/features/next/migration-lab-cli.ts`) drives one
account through its hosted migration, or routes it back before cutover. It refuses to
start unless the deployment's own `MDBASE_CONNECT_ENVIRONMENT` is exactly `lab`, `staging`
or `production`, with its fixed Connect origin. Local deployments require the separate
explicit local build. The account's single recorded `next_migration.start` selects the
job. A [tiny LAB fixture](lab-fixture-migration-start.md) start (`lab-fixture-v1`, LAB or
the explicit local build only) keeps the singleton fixture job. An ordinary archived start
(no profile) uses the [managed whole-account job](managed-account-migration.md) in LAB,
staging and production, and the flip completes the cohort only on its accepted archive
(managed runs never write the LAB completion event). A missing, repeated or unrecognized
start, or a fixture start outside LAB, stops with `start_profile_invalid`.
Production admission here is not deployment readiness: the independent authenticated
Worker target/publication, archive, custody and migration-routing gates must also admit
the deployment. Missing or unresolved production bindings remain a refusal.

```sh
pnpm --filter @mdbase/connect-server next:migration-lab lab-run <account id> <backup hold id> [--stop-before-flip]
pnpm --filter @mdbase/connect-server next:migration-lab resume <account id>
pnpm --filter @mdbase/connect-server next:migration-lab route-back <account id>
pnpm --filter @mdbase/connect-server next:migration-lab status <account id>
```

Environment: `DATABASE_URL`, `MDBASE_LEGACY_PROVIDER_DATABASE_URL` (the provider database
through its SELECT-only reader role), `MDBASE_CONNECT_HOSTED_PROVIDER_*`, `MDBASE_OPERATOR`,
`MDBASE_NEXT_TIMERS=1`, and `MDBASE_NEXT_HOSTED_SERVICE_URL` (https) with
`MDBASE_NEXT_HOSTED_SERVICE_TOKEN` for the hosted Worker's internal migration entry. The
backup hold is the in-force `hosted_provider_backup_holds` id taken by the operator.
Every command checks the existing `PUBLIC_URL` before opening either database: exactly
`https://connect-lab.mdbase.dev` in LAB, `https://connect-staging.mdbase.dev` in staging,
and `https://connect.mdbase.dev` in production. No arbitrary origin selector is accepted.
`lab-run` additionally uses `MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN` to call the canonical migration target
creator before the first Worker Run POST. That creator installs the SHADOW cloud
copy, immutable hosted/escrow service-device records and appended original genesis.
It does not grant serving/H1 authority or flip the account. Provisioning failure
stops at `prepare_target` without a Worker Run; custody lookup remains unchanged.

For the coordinator-selected LAB rehearsal exception only, the CLI child may set
`MDBASE_LEGACY_PROVIDER_LAB_OWNER_READONLY_ROLE` to the exact owner identity from
an approved probe/custody handoff. It must match the protected source URI username;
there is no automatic role detection or fallback to the control `DATABASE_URL`.
The URI must use the exact internal LAB host, explicit 5432, database and captured
certificate pin, with `options=-cdefault_transaction_read_only%3Don`. The existing timer importer
opens one `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` snapshot, explicitly
sets `SET TRANSACTION READ ONLY`, then commits/releases it before reading the fresh
provider watermark. No parallel source adapter or long polling transaction is added. This option admits only ordinary
`lab-run` (no pause/resume/route-back), never staging/production. Dedicated SELECT-only
readers remain the staging/production requirement. Remove the exception after the
dedicated-reader rehearsal is qualified.

Progress is one JSON line per step. An operator stop prints
`{"stopped":{"step","reason","inspect","resume"}}`, repeats it on stderr and exits 2. No
token, URL or error message is printed, only stable codes. Initial Worker RUN replies
are recorded before status reconciliation. For `migration_run_ready_failed` only,
`worker_run_reply` includes finite `worker_error_stage`, `worker_error_name`, and
`worker_error_detail_code` from ready-stage wire v1. Missing/unrecognized stage or
code becomes `unknown`, and name becomes `other`; unrelated replies have null
fields. These labels identify a throwing boundary, not proof earlier effects were
absent. HTTP500 remains UNKNOWN; this diagnostic never authorizes a retry.

On literal LAB only, ready/run HTTP500 replies may include `raw_error` with
`message` and `stack` (strings or null). Set
`MDBASE_LAB_MIGRATION_RAW_ERROR_FILE` to a fresh file inside an existing owned
mode-700 directory to capture it. The CLI exclusively creates a mode-600 file,
without following a final symlink or replacing an earlier capture. The file's
JSON includes `raw_error` and finite reply provenance, bounded to 64 KiB including
the newline. Raw data is removed from progress stdout and the final stop result;
stdout reports only `raw_error_capture_status` (`saved`, `failed`, or `disabled`).
Capture failure never retries a RUN or changes its UNKNOWN/status reconciliation.
The rehearsal runner carries this private file only in its encrypted receipt;
operator reports retain a private-artifact pointer, not the raw contents.

Target preparation failures use the same private capture path. A literal-LAB
`target_reply` event carries `raw_error.sub_cause`: the failed guard name, finite
fetch error name/network code, HTTP status plus allowlisted API error code, or a
bounded Zod field/index path and identity-mismatch field. It never includes URLs,
tokens, response values, exception messages or stacks. Constructor guard checks
are recorded at `prepare_target` before any fetch. The returned library stop has
`target_reply.raw_error`; CLI progress and final stdout remove it, reporting only
the existing capture status. Unrecognized API/network codes become `unknown`.
Non-LAB orchestration retains/captures no target sub-cause. There is still one
request and no retry, native readiness, H1 or mutation-effect-absence inference.

Every step is derived from durable state (the Worker's run record and native checkpoint,
and control-plane rows), so running the same command again resumes where it stopped.
After an unknown outcome a mutation is never sent again; a rerun reads state first.

## lab-run

1. **preflight**: the account is in a released, frozen cohort, started, and not
   excluded. A fixture start needs exactly one settled hosted collection; an ordinary
   start runs the managed job over its held set (see
   [Managed accounts](#managed-accounts)). An account already on the next backend
   skips to step 7.
2. **prepare_target**, then **worker_run**: create/reuse the canonical SHADOW target
   through `POST /internal/v1/next/migration/collections/:id/target` before opening
   Worker custody. An already-recorded NEXT cutover retains its original target
   on a routed-but-not-flipped rerun. Then `POST /internal/v1/migration/run {collection, backup_hold}`. A lost
   reply is resolved by reading the run back. A run with another hold stops.
3. **worker_status**: poll `POST /internal/v1/migration/status` with capped backoff
   (1 s doubling to 30 s, two hours in total). The Worker fences, drains, imports,
   revokes and records the cutover through Connect itself. Each time the status
   changes, stdout gets one `worker_timeline` line:
   `{step, t_ms, state, reason, checkpoint_step, last_kind}`. `t_ms` counts from
   the start of the run, and `last_kind` is the kind of the last prepared action.
   Older Workers that leave out `run.last` print `null` for it.
4. **import_timers**: once the native checkpoint is fenced and drained, run the strict
   paged timer import (`next-timers copy-hosted`) for the collection. It is idempotent.
5. **cutover**: when the run is done and routed, the cutover must be recorded and legacy
   `migrated`. A recorded cutover whose legacy source is still `migrating` gets the same
   cutover retried, which starts retention.
6. **flip**: the account flip with the timer gate, using the deployment's own environment.
7. **verify_completion**: the completion readback (`requireCompletedAccountMigration`)
   accepts the account: a fixture start needs the cohort's `next_migration.lab_complete`
   event, an ordinary start the cohort's accepted archive.

| Observed | Decision |
|---|---|
| run `running`/`waiting`, before the drain | wait |
| run `running`/`waiting`, fenced and drained, timers not imported | import timers |
| run `done` at `routed` | cutover, flip, completion |
| run `stopped` with any reason (`outstanding_unknown:*`, `effect_unknown:*`, `settlement_*`, `connect_refused:*`, `source_refused:*`, `cutover_policy_refused:*`, `migration_members_*`, `gen0_*`) | stop |
| `rolling_back`, `rollback_needs_operator`, run `done` at `rolled_back` | stop; resume with `route-back` |
| failed or gone checkpoint, unreadable native state, no run, unknown run state | stop |
| status unreachable 5 times in a row | stop |
| timer import `timer_source_changed` | retry (up to 5 times) |
| flip `timers_source_changed` | re-import, then retry the flip (up to 5 times) |
| any other refusal or error at any step | stop |

## Managed accounts

An ordinary start runs the steps above per member in two phases. Every member's
Worker run is dispatched in pause mode (`stop_before_flip: true`), whatever the
operator flag. Phase 1 takes every member to the verified pause below with its
timers imported. Phase 2 then resumes, routes and cuts each over in turn, and
flips once. Stops carry `phase` (`prepare` or `cutover`) and `collection_ids`;
member stops add `collection_id`. Phase 2 starts by committing the account's
cutover latch, before the first resume: from then on every stop resumes with
`resume` (or the same `lab-run`) and route-back is no longer available, even when
no resume is known to have arrived. Once route-back has committed its own latch,
`lab-run` and `resume` stop and send nothing.

| Stop | Meaning |
|---|---|
| `managed_run_legacy_binding` | the account's run binding predates the two-phase driver; nothing is reinterpreted |
| `managed_pause_incomplete` | `resume` before every member reached the pause; rerun `lab-run` |
| `managed_phase_inconsistent` | phase 2 found a member neither at the pause nor past it, or phase 1 found one past it |
| `migration_pause_mode_conflict` | a member's Worker run is not in pause mode |
| `worker_run_outcome_unknown` | a durable dispatch intent with no visible run; nothing is resent |
| `managed_nothing_dispatched` | route-back found no dispatched member; rerun `lab-run` |
| `managed_cutover_started` | route-back after phase 2 began (cutover latch, or a member resumed); continue with `resume` |
| `managed_route_back_started` | `lab-run`/`resume` (or a dispatch reservation) after route-back began; continue with `route-back` |
| step `cutover_latch` / `route_back_latch` | the latch write failed or lost to the other latch; an unknown commit is resolved by `status` (`phase_latch`) |
| `collections_unsettled`, `collections_mismatch` | admission refusal, with bounded `details` (member UUIDs) |

## Verified H1 pause and resume

`lab-run ... --stop-before-flip` requests a hosted scheduling pause **after actual
native H1 verification (step 8), before preparation of revoke/cutover intent**.
This is not a CLI-only stop immediately before the account flip: by then native
cutover intent would already make route-back unsafe. Normal runs are unchanged.
The CLI imports drained timers, stops with `operator_pause_before_cutover`, and
prints `resume <account id>`; it does not call cutover or flip while paused.

Run intent is immutable for same-run retries. A conflicting pause mode refuses;
older Workers must not be treated as having accepted the option. The Worker
persists requested mode and the immutable run sequence whose pause was consumed.
Restart preserves requested mode but clears consumed resume intent for the fresh
run, so a previous run's resume cannot release the new run's pause.

`resume` requires legacy backend, exact stopped pause reason/mode, verified
checkpoint, no outstanding action, and an available native run sequence. It sends
one bounded operator request `{collection, operation:"resume", expected_run_sequence}`.
The Worker obtains a genuine owned CPP claim, checks physical binding and current
native state around actual `storage.sync()`, then saves continuation and arms its
alarm. SQL status is scheduling DATA, not effect or settlement authority; subsequent
native prepare still checks authority independently. Stale, duplicate or drifted
resume refuses. Lost output stops without retry or adoption. After a confirmed
resume the CLI continues using the original pause mode through cutover, flip and
completion. At the pause, `route-back` remains the supported alternative. For a
managed account, `--stop-before-flip` only decides whether `lab-run` returns at the
shared barrier, and `resume` crosses it for the whole set.

Deploy compatible hosted code before using the new option or resume command.
No new native ABI, action kind, KMS bypass or provider recovery behavior is added.

## route-back

Pre-cutover only. Each Worker effect goes through the native operator entry
(`POST /internal/v1/migration/operator {collection, operation, expected_run_sequence |
expected_action_sequence}`), bound to the sequence the status reported.

| Observed | Decision |
|---|---|
| run `stopped`/`done` before cutover intent, nothing outstanding | `rollback` with the current run sequence, then wait |
| outstanding `Unrevoke` or `Unfence` (lost rollback reply) | `resolve` it; the Worker settles it from the provider's rollback receipt |
| any other outstanding action | stop (`outstanding_unknown:<kind>`) |
| checkpoint `rolled_back` | Timer cleanup (as the deployment's LAB, staging or production environment) for the rolled-back provider run, then `restart` with the current run sequence (not for a managed account: done after cleanup) |
| `rolling_back` while stopped (for example `rollback_needs_operator`) | stop |
| cutover intent or later, failed or gone | stop |
| run `running`/`waiting` while rolling back | wait |
| a later run (sequence above 1, or the restart just made) | wait until it has fenced again, then done |
| the first run still `running` | stop (`migration_run_active`) |
| status without a run sequence | stop (`run_sequence_unavailable`) |
| timer cleanup refusal (`timer_cleanup_drifted`, `migration_rollback_not_settled`, `migration_rollback_binding_conflict`, ...) | stop before any restart |
| operator reply refused or lost, or the same operation needed twice | stop |

When route-back is done it prints the `lab-run` command that continues the restarted run.

A managed account is inspected whole first: the cutover latch or a resumed member
refuses everything (`managed_cutover_started`), as do a recorded cutover or a member
at cutover intent (`migration_post_cutover`) and a dispatch intent with no visible
run (`worker_run_outcome_unknown`). A never-dispatched member is left untouched and
listed in `not_dispatched`. If anything was dispatched, route-back commits its latch
and inspects the whole account again before the first rollback. A managed route-back
is terminal for the attempt whatever the archive kind: no member is restarted, the
legacy sources stay active, and the result carries `disposition:
"fresh_attempt_required"` instead of a `lab-run` command; see
[managed accounts](managed-account-migration.md#known-gaps).
