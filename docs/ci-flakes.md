# CI flakes

A recovered failure is evidence of a bug, not permission to ignore it.

## PR and merge-queue policy

- Workspace `test` scripts run Vitest through `scripts/ci/vitest.mjs`.
  In CI, Vitest retries a failing **test case** once, including its hooks.
  Local runs do not retry. Test/module collection failures and unhandled errors
  remain failures. Do not add per-test retry overrides.
- Rust CI uses `node scripts/ci/cargo-test.mjs` with the existing Cargo
  package/feature/target arguments. It builds once, discovers harnesses via
  Cargo's stable JSON protocol, and preserves each package's working directory.
  Only complete, named libtest assertion failures can retry once, in the same
  harness with `--exact`. A successful retry must report exactly one passing
  test. Compiler failures, crashes, unknown harness output and doctests never
  retry. Harnesses still run in parallel internally.
- If that one retry passes, the job is green, with a **warning annotation**,
  step-summary entry, JSONL record and original/retry output in the
  `flake-evidence-*` artifact (14 days). Names include the GitHub run attempt,
  preserving earlier evidence without collisions on manual job reruns.
  A second failure keeps the job red.
  Neither whole jobs nor entire suites are retried. Node's built-in test runner,
  Playwright and system/upgrade subprocess suites remain fail-on-first-error.
- PR jobs have no issue-write permission, including forks. Their artifacts are
  the record; issue updates are restricted to the trusted stress workflow.
- Neither repository currently invokes cargo-nextest in CI. If it replaces
  Cargo, use nextest's per-test retry/report support and retain this evidence
  contract; do not wrap it with a second retry layer.

Do not use `continue-on-error`, blanket retries, sleeps or larger timeouts as
flake fixes. Reproduce the failure and replace timing assumptions with explicit
synchronization or fix the underlying production invariant.

## Nightly detection

`.github/workflows/flake-stress.yml` runs nightly and via workflow dispatch.
`iterations` defaults to 20 and is validated as 1–1000. **Stress never retries**;
all requested repetitions continue, and any failure makes the lane red. Each
lane has a 90-minute wall-clock cap; choose large dispatch counts accordingly.
Ignored tests requiring an owned PostgreSQL fixture are excluded explicitly;
the registered destructive system suites retain their fail-on-first-error policy.

The curated inventory in `scripts/ci/stress.mjs` covers:

- core/daemon/hosted-provider Rust names containing stress, concurrent, claim_recovery, durability,
  lifecycle, recovery, restart, cancellation or replay (including the Windows
  registry burst, claim-recovery and batch-settlement regressions);
- the CLI's full `unified_cli` lifecycle harness on Linux/macOS, including
  `direct_watch_streams_one_portable_event_and_exits_at_the_requested_count`
  under daemon/mirror startup contention (Unix-only; PR #559, run 37017183238),
  plus 140 exact-revision CLI batches during background filesystem ingestion
  (local-relay failure in PR #560, run 37062508709/job 111022335299);
- client base64/crypto, request coordination, startup, session startup and leases;
- editor lazy-mount focus, session lifecycle and type-definition lifecycle;
- sync mirror/promotion fault injection and materialization;
- server collection/capability lifecycle, relay timeout/broker and notifications.

Linux uses inherited affinity to two allowed CPUs; Windows uses CPUs 0 and 1.
Standard public GitHub macOS runners do not expose a two-core configuration or
an affinity API: Homebrew `cpulimit` caps the whole test process tree to **200%
aggregate CPU time**, not two physical cores. Rust build/test and Vitest worker
budgets are two. Exact two-vCPU macOS testing would require a separately
provisioned runner and replacing `macos-15` with its label; no such runner or
repository setting is configured by this change.

The write-enabled reporting job downloads artifacts as data, and opens/reopens
or updates one bot-owned, marker-identified **CI flake stress tracking** issue.
Only that job has `issues: write`. Its body contains exact harness/module and
case names, platform, iteration and the run/artifact link. Previous evidence is
retained in issue edit history. Setup failures remain red with workflow logs;
they are not classified as recovered test flakes. No new secrets are required.

```sh
# Already-built dependencies and the normal adjacent mdbase-rs checkout required.
node scripts/ci/two-cpus.mjs scripts/ci/stress.mjs 20
# Preview an issue payload without contacting GitHub.
node scripts/ci/track-flakes.mjs .ci-flakes --dry-run
```

The CLI watch regression formerly slept 300 ms before its sole file write.
Run 37017183238 timed out with empty stdout/stderr: slow startup could include
the write in the initial snapshot instead of emitting it as a change. PR #565
replaced that assumption with the engine's existing readiness barrier: the CLI
emits a flushed, payload-free stderr status after `CollectionWatcher::open`
returns, and the test waits for it before writing. Stdout remains event-only;
no engine re-pin, startup sleep or increased timeout was needed.

The Editor feedback Escape/focus e2e (issue #576; PRs #569, #575, run
37102346644) opened feedback before the lazily mounted note editor had mounted.
That editor's one-shot autofocus deliberately yields only to editable controls,
so when it mounted after Escape it moved focus off the restored feedback
trigger (about 5% of 200 local repeats). The test now waits for that initial
autofocus (`Note body` focused) before interacting.

The CLI batch settlement failure was a local runtime lock inversion, not relay
acknowledgement or a test delay. Connect admitted background feed ingestion and
foreground mutations through independent permits. The engine transfers a
held durable write lock to its settlement worker before that worker acquires
the provider gate; an overlapping background writer could hold the provider
gate while waiting for the durable lock. Both operations then hit the existing
30-second bound. Background ingestion, acknowledgement and reconciliation now
share the existing mutation permit. The old independent background permit now
belongs only to sync snapshot/receipt orchestration, which enters scoped writes
and subsequent feed finalization separately. Foreground reads retain their
separate capacity, and idle polling still does not touch residency. A
scheduling-invariant regression fails with the old pool, and the full CLI
harness repeats 140 exact-revision batches under background
watcher activity. Actual ambiguous outcomes and cancellation remain errors;
this does not retry a write or increase a deadline.

Both repositories prebuild their testbed adapters before entering the unchanged
protocol-response deadline. Cold compilation is setup, not a timed semantic
operation; compiler errors still fail the build.

No merge-queue settings changes are needed. Re-running a failed GitHub job does
not restore a PR already removed from the queue or re-enable auto-merge; the
bounded in-job policy prevents *recorded, recovered test failures* from reaching
that boundary. Persistent failures must still stop qualification and require a
fix/requeue. Re-pin Connect's engine only after the Rust fix lands on main.
