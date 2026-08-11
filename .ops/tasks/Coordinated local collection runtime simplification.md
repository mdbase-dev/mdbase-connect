---
title: Coordinated local collection runtime simplification
status: in_progress
priority: high
owner: codex
tags:
  - architecture
  - mdbase-rs
  - connector
  - runtime
  - reliability
  - performance
  - scalability
  - cancellation
  - caching
  - observability
created_at: 2026-08-11T18:24:43+10:00
updated_at: 2026-08-11T23:48:00+10:00
type: task
---

# Coordinated local collection runtime simplification

## Outcome

Make one long-lived mdbase runtime the canonical local execution boundary for
each registered collection, and make Connect a thin authority and scheduling
layer around that runtime.

The work should improve reliability, latency, bounded memory use, and scaling
to larger and more numerous collections by removing duplicated discovery,
watching, invalidation, and execution machinery. Performance is a consequence
of clearer ownership and less repeated work; it is not a reason to weaken
durability, authorization, or Markdown-as-source-of-truth guarantees.

The target is not a rewrite. Each phase should introduce one stronger primitive,
move its current callers onto it, and delete the mechanism it replaces. Avoid a
permanent compatibility layer between two local runtime models.

## Scope and repository map

| Repository | Responsibility in the target architecture |
| --- | --- |
| `mdbase-rs` | Canonical collection semantics, filesystem transactions and recovery, collection generations, exact change sets, watching external edits, query/cache/index semantics, snapshots, and cooperative operation cancellation. |
| `mdbase-connect` | Application authorization, grant enforcement, admission and fairness, durable application request identity/outcomes, relay and loopback routing, application-facing retry metadata, and lifecycle management of local collection runtimes. |

Connect must not duplicate mdbase mutation semantics, infer changes by decoding
operation-specific JSON, or ask a second watcher to rediscover a mutation that
mdbase just performed. mdbase must not acquire Connect concepts such as grants,
applications, relay policy, or request retry behavior.

The existing NATS-based transport remains in place. Transport replacement is
not part of this program.

## Architectural principles

1. **One owner per concern.** mdbase owns collection state transitions;
   Connect owns authority and application request state transitions.
2. **One runtime per active local collection.** The runtime owns the provider,
   external-change watcher, generation, and rebuildable indexes for its
   lifetime.
3. **Known changes are applied, not rediscovered.** Successful mdbase mutations
   return their exact change set. Watchers exist for external changes and
   recovery reconciliation.
4. **Canonical data and derived state remain distinct.** Markdown and durable
   mdbase transaction evidence are authoritative. Query caches, link indexes,
   and compiled plans are bounded, disposable, and rebuildable.
5. **Prepare can be cancelled; commit must finish.** Expensive read work and
   mutation preparation cooperate with deadlines. Once a durable filesystem
   commit begins, it completes or recovers independently of whether the caller
   is still waiting.
6. **Bounded work is explicit.** Queueing, concurrency, cache residency, and
   snapshot lifetime have deliberate limits. Increasing timeouts or queue sizes
   is not a substitute for removing redundant work.
7. **Simple failure states beat clever concurrency.** Prefer ordered mutation
   execution, immutable read generations, and idempotent recovery over broad
   shared-state synchronization.
8. **Every new abstraction pays for itself by deletion.** A collection runtime,
   execution outcome, or mutation plan is complete only when its duplicated
   watcher, inference, shadow-copy, or task-spawning path is removed.

## Target architecture

```text
application
    |
    v
Connect SDK request coordinator
    |
    v
Connect transport + grant enforcement
    |
    v
per-collection executor
  - ordered mutation lane
  - bounded foreground read lane
  - bounded background lane
    |
    v
mdbase FilesystemRuntime
  - provider and operation gate
  - collection generation
  - transaction/recovery engine
  - external-change watcher
  - rebuildable query/link indexes
    |
    v
canonical Markdown collection

mdbase ExecutionOutcome
    |
    +--> Connect durable request receipt
    +--> Connect change journal / notifications
    +--> mdbase incremental cache update
```

There should be no second Connect-owned collection watcher in the completed
architecture. There should also be no unbounded fan-out from an incoming
request to the general Tokio blocking pool.

## Existing foundations

