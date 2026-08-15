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
updated_at: 2026-08-12T17:44:36+10:00
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

## Implementation evidence — 2026-08-12

The coordinated provider runtime is merged in `callumalpass/mdbase-rs#49` at
`8c12700ca395f9ca1516ec9ff9cb19a062efed3e`. Its complete CI matrix is green on
Linux, macOS, and Windows, including the portable black-box runtime scenarios,
package publication, dependency policy, formatting/clippy/docs/features, and
live PostgreSQL. Local verification also passed the full workspace/conformance
suite and ten consecutive parallel 117-test runtime-library runs after making
the crash/deadline controls transaction-scoped.

The provider implementation now supplies:

- generation-bound exact execution outcomes for canonical records and control
  resources;
- durable prepared/committing/committed/rejected/cancelled/manual states with
  opaque host claims and crash recovery at every commit boundary;
- a durable fenced pull/ack change feed for known and external changes;
- sparse create/update/delete paths, indexed uniqueness and reverse links,
  incremental generation-bound cache updates, and demand-loaded bodies;
- generation-pinned opaque query cursors with explicit release/expiry; and
- privacy-safe retained-runtime measurements.

The Connect beta65 staging candidate is `mdbase-dev/mdbase-connect#251`. It pins
the merged provider revision and cuts normal v0.3 local authority traffic over
to one `FilesystemRuntime` and `CollectionExecutor` per resident collection.
The executor retains separate bounded mutation, foreground, and background
lanes. Connect consumes provider outcomes and feed events directly, persists a
change receipt before feed acknowledgement, and no longer owns a second
collection watcher or operation-result invalidation inference path. Runtime
residency is bounded to eight and tested across eleven collections, including
eviction, external Markdown edits, and identity-preserving reopen.

The SDK candidate adds one request coordinator per selected connection,
independent ordered mutation capacity, bounded foreground pressure, safe read
coalescing, explicit latest-wins families, cursor pagination, early-release
cleanup, and legacy snapshot/offset fallback. The architecture gate remains at
1,000 lines with the new runtime, residency, mutation, and pagination concerns
split into focused modules.

Local candidate evidence is green: 136 core tests, 68 daemon tests, the complete
Rust workspace, formatting and clippy with warnings denied, every JavaScript
workspace suite (including 197 SDK and 270 editor tests), typechecking, packed
public API boundaries, generated problem/operation catalogs, release version
and readiness checks, and the architecture gate. The beta65 PR cross-platform
and release matrix is still running. Production remains untouched on beta55.

## Staging evidence — beta66 and beta67

The coordinated runtime implementation is now merged. The provider landed in
`callumalpass/mdbase-rs#50` at merge `818866705dcc4b6dcfd3bbc1ba63f83fdaec406f`.
Connect landed in `mdbase-dev/mdbase-connect#253` at merge
`52ce558305d8280c3ec96555c0a64a17ffbfd46e`. Beta66 was published and promoted
only to the staging Connect server and hosted provider. The staging server,
provider, MCP, synthetic operation, OAuth write, manifest, R2 CORS, and 120-second
soak checks passed with 66 checks and zero failures. Production remains on
beta55.

Live deployed testing found that the beta66 SDK's automatic first-page cursor
probe exposed one compatibility gap with hosted providers that still reject the
`pagination` field. The shared SDK fix landed in
`mdbase-dev/mdbase-connect#256` at merge
`425275f269a7b3a8d8c5041c089077cdb0465163` and was published as beta67. An
automatic first-page cursor probe now retries exactly once without pagination
when the provider returns `operation_invalid`; explicit cursor requests never
downgrade. The npm publication and canonical Editor deployment workflows passed.
The staging server and provider deliberately remain on beta66 so the deployed
consumer test proves the compatibility boundary rather than hiding it with a
coordinated backend upgrade.

Controlled consumer artifacts were packed from that exact beta67 merge and
passed a coordinated revision, declaration, and SHA-512 audit. TaskNotes commit
`d510da8` is deployed at `https://staging.tasknotes-app.pages.dev/`; Pickle commit
`02a1994` is deployed at `https://staging.pickle-9zb.pages.dev/`; Reader commit
`044e5f2` is deployed at `https://mdbase-reader.pages.dev/`; canonical Editor was
deployed by the beta67 release workflow. TaskNotes, Pickle, Reader, Workouts, and
standalone Editor passed their applicable formatting, type, unit, contract,
build, desktop/mobile browser, Android, notification, push, restart, and package
boundary suites. Workouts has no `deploy:dev` script, Reader has no Git remote,
and the standalone Editor repository is archived; those constraints are recorded
without weakening the canonical Editor deployment.

