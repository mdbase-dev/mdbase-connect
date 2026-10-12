# LAB migration run and route-back

`next-migration-lab` (`services/server/src/features/next/migration-lab-cli.ts`) drives one
[tiny LAB fixture](lab-fixture-migration-start.md) account through its hosted migration,
or routes it back before cutover. It refuses to start unless `MDBASE_CONNECT_ENVIRONMENT`
is exactly `lab`, and the account must have started with the `lab-fixture-v1` profile.

```sh
pnpm --filter @mdbase/connect-server next:migration-lab lab-run <account id> <backup hold id>
pnpm --filter @mdbase/connect-server next:migration-lab route-back <account id>
pnpm --filter @mdbase/connect-server next:migration-lab status <account id>
```

Environment: `DATABASE_URL`, `MDBASE_LEGACY_PROVIDER_DATABASE_URL` (the provider database
through its SELECT-only reader role), `MDBASE_CONNECT_HOSTED_PROVIDER_*`, `MDBASE_OPERATOR`,
`MDBASE_NEXT_TIMERS=1`, and `MDBASE_NEXT_HOSTED_SERVICE_URL` (https) with
`MDBASE_NEXT_HOSTED_SERVICE_TOKEN` for the hosted Worker's internal migration entry. The
backup hold is the in-force `hosted_provider_backup_holds` id taken by the operator.

Progress is one JSON line per step. An operator stop prints
`{"stopped":{"step","reason","inspect","resume"}}`, repeats it on stderr and exits 2. No
token, URL or error message is printed, only stable codes.

Every step is derived from durable state (the Worker's run record and native checkpoint,
and control-plane rows), so running the same command again resumes where it stopped.
After an unknown outcome a mutation is never sent again; a rerun reads state first.

## lab-run

1. **preflight**: the account is in a released, frozen cohort, started with the LAB
   profile, not excluded, and has exactly one settled hosted collection. An account
   already on the next backend skips to step 7.
2. **worker_run**: `POST /internal/v1/migration/run {collection, backup_hold}`. A lost
   reply is resolved by reading the run back. A run with another hold stops.
3. **worker_status**: poll `POST /internal/v1/migration/status` with capped backoff
   (1 s doubling to 30 s, two hours in total). The Worker fences, drains, imports,
   revokes and records the cutover through Connect itself.
4. **import_timers**: once the native checkpoint is fenced and drained, run the strict
   paged timer import (`next-timers copy-hosted`) for the collection. It is idempotent.
5. **cutover**: when the run is done and routed, the cutover must be recorded and legacy
   `migrated`. A recorded cutover whose legacy source is still `migrating` gets the same
   cutover retried, which starts retention.
6. **flip**: the account flip with the timer gate, environment `lab`.
7. **verify_completion**: the cohort's `next_migration.lab_complete` event exists and the
   completion readback (`requireCompletedAccountMigration`) accepts the account.

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

## route-back

Pre-cutover only. Each Worker effect goes through the native operator entry
(`POST /internal/v1/migration/operator {collection, operation, expected_run_sequence |
expected_action_sequence}`), bound to the sequence the status reported.

| Observed | Decision |
|---|---|
| run `stopped`/`done` before cutover intent, nothing outstanding | `rollback` with the current run sequence, then wait |
| outstanding `Unrevoke` or `Unfence` (lost rollback reply) | `resolve` it; the Worker settles it from the provider's rollback receipt |
| any other outstanding action | stop (`outstanding_unknown:<kind>`) |
| checkpoint `rolled_back` | LAB timer cleanup for the rolled-back provider run, then `restart` with the current run sequence |
| `rolling_back` while stopped (for example `rollback_needs_operator`) | stop |
| cutover intent or later, failed or gone | stop |
| run `running`/`waiting` while rolling back | wait |
| a later run (sequence above 1, or the restart just made) | wait until it has fenced again, then done |
| the first run still `running` | stop (`migration_run_active`) |
| status without a run sequence | stop (`run_sequence_unavailable`) |
| timer cleanup refusal (`timer_cleanup_drifted`, `migration_rollback_not_settled`, `migration_rollback_binding_conflict`, ...) | stop before any restart |
| operator reply refused or lost, or the same operation needed twice | stop |

When route-back is done it prints the `lab-run` command that continues the restarted run.
