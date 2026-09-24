# Runtime contention fixes

## Scope and integration

Based on Connect `b3d896f7a8629fc806ef6b8c0cf866329e40f82c` (beta.107), with companion engine commit `f21e9d5a7d7435f7e3c0d7c692ec5f6f665a0e97`. The Docker engine pin is updated. Publish/integrate the companion engine commit before building from that pin remotely. These changes were developed in isolated worktrees, not in the independently modified main checkouts.

## Changes

1. **Cold initialization:** executor lookup holds the map mutex only for lookup/publication. A separate lifecycle gate serializes opens, registration changes, disable/remove, identity changes and shutdown. Publication revalidates registration; compatible duplicate registrations keep their resident executor. Retired runtimes are destroyed outside the map lock.
2. **Fair finalization:** one command and one collection turn per iteration, round-robin continuations, at most 16 provider events or 10 ms of append work per turn. Synchronous completion pins the initial feed head. Background work cannot reopen an evicted runtime. Recovery runs even under continuous work. A turn rereads durable feed state rather than retaining a stale page across permit releases.
3. **Durable batching:** one SQLite connection per drain/turn; acknowledge prefixes of up to 16 provider events; delete receipts in one transaction. A later append failure or cancellation settles earlier successful appends. Acknowledgement failure retains receipts; restart reuses the same public cursors. Receipt cleanup after an acknowledgement-before-cleanup crash uses the durable unacknowledged boundary. Synchronous settings and persistence-before-acknowledgement are unchanged.
4. **Readiness-driven ingestion:** the engine signals watcher readiness through a replaceable callback. Connect coalesces those signals and retains a one-second recovery poll. Engine watcher idle waits no longer wake every short debounce tick; active debounce deadlines are unchanged. Registration of a callback issues a readiness hint to close installation races.
5. **Notification isolation:** local event admission and timer/control operations no longer await HTTP. Four outbound dispatch tasks, one per collection, take one durable run per turn and rotate FIFO. Pending entries coalesce by collection; payloads and retries remain in the runtime store. Commands and event channels are bounded. The admission worker has an independent, joined executor so synchronous callers cannot deadlock its progress. Its owning task remains abortable and visible to critical-worker monitoring.
   - The finalizer waits for **local durable admission**, not remote delivery, before acknowledging a prefix. Failed/partial admission or shutdown retains provider events and receipts for replay. Admission is idempotent by public cursor. Nonmatching events require no notification admission. This closes the failed-prefix and bounded-channel handoff gaps without introducing another persisted outbox.
6. **Byte accounting:** serde streams into a counting writer, preserving exact UTF-8/escaping sizes and serialization errors. JSON arrays/objects are counted by reference rather than cloned solely to wrap them in `Value`. This changes accounting allocation, not projection, authorization, or the wire envelope.

## Bounds and remaining limits

- The 10 ms turn budget covers append work; it is not a hard deadline for filesystem I/O, SQLite, admission or journal acknowledgement. Local admission has a 30-second failure bound and may backpressure writes. Outbound HTTP does not participate in that barrier.
- Batching amortizes the engine's JSON feed-journal rewrites; it does **not** replace that representation or eliminate its asymptotically quadratic full-backlog acknowledgement cost.
- Notifications remain at-least-once across admission/acknowledgement failures, with runtime/provider deduplication. Cancellation never acknowledges unpersisted or unadmitted events.
- Hosted-provider accounting microbenchmarks do not establish an end-to-end hosted-query speedup. Synthetic tmpfs measurements are not physical-disk throughput or production p99.

## Measured results

Three alternating before/after pairs, optimized test executables, synthetic collections on Linux tmpfs. The before executable is the preserved instrumented beta.107 baseline from the investigation; executable hashes and all observations are retained with the evidence. The captured performance executables precede only final type-alias/lint and test-teardown cleanups, not runtime behavior changes. Values below are medians across runs, not production percentiles.