The beta67 desktop release completed successfully across Linux, Windows, macOS
Apple Silicon, and macOS Intel. The TaskNotes, Pickle, and Workouts beta67 draft
PRs also completed every configured build, smoke, and test check successfully;
release and deploy jobs that are intentionally disabled for draft PRs were
skipped.

An independent Luna browser pass used `staging-test@mdbase.dev` and a temporary
hosted collection. Pickle and Editor each issued one cursor request rejected by
the beta66 provider and exactly one successful offset retry, with no loop or UI
pagination error. TaskNotes completed real create, update, and delete operations;
Reader completed OAuth setup and a valid hosted query. All four layouts passed at
390 by 844 pixels. The temporary collection and its grants were permanently
removed after the test.

The desktop migration reused the same persistent staging profile across beta65,
beta66, and beta67. Before beta67 startup, the stopped beta66 profile was copied
and verified byte-for-byte: 982 files, 1,196,000,004 bytes, and 31 SQLite
databases with successful `integrity_check`. Beta67 reopened both original
collection identities, including `~/testvault/mdbase-reader`. Six full Reader
queries returned 1,507 of 1,507 records with stable metadata and body digests;
metadata took 832–860 ms and bodies 926–935 ms. Daemon RSS stopped growing and
declined from about 283.5 MiB at 60–70 seconds idle to 282.0 MiB at 120 seconds.
This remains consistent with a bounded allocator/runtime high-water mark, not an
ongoing per-query leak.

An independent Luna pass reproduced the 1,507-record beta66 metadata and body
digests through both direct and daemon-routed paths. One-, ten-, and
100-millisecond process deadlines stopped direct and daemon reads within 3, 14,
and 104 milliseconds respectively, with no query child left behind. In an
isolated beta67 profile, ten synthetic collections all registered and queried;
runtime diagnostics reported the intended capacity of eight with eight idle
residents. An external Markdown edit became visible on the next query, and a
daemon restart preserved the exact sorted-ID digest for all ten registrations.
The agent removed every synthetic registration and the isolated profile, leaving
the shared registry at its original two collections. That isolated pass did not
drive cursor lifecycle, so cursor behavior was verified separately rather than
inferred from it.

That cursor lifecycle was then exercised through the daemon operation surface
on the migrated Reader collection. A generation-pinned first page opened
successfully; explicit release returned `released: true`; reuse failed with
`generation_expired`; and a fresh cursor left idle for 31 seconds also failed
with `generation_expired`. No vault content was changed.

The exact beta67 tag also passed the isolated multi-instance PostgreSQL/NATS relay
suite: oversized framed responses, opaque file frames above NATS `max_payload`,
200 concurrent cross-instance requests with retryable admission, fencing, broker
outage and recovery, and post-dispatch durable mutation timeout followed by
same-identity result recovery. This is strong protocol evidence but does not
replace the remaining authenticated staging relay matrix.

The dedicated hosted-file PostgreSQL/S3 suite and adversarial file lifecycle
suite also passed on the exact beta67 tree, covering upload and download
integrity, commit-versus-abort races, late-copy compensation, transfer expiry,
bounded recovery, and cleanup.

## Staging evidence — beta68

Beta68 is the coordinated staging candidate. The Connect implementation and
SDK fixes landed in `mdbase-dev/mdbase-connect#259` at merge
`86085d2335a8cd46fe21ba178815aeaea7479e90`; the annotated
`v0.1.0-beta.68` tag points at that exact merge. Npm publication, server CI, and
immutable signed image publication all passed. The candidate keeps the
beta66 coordinated runtime and beta67 provider-paging negotiation, and adds
single-flight desktop snapshot refreshes in both the renderer and main
process. Only `credential_store_unavailable` becomes the typed offline
snapshot with a bounded retry window; unrelated failures propagate and every
settled request releases capacity. The same merge also fixes the canonical
Editor staging OAuth callback contract and tests both accepted redirect forms.

Published staging images are pinned by digest:

- relay (unchanged):
  `sha256:21b5cce2a4692748358e8b0ab85a91f0d27ddd8c863760968928fe9c0a778ea0`;
- hosted provider:
  `sha256:7f63d3ff16a1ad09e626a0daf1ded022a9aa29104eb1429c0a765bdecae58ece`;