Preserve and build on the work already shipped:

- mdbase query memory is bounded for metadata pages and long-running queries
  accept cooperative cancellation (`mdbase-rs` tree pinned by Connect at
  `ca71aeb`).
- Connect has bounded admission, per-grant fairness, absolute deadlines,
  cooperative query cancellation, and durable mutation outcomes across client
  deadlines (`f5b0ff7b` and `b1ba9e67`).
- Connect has payload-free daemon profiling, admission/RSS observations, and a
  long-lived read/query soak (`29eb42d` and `8ff69e8`).
- mdbase has crash-recoverable collection transactions and a caller-owned
  staged mutation API.

This program should consolidate those foundations rather than introduce a
parallel execution framework.

## Phase 0 — freeze boundaries and measure the current path

### Contract work

1. Write a short cross-repository ADR defining:
   - `CollectionGeneration`;
   - `ExecutionOutcome` and `ChangeSet`;
   - mdbase filesystem transaction identity versus Connect application request
     identity;
   - mutation prepare/commit/cancel semantics;
   - known mutation changes versus external watcher changes;
   - generation-pinned reads and expiration; and
   - which state is authoritative, durable support state, or rebuildable cache.
2. Draft the Rust API before changing Connect. The API should be useful to any
   mdbase host and contain no Connect-specific types.
3. Decide whether a commit identifier must survive process restart. If so, it
   is an opaque mdbase transaction identifier and must not contain paths or
   record content.
4. Define one normalized external-change shape that can represent create,
   update, delete, rename, and collection-control changes without losing the
   revisions mdbase needs for cache invalidation.

### Baseline observations

Record the current release-mode behavior on at least 2,000 and 10,000 synthetic
records:

- create, update, delete, rename, and reference-updating rename;
- 200-row library query and sequential pagination;
- concurrent and mixed daemon workloads;
- cache refresh and rebuild phase timings;
- mutation execution versus watcher synchronization time;
- RSS through a 1,600-request soak; and
- two active collections under concurrent load.

Performance results remain informational. Correctness and boundedness are
release requirements; fixed latency or RSS thresholds are not.

### Exit evidence

- The ADR is reviewed in both repositories.
- The proposed mdbase API can express every current canonical mutation and
  watcher event without Connect decoding operation-specific result fields.
- Baseline reports are retained through the existing performance observation
  machinery.
- No implementation phase begins with an unresolved ownership question.

## Phase 1 — return canonical mdbase execution outcomes

Implement provider-level types along these lines, with final names chosen in
the mdbase-rs API review:

```rust
struct ExecutionOutcome {
    result: OperationResult,
    generation: CollectionGeneration,
    changes: ChangeSet,
    commit_id: Option<CommitId>,
}

enum ChangeSet {
    None,
    Records(Vec<RecordChange>),
    Resources(Vec<ResourceChange>),
    CollectionWide,
}
```

### mdbase-rs

1. Make operation execution return the generation observed or produced by the
   operation and the exact canonical affected resources.
2. Keep `OperationResult` as the portable semantic result. Keep generation,
   commit, and local invalidation metadata in the provider/runtime outcome
   rather than automatically expanding the public wire schema.
3. Replace host-side calls to `OperationRequest::affected_paths()` with the
   engine-produced change set. Retain the current helper only as an internal
   construction aid until every operation emits exact changes.
4. Cover single mutations, atomic batches, reference-updating rename, type and
   view-source changes, dry runs, invalid operations, and no-op results.
5. Prove that change sets never report paths outside the collection and that
   invalid operations cannot advance generation.

### mdbase-connect preparation

1. Add an adapter that consumes `ExecutionOutcome` while leaving the existing
   runtime active.
2. Record the outcome's generation and opaque commit identity in privacy-safe
   diagnostics where useful, but do not persist paths or content in the
   application request journal.
3. Add conformance fixtures proving direct mdbase execution and Connect's
   adapter agree on result and invalidation semantics.

### Deletion requirement

When Connect cuts over in Phase 4, delete its operation-specific invalidation
inference. Do not retain both outcome consumption and JSON-result inference.

## Phase 2 — make ordinary mutations sparse

The canonical single-record mutation path currently creates a collection-wide
shadow working copy before committing a small write. Replace this gradually
with explicit mutation plans.