| Observation | Before | Fixed |
| --- | ---: | ---: |
| 257-event core drain | 292.8 ms | 25.8 ms |
| 1,024-event core drain | 2,862.7 ms | 207.6 ms |
| Maximum warm read while another collection cold-opens | 95.5 ms | 1.09 ms |
| Aggregate 100 contended warm reads | 156.7 ms | 62.3 ms |
| Quiet event behind 257 busy events, core scheduling fixture | 299.2 ms serial | 4.85 ms fair turns |

The cold query itself took 96.9 versus 104.6 ms: unlocking improves warm-request isolation, not cold initialization work. The fixed fair-turn workload drained both collections in 41.2 ms, versus 26.3 ms with fixed batching but serial scheduling: fairness has a throughput cost. Single-event observations were 1.045 versus 0.911 ms; three runs do not establish a reliable single-event improvement. The core drain measurements exclude notification admission and HTTP.

The actual finalizer-service/runtime idle fixture used 0–1 CPU ticks with one resident and 2–3 ticks with eight residents per three-second window (100 ticks/second): roughly 0–0.33% and 0.67–1.0% of one CPU core respectively. This is **not** full-daemon/battery measurement, nor a paired comparison with the investigation's different polling-loop fixture. Explicitly executing twenty idle polls still costs about the same; the improvement comes from avoiding those polls and engine timer wakeups.

No new physical-disk or end-to-end hosted-provider speedup is claimed. The byte-counter change is covered by exact-size and error-propagation tests; the earlier investigation's serializer microbenchmarks remain accounting-only evidence.

## Validation

- Latest full Connect workspace: **685 passed, 0 failed, 94 ignored**. Ignored tests include external-service integration suites; this is not a claim that PostgreSQL-backed hosted integration was rerun.
- Optimized Connect core/daemon rerun: **337 passed, 0 failed, 8 ignored**.
- Companion engine release library suite: **439 passed, 0 failed, 1 ignored**.
- Strict all-target Clippy (`-D warnings`) and formatting passed in both Rust workspaces.
- Node 24 typecheck, JavaScript workspace tests and isolated local end-to-end MVP suite passed.
- Regression coverage includes cold-open/map-lock and shutdown races, registration fencing, batched append failure, cancellation during append, acknowledgement fencing and replay, receipt cleanup failure, partial notification admission, pinned head barriers, actual worker fairness, stalled-admission shutdown/replay, bounded/coalesced dispatch, panic slot cleanup, independent admission/control execution, and local control completing while HTTP is deliberately blocked.

Earlier failed runs are retained: a concurrent first-use Electron installation needed a serial installation before the JS rerun; watcher fixtures initially waited on a barrier before starting their admission consumer; an existing server fixture removed a database while its finalizer was still alive. Those fixtures now consume admission immediately or join their service before deleting its database. The original investigation's partial-append failure regression passes with batching enabled by default.

## Reproduction

From matching sibling Connect and engine checkouts:

```sh
cargo test --locked --release -p mdbase-connect-core -p mdbase-connect-daemon -- --test-threads=1
cargo test --workspace
# In the sibling engine:
cargo test --release --lib -- --test-threads=1
# Node 24:
pnpm typecheck
pnpm test
pnpm e2e
```

Run performance observations separately from builds/tests:

```sh
MDBASE_FINALIZER_BENCH_ROUNDS=3 cargo test --release -p mdbase-connect-core benchmark_finalizer_ -- --ignored --nocapture --test-threads=1
cargo test --release -p mdbase-connect-daemon benchmark_finalizer_service_idle -- --ignored --nocapture --test-threads=1
```

`benchmark_finalizer_fair_turns` measures core turn scheduling, not the daemon's complete notification pipeline. The ordinary daemon fairness test verifies actual worker ordering; the blocked-HTTP regression asserts that a local timer command completes before the mock is allowed to respond. Neither uses a claimed production latency percentile.

Validation logs, preserved executables, alternating before/after observations and the standalone runner are in `/home/calluma/worktrees/connect-performance-fixes/`.