- Connect server:
  `sha256:f46752c2db2aa0a70dd639fb5c31b5924418651f754505cc660de6d76a956968`;
  and
- MCP:
  `sha256:73f1b45b65cfb2cfe509cd4a00a7780889fbf89e2e68e1ff360a1c0dceac2c06`.

The Linux, Windows, macOS Apple Silicon, and macOS Intel desktop release jobs
all passed, as did the release publication job. The public update manifest is
`0.1.0-beta.68` with rollout percentage `0`, so production users are not
offered the staged desktop candidate. Production itself remains exactly on the
beta55 tag commit `673e9e1ddab2a2a50a7cdb1506fd2a15ac4b61ef`.

Private operations PR `mdbase-dev/mdbase-cloud-ops#141` landed at
`9089d2718cc3715f98bccb05873315948c94dc11`. Its candidate manifest pins the
exact TaskNotes, Editor, Workouts, and Pickle commits. Deployment verified image
signatures and attestations, captured rollback state, confirmed there was no
database migration delta, skipped the unchanged relay, and promoted the hosted
provider, Connect server, and MCP sequentially. Exact digest checks,
health/readiness, entitlement reconciliation, synthetic operations, OAuth
device and semantic writes, all four candidate manifests, and R2 CORS passed.
The separate 15-minute post-deploy soak also passed on that exact ops commit.
Staging reports Connect and MCP revision `86085d2335a8cd46fe21ba178815aeaea7479e90`;
the hosted provider reports `0.1.0-beta.68` with notification recovery healthy
and zero consecutive failures.

The first deployment invocation was interrupted while the GitHub CLI stalled
during preflight, before any Render service changed. Its report incorrectly
labelled the interrupted exit-130 preflight as successful. The guarded rerun
used the same assertions and completed normally. Fixing that report
classification is an operations follow-up; it did not weaken or bypass a
deployment check.

The clean compatibility report shows only operation transport v3 in sampled
hosted and relay traffic, but it still found one recent active pre-beta57
connector plus legacy or unknown grant bindings and unbound hosted replicas.
The observation window is incomplete because telemetry began on August 10.
Compatibility removal is therefore explicitly not ready: keep the narrow
beta55-era bridge and its telemetry until the remaining client has upgraded or
aged out. This is a versioned boundary, not a second local runtime model.

### Coordinated consumers

All controlled SDK artifacts were packed from exact beta68 merge
`86085d2335a8cd46fe21ba178815aeaea7479e90` and audited for declared revision,
size, and SHA-512 consistency.

- TaskNotes `b0667ce12cf19d6b1f089e8014153e4797eca7f3` passed 397 tests,
  coverage/layer gates, 4,983 conformance cases, build, 20 browser tests, and
  Android build/push/restart smoke. `pnpm deploy:dev` published
  `https://staging.tasknotes-app.pages.dev/`.
- Pickle `2a3271b53573025e078a1b1bca83462c462d5261` passed 21 tests,
  format/lint/type/build, eight browser tests, and Android
  build/push/back/restart smoke. `pnpm deploy:dev` published
  `https://staging.pickle-9zb.pages.dev/`.
- Workouts `9ffc67c33c70cc9f66222de8d79ea88c475514f6` passed typecheck,
  24 tests, build, and ten mobile browser tests. The repository has no
  `deploy:dev` command; its PR deploy job is intentionally skipped.
- Reader `dbba0234856e8b13eeb63f4dd33122217d467e1c` passed its complete
  format/lint/architecture/spec/type, workspace-test, and build suites.
  `pnpm deploy:dev` published
  `https://mdbase-reader.pages.dev/` with that revision. Reader has no Git
  remote, so the exact local commit is the source record.
- Canonical Editor deployment passed from the beta68 merge. Its staging
  manifest contains both the plain staging callback and the query-bearing
  callback for `connect-staging.mdbase.dev`.

The TaskNotes, Pickle, and Workouts draft PR checks are green on those exact
heads. The PRs remain draft and unmerged; no production consumer was changed.