### mdbase-rs

1. Introduce an internal `MutationPlan` containing exact revision
   preconditions, planned writes/deletes/renames, and the resulting `ChangeSet`.
2. Refactor create, update, and delete first. They should validate and render
   only their affected record, then use the existing crash-recoverable
   transaction layer to commit the exact write set.
3. Refactor rename after the reverse-link candidate work in Phase 3 is
   available. A rename plan includes the source, destination, and only records
   whose references actually change.
4. Keep complete atomic batch semantics. Replace the full copied collection
   with a sparse copy-on-write overlay only after single-operation planning is
   stable; do not combine the two behavioral changes in one patch.
5. Make mutation preparation cooperatively cancellable. Once the transaction
   journal enters commit, finish or recover the commit even if the host's
   cancellation token is set.
6. Keep mdbase transaction recovery and Connect request recovery separate:
   mdbase proves the filesystem write set; Connect proves what happened to one
   authorized application request.

### Transaction simplification investigation

The transaction journal currently checkpoints progress after each applied
entry. Evaluate an idempotent recovery model based on each entry's exact before
and after revision:

- current equals before: apply the planned entry;
- current equals after: the entry is already applied;
- current equals neither: stop with a typed interference/manual-recovery
  outcome.

Adopt the simpler prepared/committing/committed journal only if crash injection
proves it at every entry boundary on Linux, macOS, and Windows. Otherwise keep
the current journal; sparse write sets still deliver most of the architectural
and performance benefit.

### Exit evidence

- Single-record create/update/delete cost no longer grows with the total number
  of collection records.
- Existing revision, validation, crash recovery, and atomicity semantics remain
  unchanged.
- A cancellation during preparation performs no write; cancellation after
  commit begins cannot strand an incomplete unowned transaction.
- The old full-shadow path is removed for migrated operations.

## Phase 3 — make cache and link maintenance incremental

### mdbase-rs runtime and cache

1. Add `apply_changes(ChangeSet)` for known successful mutations and
   `apply_external_changes(...)` for watcher-originated changes.
2. Re-index only affected records/resources and advance the cache generation in
   the same rebuildable cache transaction.
3. Stop walking every collection record to prove cache freshness before every
   query. Full scans remain startup/recovery/reconciliation tools.
4. Replace per-operation control-folder stamp walks with runtime generation
   invalidation. Retain an explicit full control-resource reconciliation path.
5. Treat cache corruption or a generation mismatch as a typed reason to
   rebuild, never as permission to change or delete canonical Markdown.

### Reverse-link candidates

1. Extend the reconstructible link index with canonical resolved target path or
   record identity, source revision, location, field, and raw target.
2. Use that index to select candidate sources for backlinks and
   reference-updating rename.
3. Re-parse and semantically verify each candidate before changing it. The
   index is an accelerator, not the final authority.
4. Fall back to a full scan when the index is absent, stale, or cannot represent
   an ambiguous link safely.

### Exit evidence

- A warm unchanged query does not perform a collection-wide filesystem scan.
- A one-record external edit re-indexes that record and produces the same query
  result as a clean full rebuild.
- A known mutation updates the cache from its `ChangeSet` without waiting for a
  watcher round trip.
- Reference-updating rename work scales primarily with actual candidate
  references rather than total records.
- Rebuilding the cache from Markdown produces the same generation-visible
  results as incremental maintenance.

## Phase 4 — cut Connect over to one per-collection executor

### mdbase-connect

1. Replace registry-owned provider handles plus the separate
   `CollectionWatchService` with one runtime handle per active local collection.
2. Put a small `CollectionExecutor` around that runtime. It owns:
   - one ordered mutation lane;
   - a bounded foreground read lane;
   - a bounded background/sync lane;
   - deadline-aware queued work; and
   - lifecycle state for open, idle, unavailable, rebuilding, and closing.
3. Keep authorization and admission before execution. Admission protects the
   daemon globally; the executor provides collection-local ordering, fairness,
   and lifecycle ownership.
4. Stop spawning an independent general blocking-pool job for every admitted
   request. Use stable bounded workers owned by the executor and preserve
   responsiveness across collections.
