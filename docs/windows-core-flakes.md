# Windows core merge-queue flakes

Read-only audit: `gh run list --workflow 'Server CI' --limit 50` and
`gh run view <id> --log-failed`, on 2026-10-02. Nine failed merge-group runs
were inspected; three contained Windows-core panics. The same queue branches
also have successful runs, including 36966613765 and 36966792110.

| Run | Test | Exact error |
| --- | --- | --- |
| 36965724350 (PR 545) | `policy_control_stays_bounded_during_maximum_size_read_completion_burst` | `Registry(SqliteFailure(Error { code: DatabaseBusy, extended_code: 5 }, Some("database is locked")))`, `security_state.rs:673`, worker result unwrap |
| 36958216481 (PR 548) | `recovery_unblocks_a_full_legacy_collection_without_clearing_unrelated_claims` | `Provider(OperationDeadline)`, `runtime_claim_recovery.rs:330` |
| 36957289285 (PR 548) | `collection_metadata_refreshes_edits_and_disabled_collections_fail_closed` | `Io(Os { code: 5, kind: PermissionDenied, message: "Access is denied." })`, `collections.rs:487`, metadata update |

The other failed runs inspected (36961415906, 36958343412, 36957287900,
36956116445, 36956095371, 36888396554) had no Windows-core panic in their
failed-job logs. This is a bounded recent-run audit, not a claim that every
historical Windows failure has been classified.

## Causes and changes

### Read completions and policy control

The old fixture released 48 simultaneous admissions and fresh SQLite readers,
then required every worker to succeed within SQLite's finite busy budget.
The panic was **not** its two-second policy assertion. It combined writer
admission contention, reader connection startup, response allocation, and
control work, so slow Windows filesystem scheduling could fail an unrelated
worker before the intended response-completion invariant was examined.

Admission already has a dedicated concurrent-burst test. Pre-admit all 48
requests, then use two concurrent completion workers alongside policy control.
Keep all 48 maximum-size responses and the small-database/no-payload-column
assertions. Replace elapsed-time performance with the writer connection's
exact SQL change count: only the single grant DELETE/INSERT and policy UPDATE
may change authority rows; completions must contribute **zero** writes. The
existing WriterQueues unit test independently verifies reserved control
capacity and bounded fairness without a filesystem or wall clock.

No SQLite timeout, retry, authorization, or replay behavior changes.

### Full retained-claim recovery

The runtime has a real 30-second operation budget. The full fixture retains
128 transactions; recovering 127 in one invocation requires repeated retained
journal lookup/revision validation, durable acknowledgement, and audit writes.
This inadvertently imposed a disk-throughput requirement on Windows. It is
not a shared-temp-directory or fake-clock bug.

Keep the 128-claim capacity failure/restart fixture, but select at most 16 claims
per explicit recovery invocation. Assert that all 127 exact selected IDs were
recovered, that the unrelated claim remains, that all record bytes remain
unchanged, and that a subsequent create succeeds. Neither the production
operation deadline nor engine collection semantics changed. Large single
administrative recovery requests still have the existing deadline behavior;
bulk engine optimisation is outside this test correction.

### Atomic metadata publication (product change)

`update_metadata` used a single `NamedTempFile::persist` call. On Windows this
uses native replacement, which can fail with access/sharing errors while a
scanner/indexer holds a non-delete-shared handle. The upstream engine's
handle-relative publication already accounts for this class of transient;
Connect's metadata publisher did not. The log does not identify the external
handle owner or the precise syscall inside metadata update, so scanner identity
is an inference, not an observed fact.

Windows metadata publication now retries only native errors 5/32/33, at most
20 retries, retaining the **same synced temporary file**. Other errors return
immediately; persistent sharing/access errors still fail explicitly. Never
remove the destination or emulate atomic replacement with truncate/write.
Unix publication is unchanged. There is no new public API or configuration.

Portable fault-injection tests verify exact attempt bounds, preserved original
bytes during failure, unchanged error codes, and successful atomic replacement.
A Windows-only native regression holds the destination without delete sharing,
observes the actual failed persist, releases that handle synchronously, and
then verifies replacement. It does not guess a release delay or timer tick.

## Validation

Windows is not available locally. The native Windows regression must be run by
the `windows-2025 core` lane; Linux results cannot certify Windows sharing or
antivirus scheduling.

Local Rust builds use two jobs, no incremental output, and disabled dev/test
debug info (initially only ~11 GiB disk was free). Assertions are enabled.
The corrected cases and publication tests pass individually on Linux.
A stress run pins the test process and three competing CPU loops to CPU 0,
then runs each of five cases ten times using the built core test binary:
**50/50 passed**. The full recovery fixture took 30–48 seconds overall under
that contention, while every bounded recovery invocation kept its original
operation budget. Publication failure tests use exact attempt counts, not
elapsed-time assertions.

- `pnpm test:fast`: passed (workspace Node and Rust tests).
- `pnpm test:integration`: passed (browser storage/accessibility).
- `pnpm e2e`: passed (the registered `local` system suite).
- `pnpm ci:local`: passed, one final default Node/Rust run (all selected
  Server CI gates, including workspace clippy and Rust tests).
- `git diff --check`: passed.

Read-only CI audit logs and local validation logs/exit codes are available at
`/tmp/sdk-windows-run-*.log` and `/tmp/sdk-windows-validation/` on the validation
machine. No Windows execution result is claimed.