An independent Luna/Playwright pass used `staging-test@mdbase.dev` and a
disposable hosted collection against the deployed beta68 services. Editor
completed create/query/read/update/delete through the corrected OAuth callback.
TaskNotes completed real create/read/list/update/delete. Pickle completed its
available assess/change/describe/query paths; it exposes no request-creation UI.
Reader uploaded, created, queried, downloaded, and deleted a temporary source.
All four applications rendered and operated at 390 by 844 pixels. TaskNotes,
Pickle, and Reader had no console errors; Editor emitted only the known
nonfunctional Cloudflare Insights CSP block. Deleting the collection returned
all four applications to their expected reconnect or authorization-lost state.
The collection and grants were permanently removed.

### Migration, large collection, cancellation, and memory

The persistent desktop staging profile was migrated without replacement. Its
pre-beta67 backup remains byte-identical at 982 files and 1,196,000,004 bytes;
all 31 SQLite integrity checks passed. The same beta68 daemon preserved the
Reader and relay-fixture collection identities and remained connected through
both server cutovers, reconnecting in two to three seconds.

The Reader vault changed externally during acceptance from 1,507 to 1,508
records. At the final observation it contained 1,512 Markdown files, 2,851
files overall, and 10,225,385,614 bytes. No acceptance test mutated it. Direct
filesystem and daemon-routed queries agreed exactly at the current generation:
metadata SHA-256
`5ad5824892fbb93e1fe82f6c5b99beee89999679925766d1de0e82d924f0a58d`
and body SHA-256
`16a496851aca7b344911a9dd238bd48607b8b4b3dbfde75aa25a9b1063a4d136`.
Direct metadata/body queries took 762/801 ms; daemon-routed queries took
851/943 ms.

Generation-pinned cursor opening, advance, deterministic same-page reuse,
final-page advance, explicit release, and typed `generation_expired` after
release all passed. Ten 50-millisecond body-query cancellations returned in
52–54 milliseconds. Eight overlapping full-body reads and ten foreground
metadata reads all returned the exact current digests. The first foreground
read under maximum overlap took 5.427 seconds and the remaining nine took
833–869 milliseconds, with no stderr failure.

The shared daemon reached an allocator/runtime high-water mark near 873.6 MiB
after the accumulated migration, heavy binary, and Reader workloads. Across a
controlled three-minute post-load sample it stayed within 873,328–873,576 KiB
RSS and 860,554–860,833 KiB PSS, with 17 threads, 94–95 file descriptors, and
no child processes. This remains evidence of a bounded retained high-water
mark, not monotonic per-request growth; it is intentionally an observation and
not a release threshold.

The workstation login keyring later became locked while the already-running
daemon retained its relay credential in memory. Relay reconnect and ordinary
queries continued, but new mirror secret access returned the typed
`credential_store_unavailable` state. Restarting the exact beta68 desktop on
the same profile completed within the bounded bootstrap deadline and entered
offline local-control mode instead of hanging. An isolated, paired staging-test
profile using the repository's explicit test-only secret backend was then used
for the remaining relay acceptance. No credential was printed or copied into
the persistent profile. Recovery after an operator unlock remains an
operational ergonomics follow-up, not a reason to weaken system credential
storage.

### Deployed relay and binary acceptance

The final independent Luna pass paired a disposable beta68 connector and local
collection to `staging-test@mdbase.dev`, then authorized the deployed staging
Editor. Direct access was disabled and the SDK reported `relay` for every
operation, so this exercised the real staging Connect/NATS/daemon route rather
than loopback. Deterministic non-Markdown objects round-tripped with exact
SHA-256 values:

| Size | SHA-256 | Upload | Download and hash |
| --- | --- | ---: | ---: |
| 1 MiB | `06b7bbfb7824aa03382051691630eb26de85102d1b08a81e907ec0744cd8a286` | 2.742 s | exact match |
| 8 MiB | `0ff4d6c068be24637e84ea9f481c3c29f7afcdef1e06e1f40a68e5de85dcbb5b` | 4.762 s | exact match |
| 128 MiB | `e6c6c52c24cfd829d5e3c78668fcd4fa00c4232f9edf162279308f936b06b148` | 51.025 s | 45.188 s, exact match |

During the 128 MiB upload, 20 foreground relay queries all succeeded in
245–520 milliseconds. Aborting a 128 MiB relay download returned the typed
`operation_cancelled` result after 3.200 seconds, and an immediate relay query
succeeded in 315 milliseconds. This complements the ten 50-millisecond local
read cancellations and the exact post-dispatch durable mutation timeout/replay
suite; no mutation was treated as `not_sent` after durable dispatch.