5. On a successful mutation, consume `ExecutionOutcome` directly:
   - advance the Connect mutation journal state;
   - persist the application-facing final receipt;
   - append the local change journal entry;
   - deliver runtime notifications; and
   - return the response.
6. Feed normalized external changes from the mdbase runtime through the same
   change-journal and notification path, with generation/revision deduplication.
7. Preserve the existing distinction between reserved mutation capacity,
   foreground reads, background work, and grant fairness. Do not replace known
   admission guarantees with a generic actor mailbox.

### Deletion requirement

Delete:

- Connect's separate per-collection watcher supervisor and workers;
- synchronous post-mutation watcher rescans;
- Connect's operation-result invalidation inference; and
- redundant provider lifecycle paths in `CollectionRegistry`.

Do not declare Phase 4 complete while both old and new runtime paths can serve
normal authority requests.

### Exit evidence

- Known mutations have no watcher-synchronization phase in their request
  latency.
- External editor changes still produce durable ordered Connect change events.
- One slow collection cannot occupy every local execution worker.
- Active and queued counts return to zero after cancellation, timeout, runtime
  close, and daemon shutdown.
- Restart tests recover both the mdbase filesystem transaction and the Connect
  application request outcome without duplicating the logical mutation.

## Phase 5 — coordinate application request pressure

The daemon should remain bounded, but applications should avoid creating work
that is already obsolete before it reaches the collection executor.

### mdbase-connect SDK

1. Add one request coordinator per selected connection, not one per UI
   component.
2. Bound foreground concurrency to the authority's advertised/recommended
   capacity.
3. Coalesce identical in-flight reads and queries where request identity and
   result semantics permit it.
4. Support latest-wins cancellation for explicitly replaceable query families,
   such as library search/filter refreshes. Do not apply latest-wins semantics
   implicitly to mutations.
5. Keep mutations in an ordered request lane and preserve their durable pending
   recovery handles.
6. Return structured retry timing for genuine overload and make retries consume
   the caller's original overall request budget.
7. Distinguish privacy-safe metrics for queue-full rejection, queue deadline,
   execution deadline, cancellation, and policy synchronization delay.

### Exit evidence

- Rapidly changing a query does not leave stale requests occupying all
  per-grant capacity.
- The coordinator has one state owner and does not introduce a second session
  or cache model.
- Existing applications remain free to issue independent queries when they are
  genuinely concurrent.
- Durable mutations are never coalesced, silently cancelled, or retried under a
  new request identity.

## Phase 6 — generation-pinned pagination and bounded runtime residency

Do this after the simpler runtime and incremental cache are established.

### mdbase-rs

1. Add optional generation-pinned query pagination with an opaque cursor,
   deterministic tie-breaker, and typed expiration when the requested
   generation is no longer available.
2. Keep offset/limit compatibility only where still required; migrate
   controlled consumers to cursor paging and then decide whether the old path
   should remain public.
3. Cache compiled query or saved-view plans only when profiling demonstrates a
   meaningful repeated compilation cost. Key plans by canonical query/view
   digest and every semantic generation that can invalidate them.

### mdbase-connect

1. Add explicit per-runtime accounting for parsed/indexed state, query cache,
   link index, and active snapshots using mdbase-provided measurements where
   possible.
2. Bound the number of resident collection runtimes and idle-evict clean,
   inactive runtimes through the same lifecycle owner.
3. Reopen an evicted runtime from canonical Markdown and rebuildable support
   state without changing collection identity or application grants.
4. Exercise concurrent workloads across more collections than the residency
   limit so eviction, reopening, and fairness are observable.

### Exit evidence

- Pagination does not duplicate or skip records within a retained generation.
- Expired generations fail explicitly instead of silently mixing snapshots.
- Long-lived daemon memory remains bounded as collections are opened, idled,
  evicted, and reopened.
- Plan caching is omitted if measurements do not justify its complexity.

## Verification strategy

### mdbase-rs correctness

- Change-set conformance for every canonical mutator and dry-run/error path.
- Sparse mutation equivalence against the existing shadow implementation while
  the migration is under test.
- Crash injection before prepare, after durable prepare, at each commit entry,
  after commit, and during cleanup.
- External modification at every revision/precondition boundary.
- Incremental cache versus clean-rebuild differential tests.
- Reverse-link candidate versus full-scan differential tests, including
  ambiguous names, relative links, IDs, embeds, and frontmatter links.
- Cancellation at bounded intervals through query, view, snapshot, link-graph,
  rename discovery, and batch preparation.

### mdbase-connect correctness

- Direct loopback and relay execution against the same runtime semantics.
- Process termination at every mdbase-commit/Connect-receipt boundary followed
  by exact request replay.
- Watcher failure/restart and external edit ordering.
- Disk-full and cache-corruption recovery without canonical content loss.
- Queue deadline and execution deadline while other grants and collections
  continue making progress.
- Runtime eviction/reopen with stable collection identity and grant behavior.
- Daemon shutdown with no active or queued operation left unowned.

### Performance visibility

Extend the existing non-gating observations rather than adding pass/fail
budgets:

- mutation preparation, commit, cache application, journal/receipt completion,
  and total latency;
- executor queue time by work class and collection;
- cache full scans, incremental updates, rebuilds, and hit rate;
- rename candidate count versus total records;
- active/idle runtime count and estimated resident bytes;
- single- and multi-collection daemon soak checkpoints; and
- library page, rapid replacement, pagination, mutation, and mixed workloads.

Record source commits from both repositories in each observation so results
remain attributable across a coordinated pin change.

## Delivery and review order

1. Land the ADR and API types in mdbase-rs without changing behavior.
2. Land exact `ExecutionOutcome` production and conformance tests in mdbase-rs.
3. Land sparse create/update/delete as reviewable mdbase-rs changes.
4. Land incremental cache application and reverse-link candidates separately.
5. Pin that reviewed mdbase-rs revision in a Connect branch.
6. Add the Connect executor and outcome adapter, then cut normal local authority
   traffic over in one reviewed change series.
7. Delete the old Connect watcher/inference/provider lifecycle in the same
   release train.
8. Add SDK request coordination only after the executor's observable capacity
   and cancellation behavior are stable.
9. Add generation-pinned pagination and runtime residency bounds as follow-up
   slices, retaining only complexity justified by the recorded workloads.
10. Promote one coordinated candidate through staging, crash/recovery suites,
    consumer acceptance, and the non-gating performance observations.

Correctness changes, performance changes, and large module moves should remain
separate commits where possible. Do not combine this architecture program with
unrelated view-model, import, or transport redesign.

## Acceptance criteria

1. Each active local collection has one mdbase runtime and one Connect
   executor; Connect has no second collection watcher.
2. Connect consumes an exact mdbase `ExecutionOutcome` and no longer infers
   mutation invalidation from operation-specific JSON.
3. Create, update, and delete use sparse mutation plans rather than a
   collection-wide shadow copy.
4. Known mutations update derived indexes directly and do not wait for watcher
   rediscovery.
5. External edits flow through the same generation-aware change path and remain
   recoverable after watcher or daemon restart.
6. Warm queries avoid a collection-wide freshness scan; full reconciliation is
   explicit and recoverable.
7. Reference-updating rename uses a verified reverse-link candidate set with a
   safe full-scan fallback.
8. Cancellation can stop expensive preparation and reads, while a begun commit
   always finishes or recovers to a typed durable state.
9. Per-collection execution and SDK coordination prevent stale read/query
   bursts from starving mutations or unrelated collections.
10. Cursor pagination is stable within a retained generation and fails
    explicitly when that generation expires.
11. Runtime and cache residency remain bounded as multiple collections cycle
    through active and idle states.
12. NATS remains the transport architecture for this program.
13. Performance history shows the effects without introducing latency or memory
    release gates.
14. The completed implementation deletes the duplicate watcher, invalidation,
    shadow-copy, and general task-fan-out paths it replaces.

## Risks and controls