The isolated daemon rose from 84,396 KiB RSS/58,657 KiB PSS to a transfer peak
of 100,928/72,017 KiB. After cleanup it stayed at 100,324 KiB RSS and
74,584–74,585 KiB PSS across the final three-minute window, with 9–10 threads,
25 file descriptors, three sockets, and no child process. The grant was
revoked, the collection was unregistered, all binary and collection files were
removed, and final collection, grant, and pending-authorization counts were
zero. Hosted collection and mirror behavior was already covered separately by
the beta68 deployed application lifecycle and the exact hosted-file and
adversarial suites; this pass intentionally concentrated on the real relay
binary path.

## Production promotion — beta68

The reviewed beta68 candidate was promoted to production on August 12. Before
promotion, operations PR `mdbase-dev/mdbase-cloud-ops#142` fixed interrupted
deployment reporting and landed at
`15bd83c09e7f398a69119c42626aeee0130c6156`; both hermetic repository checks
passed. Production pin PR `mdbase-dev/mdbase-cloud-ops#143` then changed only
`render/release.env` and the three beta68 image pins in `render.yaml`, landing
at `fb3cb35b8ea5d360bdd5bd18a30371ffd247fe64`.

Production workflow run `31555494420` completed successfully in 361 seconds.
Its retained artifact `production-deployment-state-31555494420` records release
commit `86085d2335a8cd46fe21ba178815aeaea7479e90`, operations commit
`fb3cb35b8ea5d360bdd5bd18a30371ffd247fe64`, and the exact beta55 rollback
images for provider, Connect, and MCP. Release preflight, exact staging
verification, platform preflight, rollback snapshot and migration safety,
provider/Connect/MCP deployment, entitlement reconciliation, and production
verification all passed. The unchanged relay image was correctly skipped.

Production now reports Connect and MCP revision
`86085d2335a8cd46fe21ba178815aeaea7479e90`. Hosted provider readiness reports
`0.1.0-beta.68`, recovery `ok`, and zero consecutive notification failures.
Independent production monitor run `31556193214` passed every service health
and readiness boundary and all application-manifest checks. The release
workflow's production verification also passed its OAuth device and semantic
write probes.

The controlled consumer commits were promoted immediately after backend health
gates passed:

- TaskNotes PR `callumalpass/tasknotes-app#116` merged at
  `7d9345308e5eec07f86243438d4f6b5888c2a4c8`; production deployment and smoke
  run `31555874437` passed.
- Pickle PR `callumalpass/pickle-android#25` merged at
  `86bdd048e430e12ef5ee9f79ba272c4a8120fb4f`; production run `31555878664`
  passed.
- Workouts PR `callumalpass/mdbase-workouts#24` merged at
  `c2b1d73c6b4e938b17ac41ace26f64f449284d52`; production run `31555881489`
  passed.
- Canonical Editor production run `31555891150` passed from exact beta68 merge
  `86085d2335a8cd46fe21ba178815aeaea7479e90`.
- Reader was deployed from local beta68 commit `588d2e6e3f50`; its deployment
  now has an explicit production target and serves build marker `588d2e6e3f50`
  at `https://mdbase-reader.pages.dev/`. The same changes were consolidated
  onto the local Reader `main` branch at `c02fbbf`.

Every live application manifest declares its production homepage and validates
against `https://connect.mdbase.dev`. The beta68 desktop public update rollout
remains at zero; server and web-application promotion did not opt desktop users
into an automatic update.

## Beta69 release, deployed acceptance, and production promotion

Beta69 packages and desktop artifacts were cut from exact Connect commit
`90334b9c4f6de306bdee5b6992a849362d508789`. Annotated tag
`v0.1.0-beta.69` resolves to that commit. NPM publication run `31569806332`
published the public Connect package set with the `next` dist-tag, and desktop
release run `31569806325` produced both macOS architectures, Linux, the
unsigned Windows preview, and the GitHub prerelease. The signed desktop update
manifest verifies with Sigstore, identifies beta69, and is at 100 percent
rollout.

The immutable beta69 production candidate was:

- unchanged relay broker
  `sha256:21b5cce2a4692748358e8b0ab85a91f0d27ddd8c863760968928fe9c0a778ea0`;
- hosted provider
  `sha256:c233855520ab7b4fa0e2a6576bebb29cdfa029eef57ad327cd303aebb3516888`;
- Connect server
  `sha256:1f157b98560fe4572b36425cc574e474e3c59469dbd5ec721783e29db0a310b2`;
- MCP
  `sha256:bc49fbd42a134601d508186ccab98fcc6c244c7de203aae793c2eb1ca0e8d7d5`.

Staging preparation run `31569820053` deployed those exact images and passed
health, readiness, synthetic, OAuth semantic-write, CORS, and application
manifest gates. A desktop daemon built from the exact beta69 commit remained
connected on protocol 3 while deployed acceptance ran under
`staging-test@mdbase.dev`.

Two disposable real Obsidian vaults used the exact beta69 plugin bundle and a
hosted collection. Zero-byte, one-byte, 1 MiB plus one byte, 64 MiB plus 13
bytes, and 96 MiB plus seven bytes all converged with exact byte counts and
SHA-256 values. Cancelling during the 96 MiB transfer produced the typed abort
and recovery-required states; resume then converged cleanly. Conflict creation,
stale-decision rejection, resolution, plugin reload, and a final zero-action
cursor all passed. Direct access was separately disabled for a forced-relay
collection: record CRUD, rename, delete, watch, all file operations, and a
deterministic 32 MiB plus 13 byte binary round trip passed while the reported
route remained `relay`. This complements the beta68 128 MiB relay, 9.6 GB
Reader collection, migration, restart, cancellation, and retained-RSS evidence.

Obsidian main `3dac58f4f4002a6b421d25bc099f3be93746900a` passed all 60 tests and its
mobile budget after moving to beta69; no Obsidian release was cut. Production
consumer deployments passed from TaskNotes
`4c1e63934741d8707d3fa8f0ce475db483cada3f` (run `31568975593`), Workouts
`5ef1333f31deca164219790e1cdcb1fd2727f8f0` (run `31568774272`), Pickle
`7f99435ffc15cc7db83fd60b09eaef04ca3f42b0` (run `31568778199`), and the
canonical Editor (run `31571762187`). Reader did not require a production
deployment; it was nevertheless deployed during the coordinated update, then
immediately replaced with a clean build from local main commit
`3556f55f8e0a298031f3416c990596bf5d90d47f` after unrelated working-tree UI
changes were detected. Those unrelated Reader changes remain untouched, and
Reader should not be changed further as part of this release.

Production pin PR `mdbase-dev/mdbase-cloud-ops#146` landed at
`d0dc1d52a35d7bb50f2513ce5a24db5a6d4d6dc`. The first promotion attempt,
run `31571916863`, correctly aborted because blanket reconciliation encountered
an active account without a hosted-storage entitlement, and it automatically
restored the exact beta68 images. Operations PR #148 then added a guarded,
paginated selector that reconciles only active accounts with hosted
collections, confirms production identity, performs one audited account at a
time, and emits a privacy-safe summary. Its first production use in run
`31573071508` successfully reconciled the selected account but rejected the
valid nested result because the wrapper asserted the old response shape; that
run also automatically restored the exact beta68 images.

Operations PR #149 corrected and tested the nested result validation, landing
at `3cd57259054b338ec11b93420d2bbb1018a1f088`. Final production promotion run
`31573899487` then completed successfully in 17 minutes 51 seconds. It deployed
the exact beta69 candidate, reconciled all 43 active hosted accounts, and passed
the workflow's production verification without rollback. A subsequent local
`bin/verify-production` independently confirmed all four live image digests,
service health and readiness, OAuth device and semantic web authorization
writes, application manifests, and browser-file CORS. Independent monitor run
`31575201645` passed the same production synthetic and application conformance
boundaries.

The two guarded failures are useful release evidence: deployment remained
transactional, rollback restored beta68 each time, and the final repair is a
narrow operations boundary rather than a compatibility branch in Connect.
Future account-wide maintenance should keep the same pattern: select only the
accounts for which the invariant applies, mutate serially with an auditable
per-account result, validate the API's exact result shape, and retain automatic
rollback around the entire promotion.

## Handoff

Beta69 production and its controlled web consumers are green. Keep the narrow
beta55-era protocol bridge and its telemetry until the remaining old client has
upgraded or aged out. The bounded-but-high retained Reader RSS and operator
recovery after a locked credential store remain operational follow-ups, not
evidence of an active leak or a reason to reintroduce duplicate runtimes.

Do not start a second Connect scheduler, restore a dual watcher, move binary
payloads off NATS as part of this program, or remove the narrow protocol bridge
while the compatibility report remains not-ready. Continue to treat exact
provider outcomes, bounded per-collection execution, request coordination, and
typed durable mutation settlement as the canonical design.