| Risk | Control |
| --- | --- |
| Cross-repository contract drift | Pin exact mdbase revisions; run shared outcome/change-set fixtures in both repositories; record both commits in profiling output. |
| Cache treated as authority | Keep caches reconstructible; differential-test incremental state against clean rebuilds; fall back safely on generation mismatch. |
| Mutation optimization weakens durability | Preserve exact revision preconditions and crash recovery; migrate one operation class at a time; require crash injection before deleting the shadow path. |
| A collection actor becomes a new monolith | Keep the executor limited to scheduling and lifecycle; collection semantics stay in mdbase; retain separate bounded lanes rather than one opaque mailbox. |
| Dual runtime paths linger | Put deletion requirements and exit evidence in every phase; do not ship a permanent feature flag or compatibility facade. |
| Generation semantics become a distributed consensus mechanism | Keep generations local and opaque; they order one authority's snapshots and changes, not multiple authorities globally. |
| Performance work expands without evidence | Use existing phase timings and soak history; omit compiled plans or transaction-journal changes when measurements do not justify them. |

## Implementation evidence — 2026-08-11

The user approved this program for implementation while staging acceptance
continues. Production remains on beta55. Beta64 is the frozen compatibility and
performance baseline; NATS replacement and a production rollout remain out of
scope for this phase.

Phase 0 is complete and published for review:

- provider contract, executable fixtures, and reproducible baseline:
  `callumalpass/mdbase-rs#48` at `2454cb2`;
- Connect execution, persistence, and cutover ADR:
  `mdbase-dev/mdbase-connect#250` at `719ab9c` before this registry update;
- the contract passed six independent red-team passes with no remaining P0/P1
  contradiction.

The accepted contract fixes the implementation boundaries before behavior changes:

- host claim, application request, commit, event, and collection generation
  identities are separate and crash-resolvable;
- all blocking provider/feed work receives one deadline-bearing operation context;
- preparation is cancellable, a pre-commit rejection is a durable final outcome,
  and only the fsynced commit transition transfers settlement ownership to mdbase;
- exact normalized changes are paged and digest-bound, including explicit body
  change metadata;
- mdbase owns a durable, singleton, fenced pull/ack feed and the only application
  change writer after an explicit per-collection cutover;
- transfer intent/receipt/ack handling is crash-idempotent, and baseline feed
  initialization sets every cursor and watermark explicitly;
- Connect does not retain a dual writer or permanent compatibility runtime after
  a collection cuts over.

The current-main release baseline used mdbase source `a363419` and Connect
`d4138fb9`. Both 2,000- and 10,000-record workloads passed correctness, 160 mixed
requests per concurrency scenario, and 1,600 soak requests with zero errors. The
10,000-record provider mutation mean was 4,125.60 ms and same-collection mixed
throughput was 2.53 requests/s, while between-request RSS/PSS stayed flat at roughly
76,652/74,012 KiB. This points at repeated coordination/rebuild work as the primary
provider-runtime cost in the harness rather than an unbounded provider-memory leak.

Beta64 staging heavy testing also found a separate hosted-mirror liveness problem:
an HTTP sync transport that stopped making progress could hold the mirror RAII guard
indefinitely, leaving `syncing=true` and manual recovery at `mirror_busy` until daemon
restart. Draft `mdbase-dev/mdbase-connect#249` at `5dec13c` adds bounded connect/read
and whole-sync deadlines, typed timeout outcomes, resumable journal settlement, and
abort/timeout cleanup tests. It passed the complete Rust workspace, formatting,
clippy, TypeScript typecheck/tests, and local daemon/relay E2E path. It still requires
a new prerelease and deployed hosted/binary/restart staging acceptance before merge
to any production rollout.

Next implementation step: land the provider contract, create a clean mdbase-rs
worktree from that merge, and implement Phase 1 outcomes/feed primitives without
changing the public Connect/NATS wire. Carry the baseline harness forward as a
correctness and comparative-observation tool, not a fixed timing gate.

## Handoff

Begin Phase 1 in mdbase-rs from the merged provider contract. Implement the
accepted identities, preparation/outcome states, normalized paged changes, and
durable feed primitives behind current public behavior. Preserve the existing
Connect path until fixtures and crash/cancellation tests prove the provider
boundary; then pin the exact mdbase revision into a new Connect worktree.

Do not start with a second Connect scheduler or a dual watcher. Phase 4 introduces
the per-collection executor only when it can cut each collection atomically to the
provider feed and delete the legacy inference/watcher writer. Keep production on
beta55 until the new prerelease passes direct, relay, hosted, migration, binary,
large-vault, contention, cancellation, and deployed-consumer staging acceptance.
