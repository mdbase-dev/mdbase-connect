---
title: SDK and authority beta hardening
status: in_progress
priority: critical
owner: codex
tags:
  - beta
  - sdk
  - idempotency
  - sqlite
  - postgresql
  - recovery
  - developer-experience
  - user-experience
  - consumers
created_at: 2026-08-04T10:51:42+10:00
updated_at: 2026-08-05T11:04:54+10:00
progress_summary: Phases 0-5 remain green; the Phase 7 audit reopened Phase 6 because e1c documented independent compatibility axes without live enforcement. The live correction and all discovered system fixtures are now complete locally. Server CI 30964684133 proves relay, cross-platform durability, and beta.28 provider recovery, then exposed the hosted provider's stale generic operation wrapper and notification projection. Both now carry exact transport-v2/binding-v3 requirements while file/sync/encryption v1 remain independent; the complete hosted-provider E2E passes locally. One final replacement CI, a new immutable candidate, four exact-artifact repins, staging rollout, rollback, canaries, soak, and final audit remain. Production is untouched.
type: task
---

# SDK and authority beta hardening

## Outcome

Make mutation recovery, request completion, and database upgrade behavior safe
enough for an external beta; make the SDK a surface we are comfortable asking
other developers to learn; and prove the changes in the four current consumer
applications before inviting beta users.

The target is not a claim that distributed writes are magically exactly once.
The target is a precise and testable contract: every mutation has one durable
request identity; a retry either returns its recorded result, completes a
recoverable operation, or reports that its outcome is genuinely unknown. A
stale in-progress receipt must never be reported as a definitive rejection.

## Scope and repository map

The implementation repository is `/home/calluma/projects/mdbase-connect`.
Consumer migrations cover these canonical checkouts:

| Product name | Checkout | Current use |
| --- | --- | --- |
| mdbase Editor | `/home/calluma/projects/mdbase-editor` | Broadest SDK surface: application sessions, query/read/CRUD, guarded rename/delete, types/type packs, direct access, and watch. |
| TaskNotes | `/home/calluma/projects/tasknotes-app` | Direct collection authority, bounded in-session caches, files, native/browser authorization, notifications, and a separate application mutation journal. It deliberately has no application-owned offline task replica. |
| mdbase Workouts | `/home/calluma/projects/workout_tracker` | Online record CRUD, application sessions, cache invalidation, and Connect dogfood E2E. This is the current checkout for the `mdbase-workouts` repository. |
| Pickle | `/home/calluma/projects/pickle-android` | Record reads/responses, watch, native deep-link authorization, app lifecycle, and notifications. The sibling `/home/calluma/projects/pickle` repository is the CLI/inbox and is not an SDK consumer. |

All four currently consume vendored `0.1.0-beta.28` packages built from commit
suffix `58665cbf4e9a`. Consumer updates must continue to use one exact set of
artifacts produced from one mdbase-connect commit. Do not copy package sources
or mix artifacts from different commits.

## Program shape and immediate next goal

This task is the beta-hardening epic, not one implementation pull request.
Create and track one child task per delivery slice. The immediate next goal is
limited to Phase 0 plus Phase 1: freeze the public and distributed contracts,
record the complete green baseline, then land the numbered SQLite migration
foundation and its historical/fault fixtures. Do not begin the durable mutation
journal until those two exit gates are independently green.

The implementation and rollout orders are deliberately different. Use mdbase
Editor first to review the SDK surface and integrate the broadest API. Use
mdbase Workouts first when canarying the packaged release because it has the
smallest online mutation surface.

The full Phase 0–7 program is now the active execution goal. The ten delivery
slices below are tracked as child task records. Phase 0 and Phase 1 remain the
only active implementation slices until both exit gates are independently
green; this sequencing does not narrow the overall program goal.

## Non-negotiable contracts

1. This is the pre-beta breaking-change window. Prefer the smallest coherent
   SDK and protocol over preserving beta.28 names, call shapes, exports, wire
   messages, or internal storage layout. Remove obsolete compatibility façades
   in the same release after migrating all controlled consumers.
2. Ship the protocol, SDK, connector, hosted provider, control plane, management
   UI, and four consumers as one versioned release train. Keep package release,
   transport/wire protocol, signed authorization binding, semantic capability
   contract, and durable-mutation feature versions distinct. A mismatch names
   the incompatible contract and fails explicitly before the affected authority
   authorization, read, or mutation; peers do not silently downgrade the
   guarantee or provide a reduced authority compatibility mode. A package
   version difference alone is not an incompatibility when every contract used
   by the operation is supported.
3. Backward data migration is required even though API and wire compatibility
   are not. Existing beta.28 SQLite/PostgreSQL data, grants, and completed
   receipts must upgrade without loss. Take a recoverable pre-migration backup
   before any step that prevents the old version from reopening the database.
   Preserve grant records and audit history, but preserve a grant's validity only
   when its signed meaning can be represented exactly under the new authorization
   contract. Otherwise retain the record, mark it as requiring reauthorization,
   and never mechanically re-sign or broaden it.
4. Every public asynchronous operation terminates through success, a typed
   Connect outcome, cancellation, or a documented timeout. Raw `SyntaxError`,
   indefinitely pending `fetch`, and indefinitely waiting database acquisition
   are outside the public contract.
5. Markdown remains the source of truth for local collections. SQLite indexes,
   caches, and journals are recoverable support state. Recovery must not delete
   canonical collection files or silently discard grants and operation receipts.
   A Connect version mismatch may pause authority operations and sync, but must
   not prevent an application from reading its independent local replica or
   canonical Markdown where no incompatible authority call is involved.
6. Database rollback is an operational requirement, not a reason to carry two
   runtime models. Prefer reversible migrations; otherwise restore the verified
   pre-migration backup. Do not retain dual readers, legacy receipt paths, or
   dead columns merely so old binaries can continue against the new schema.
7. Correctness changes and large code movement land separately. Preserve a
   reviewable behavioral diff before splitting oversized modules.

## Phase 0 — freeze the contract and baseline

1. Write a short ADR for the mutation state machine. Define request identity,
   canonical request fingerprint, ownership/lease, fencing generation,
   prepared state, applied state, completed receipt, acknowledgement,
   abandonment, retry, conflicting reuse of a request ID, cancellation, and the
   only conditions that justify `operation_outcome: unknown`. Define journal
   retention, compaction, tombstones, and the supported recovery horizon so
   pruning can never turn an old retry into a duplicate effect. Define replay
   authorization after grant revocation and require each state transition to
   compare its current fencing generation before committing.
2. Generate one canonical set of mutating operation identifiers from protocol
   definitions. It must include record create/update/delete/rename, type
   create/update, type-pack apply, view-source create/update/delete, timer
   mutations, sync mutation batches, and file mutations if they use the same
   operation channel. SDK retry classification and authority dispatch must
   consume this definition instead of maintaining separate handwritten lists.
3. Write a compatibility matrix for the independent version axes: package
   release, transport/wire protocol, signed authorization binding, semantic
   capability contract, and durable-mutation feature set. Define the next value
   for each axis that actually changes, the typed mismatch for each boundary,
   and the coordinated deployment switch. Do not bump unrelated axes or
   negotiate the durable guarantee down for an old peer.
4. Draft the target public SDK before threading new behavior through it. Record
   the golden-path object hierarchy; the final `ConnectRequestOptions` shape;
   the durable pending/unknown mutation recovery handle; the complete typed
   outcome taxonomy; supported root and subpath exports; and browser/native
   callback shapes.
5. Test that draft against compile-only consumer integration spikes before
   freezing it. Cover Editor's full CRUD/type/type-pack/watch surface, Workouts'
   small CRUD repository, Pickle's native session/respond/watch lifecycle, and
   TaskNotes' sync/files/journal seams. Use temporary type fixtures or disposable
   candidate artifacts; do not commit half-migrated consumers. Incorporate the
   feedback, then freeze the public surface that Phase 3, Phase 4, and the real
   consumer migrations will implement.
6. Specify canonical fingerprint encoding across TypeScript and Rust. Include
   operation and schema version in the fingerprint, and explicitly exclude
   credentials, deadlines, retry counters, and other transport-only metadata.
   Do not use runtime-dependent JSON object serialization as the contract.
7. Record a green baseline for TypeScript build/typecheck/unit/E2E, Rust fmt,
   clippy, unit/integration tests, PostgreSQL/R2 suites, restart/race tests,
   browser storage/CSP/bundle checks, desktop tests, and the four consumers'
   existing verification commands.
8. Add a script or CI fixture that inventories Connect package versions and
   artifact commit suffixes in the four consumers. Fail if packages in one
   consumer come from different builds.

Exit gate: the state machine including fencing and retention, operation
catalogue, version matrix, consumer-tested and frozen public API, fingerprint
encoding, deployment switch, artifact inventory, and current green baseline are
reviewable before storage or protocol changes land.

## Phase 1 — introduce safe local SQLite migrations

Do this before adding the new operation journal so existing beta databases are
upgraded by the mechanism we intend to keep.

1. Replace ad hoc `CREATE IF NOT EXISTS` plus error-string-driven `ALTER TABLE`
   handling with numbered migrations and a durable migration ledger. Use
   `PRAGMA user_version` or an explicit schema table with migration checksums;
   never infer completion solely from a duplicate-column error string.
2. Establish the current beta schema as an idempotent baseline without
   recreating data. New profiles and upgraded beta.28 profiles must converge on
   the same schema.
3. Run each transactional migration atomically. For SQLite operations that
   cannot be fully transactional, record prepare/complete state and make every
   step safe to resume after process death.
4. Create a timestamped, permission-restricted backup of the registry before
   schema migration using SQLite's online backup mechanism or another method
   proved to capture a consistent database plus WAL state. Define retention,
   authenticated integrity metadata, and an explicit tested restore path. Never
   back up or log plaintext collection data unnecessarily.
5. On open and after migration, run appropriate integrity checks (`quick_check`
   by default, deeper checks in diagnostics). Classify corruption separately
   from an incompatible schema or a busy database.
6. Provide fail-closed recovery UX: preserve the damaged file, explain its
   location, offer diagnostic export, and offer a deliberate rebuild of
   rebuildable indexes. Preserve or restore grants and completed receipts when
   possible; never silently rebuild away authorization or recovery history.
7. Publish the exact historical-schema support matrix. Add fixtures for every
   supported schema and fault-inject process termination after every migration
   step. Reopen twice to prove both recovery and idempotence; verify backup
   restoration with both clean and WAL-active source databases.

Exit gate: beta.28 databases upgrade in place, new databases match them, every
injected migration interruption resumes safely, and corruption produces an
actionable error without touching Markdown.

## Phase 2 — one durable mutation journal across authorities

### Local connector

1. Replace the permanent `claimed but response is NULL` state with a durable
   journal keyed by application/grant/request ID and canonical request
   fingerprint. Persist the operation kind, input digest, state, lease owner and
   expiry, fencing generation, prepared execution data, recoverable result
   metadata, and final encrypted receipt.
2. Claim work transactionally. A repeated identical request returns the final
   receipt, observes a live lease, or takes over an expired lease and resumes
   from durable state with a new fencing generation. Every later transition
   must prove it still owns that generation. Reusing a request ID for different
   input is a permanent typed conflict. A process restart invalidates leases
   owned by the prior process epoch without relying only on wall-clock expiry.
3. For filesystem mutations, prepare enough information before applying the
   write to determine on restart whether it was not applied, applied exactly as
   planned, or interfered with externally. Define restricted temporary-file,
   expected before/after digest, atomic replacement, file and parent-directory
   flush, and cleanup semantics for the connector's supported platforms: Linux,
   macOS, and Windows. Mobile sync and filesystem adapters need their own
   durability conformance in the sync package and consumer suites; Android and
   iOS are not part of the Rust connector journal's platform gate.
   Persist post-apply evidence before publishing the final receipt without
   duplicating plaintext record content in the journal unnecessarily.
4. Reconcile the registry and filesystem as part of the recovery state machine.
   Do not convert the current 25-second wait into a longer wait; bounded waiting
   remains useful only while another live owner holds the lease.
5. If recovery cannot distinguish outcomes, return `operation_outcome: unknown`
   with a stable request ID and recovery action. Never return `rejected` merely
   because the original process disappeared.
6. Compact only under the ADR's retention contract. Preserve a request-ID and
   fingerprint tombstone for the full replay horizon, and expose privacy-safe
   diagnostics for receipts that cannot yet be pruned.

### Hosted provider and generic dispatch

1. Generalize the existing hosted record-operation receipt machinery into a
   provider-neutral mutation journal used by every mutating public operation.
2. Put operation execution and receipt commit in one PostgreSQL transaction
   wherever data lives in PostgreSQL. Preserve the existing row locks,
   constraints, working-set invalidation, and R2 staging/deletion journal
   behavior.
3. For R2 or other external side effects, use durable prepare/apply/finalize
   state and deterministic object keys so restart and replay are safe. Keep the
   database as the coordinator and preserve orphan reconciliation.
4. Add database uniqueness/foreign-key/check constraints for request identity,
   fingerprint, legal state transitions, and final receipt cardinality.
5. Add connector/provider capability reporting and control-plane enforcement.
   The control plane should expose an actionable minimum connector version but
   must not reinterpret authority outcomes.

### Proof

For every operation in the canonical mutator catalogue, inject termination at
claim, prepare, side-effect apply, registry/database reconcile, receipt commit,
and response send. Restart and resend the exact request. Assert one logical
effect and the same final receipt. Also cover concurrent duplicates,
request-ID reuse with different input, lease expiry/takeover, a stale fenced
owner attempting to commit after takeover, grant revocation before replay,
receipt compaction boundaries, clock movement/process epoch changes, and
explicit fail-before-write behavior for every mismatched contract version.
Run real filesystem durability conformance on every supported desktop platform,
not only in mocked process-kill tests.

Exit gate: no mutator can remain permanently `in_progress`; replay never
mislabels an ambiguous write as rejected; all advertised mutators pass the same
cross-authority conformance suite.

## Phase 3 — bound all I/O and normalize outcomes

1. Implement the Phase 0 `ConnectRequestOptions` contract consistently. Prefer
   one public relative deadline shape—`signal` plus `timeoutMs`, with an
   explicit `null` value to disable the SDK default for intentional long-lived
   work—and convert it to an absolute remaining budget internally. Use the
   breaking release to make method
   signatures uniform across every public networked method:
   session start/authorization/callback, describe/query/read, all record/type/
   type-pack/view/timer operations, sync/refresh, notifications, files, direct
   access, token refresh, and management client operations.
2. Add client-level defaults for ordinary requests, long polls/watch, uploads,
   and sync. Allow explicit override, including a documented way to disable a
   default deadline for intentional long-lived streams. Compose caller abort
   and deadline signals without leaking listeners.
3. Make retry policy deadline-aware. Never start a retry that cannot complete
   within the remaining budget. Cancellation before authority acceptance is
   `cancelled`; loss of contact after a mutation may have begun is `unknown`
   until the durable receipt is recovered.
4. Route every HTTP response through a boundary decoder. Invalid JSON, HTML
   proxy errors, empty bodies, and schema-invalid payloads become typed
   `invalid_*_response`/upstream outcomes carrying safe status and diagnostic
   context. No raw `response.json()` exception crosses the public SDK boundary.
5. Add PostgreSQL connect, pool-acquire, statement, idle-transaction, and lock
   timeouts appropriate to each workload in both the control plane and hosted
   provider. Map timeout classes to bounded service responses; do not reuse an
   HTTP request deadline as an unexamined universal database timeout.
6. Ensure UI busy state always clears on success, typed failure, timeout, or
   cancellation. Treat a watch as a bounded startup operation that returns an
   explicitly abortable subscription; do not model its intentional stream
   lifetime as an indefinitely pending ordinary request promise.

Exit gate: a test can black-hole HTTP and PostgreSQL calls without leaving a
public promise, pool checkout, transaction, or busy indicator unbounded; all
failure paths remain typed Connect outcomes.

## Phase 4 — SDK surface and internal code quality

### Beta-blocking public surface

1. Document one golden path: create `MdbaseConnect`, create/start an application
   session, subscribe to its snapshot, obtain the selected connection, perform
   an operation, and recover a pending mutation. Include browser and native
   callback examples.
2. Provide a small framework-neutral external-store adapter and a documented
   `useSyncExternalStore` helper. It must wrap the existing session rather than
   introduce a second state owner. A separate React package is optional
   follow-up work unless controlled-consumer integration proves it materially
   improves the frozen public surface.
3. Add explicit subpath exports such as `/advanced` and `/crypto` for low-level
   key stores, signing, PKCE, transport, and crypto helpers. Remove them from the
   root after updating the controlled consumers; do not retain deprecated root
   aliases solely for beta.28 compatibility.
4. Implement the Phase 0 decision for the current `Connect -> application
   session -> connection -> collection client` ladder. Keep distinct layers
   only where each owns a real lifecycle or capability boundary; collapse or
   rename transitional concepts while all consumers can be migrated together.
5. Add API-extractor/type fixture tests for the new supported imports and call
   shapes. Add negative fixtures for removed beta.28 entry points so accidental
   compatibility shims do not creep back in, plus package export, browser
   bundle, CSP, and tree-shaking checks. Set a
   bundle budget for the golden path and keep sync/notifications independently
   adoptable as described by the existing composable-SDK task.

Exit gate: the documented golden path is small, obsolete beta.28 entry points
are gone, the compile-only fixtures representing every controlled consumer still
compile against the new surface, advanced APIs have discoverable homes, and the
public API and bundle budgets are enforced. Full consumer migrations remain in
Phase 6.

### Follow-up internal extraction

1. Extract the large client, transport, file, portal authorization, and editor
   modules by behavior behind the new public façades. Suggested boundaries are
   session/auth, request/response transport, mutation recovery, query/watch,
   files, types/type packs, sync bridge, and notification lifecycle.
2. Keep focused tests adjacent to each extracted behavior. Retain end-to-end
   public API tests, but split the multi-thousand-line suites into conformance,
   auth, records, definitions, recovery, and transport groups.

This extraction is not a beta invitation blocker when the supported public
surface, correctness boundaries, tests, and bundle budgets are already clear.
Track and land it after behavioral hardening unless an oversized module directly
prevents safe implementation or review. Any extraction that does land must
produce no behavior or bundle regression.

## Phase 5 — management UX correctness

1. Replace refresh promise deduplication with generation-aware invalidation. A
   refresh requested after a mutation must observe a generation at least as new
   as that mutation; it must not join an older in-flight read and leave stale UI.
2. Make application revocation one server-side atomic/batch operation when the
   domain permits it. If grant-by-grant revocation must remain, report exact
   partial completion and always refresh in `finally` so the UI reflects truth.
3. Add timeout/cancel/retry presentation for management operations. Copy must
   distinguish rejected, timed out before acceptance, and outcome unknown.
4. Test rapid refresh/mutate races, double clicks, navigation/unmount, partial
   revoke failures, stale responses arriving out of order, and connector
   offline/upgrade-required states.

Exit gate: management actions cannot display pre-mutation state as current and
cannot leave an indefinite spinner or hide partial completion.

## Phase 6 — update and prove each consumer

First generate the next-beta artifact set with `pnpm package:consumer`, record
its source commit, and replace each consumer's vendored packages and lockfile
as one atomic change. Apply the common migration below, then the product-specific
work. Do not use consumer applications to paper over an authority defect.

### Common migration

1. Move low-level imports to the new subpaths where used; retain ordinary
   session/connection/outcome imports from `@mdbase-dev/connect`.
2. Use the shared session external-store adapter where it removes local glue.
   Keep product-specific repository and UI state outside the SDK.
3. Thread `AbortSignal` from component/repository lifecycles and set deliberate
   budgets for first load, foreground refresh, writes, background sync, and
   watches. Clear controllers on collection switch, unmount, app background,
   or superseding action.
4. Render typed recovery states for timeout, cancellation, incompatible Connect
   authority contract, and unknown mutation outcome. If an operation is unknown,
   retain its durable request ID and invoke SDK recovery; never issue a fresh
   mutation ID from a generic Retry button.
5. Add a consumer contract test that simulates response loss after authority
   commit, restarts the authority/client as relevant, resumes the exact pending
   mutation, and verifies one effect.
6. Run typecheck, lint/format, unit, build, E2E, manifest validation, package
   artifact consistency, and product-specific native/cloud tests.

### mdbase Editor — first implementation integration/reference application

1. Extend `MutationOperationOptions` and the gateway façade so read/create/
   update/type/type-pack/preflight operations receive the same signal/deadline
   support already used by query, watch, and progress mutations.
2. Replace the special-case retention of rename/delete preflights on `unknown`
   with the SDK's durable pending-mutation recovery object. Preserve progress
   and conflict presentation.
3. Exercise all mutator classes, especially type creation/update and type-pack
   application, because these expose gaps not covered by CRUD-only consumers.
4. Use the editor as the public golden-path and API ergonomics review. If its
   gateway still needs to translate many inconsistent SDK shapes, fix the SDK
   before documenting workarounds.

Required gates: `pnpm typecheck`, `pnpm test`, `pnpm build`, bundle/CSP checks,
Playwright, authorization recovery, watch reconnect, guarded rename/delete,
and type-pack response-loss recovery.

### mdbase Workouts — first packaged rollout canary

1. Thread request options through the small `connect-api` repository boundary;
   abort stale loads and writes when sheets close or collections change.
2. Make cache invalidation generation-aware so a timed-out or recovered write
   cannot be hidden by a stale in-flight read.
3. Add a compact recovery banner/action for an unknown write and connector
   upgrade, using the original request ID.

Required gates: typecheck/lint, unit, build, manifest test, ordinary Playwright,
and `test:e2e:connect`. This is the first real canary because it has a small
online CRUD surface and a focused Connect dogfood suite.

### Pickle — native lifecycle canary

1. Add abort/deadline handling to startup, authorization callback, definition
   updates, list/respond, watch, and notification binding. Abort or suspend
   foreground work when Capacitor backgrounds the app without losing pending
   mutation identity.
2. Ensure a response write that loses its HTTP response remains visible as
   pending and resumes when the app reopens; never submit a second response.
3. Handle native browser close, deep-link replay, offline transition, and watch
   restart through typed outcomes. Replace generic errors where recovery is
   actionable.

Required gates: `pnpm verify`, Playwright, Android smoke, deep-link callback,
background/foreground, notification binding, and response-loss/restart E2E.

### TaskNotes — final and hardest canary

1. Keep the application command journal and SDK/authority mutation journal as
   separate layers with explicit responsibilities: the application journal
   stores user intent and scheduling; the SDK journal stores transport request
   identity and authority outcome. Persist the mapping between their operation
   IDs so recovery cannot generate a duplicate write.
2. Thread deadlines/cancellation through session lifecycle, authorization and
   definition updates, direct repository operations, files, notification
   operations, and collection switching. Backgrounding suspends foreground
   authority work; foreground resume receives a fresh lifecycle signal.
3. Reconcile application-journal intent with recovered authority receipts
   before issuing a later write or canonical read. Test kill/restart during
   multi-record commands, rolling-occurrence maintenance, attachment operations,
   notification reconciliation, and collection lifecycle changes.
4. Preserve the direct-authority product boundary: a network timeout marks the
   collection unavailable and retains actionable user intent or drafts without
   reporting a false rejection. Bounded in-session caches must never become an
   application-owned offline replica or second synchronization authority.

Required gates: full `pnpm verify`, cloud E2E, browser E2E, production and Android
smokes, TaskNotes/mdbase conformance, lifecycle restart, provider conflicts,
files, notifications, collection switching, and authority response-loss
recovery.

Exit gate: all four consumers use one exact candidate artifact set, expose
correct recovery UX, and pass their complete relevant suites. TaskNotes is last
because it is the strongest integration test, not the first place to discover
basic SDK or authority defects.

## Phase 7 — rollout, observation, and rollback

1. Exercise the whole breaking release train in staging. Use blue/green or
   versioned deployment isolation so the old stack remains a rollback target,
   not a compatibility path inside the new stack.
2. Activate the new connector/desktop and hosted authority together with the new
   SDK consumers. Peers advertise their independent contract versions. A pairing
   returns a typed mismatch naming the incompatible contract before the affected
   authority authorization, read, or mutation only when a contract required by
   that operation is unsupported; package version difference alone does not
   fail. Do not offer reduced semantics for an incompatible authority contract.
   Applications with independent local replicas or canonical Markdown may
   remain locally usable while authority access and sync are paused behind an
   upgrade-required state.
3. Canary in this order: mdbase Workouts, mdbase Editor, Pickle, TaskNotes. Hold
   after each until logs/metrics and recovery tests show no unexplained pending
   journals, duplicate-ID conflicts, timeout spikes, pool exhaustion, migration
   failures, or user-visible stuck operations.
4. Add privacy-safe metrics for journal states/age, lease takeover, duplicate
   replay, unknown outcomes, timeout class, invalid response class, migration
   version/failure, SQLite integrity failures, and PostgreSQL pool/statement
   timeout. Never include collection paths, record contents, keys, or tokens.
5. Roll back the release train as a unit: restore the previous consumer artifact
   set and old service deployment, then restore the verified pre-migration
   database snapshot where the old binary cannot open the new schema. Do not
   implement dual receipt readers merely to make mixed-version rollback work.
6. Publish beta notes that describe guarantees and limitations precisely,
   including what users should do when a connector upgrade is required or an
   outcome remains unknown.

## Beta invitation gate

Do not invite external beta users until all of these are true:

- Every canonical mutator is covered by restart/replay conformance on local and
  hosted authorities, with no duplicate logical effect, false rejection, stale
  fenced-owner commit, or unsafe replay after journal compaction.
- beta.28 SQLite fixtures migrate safely under termination injection, corruption
  is preserved and diagnosed, and Markdown data is untouched.
- All SDK methods have bounded/cancellable behavior and all boundary failures
  are typed Connect outcomes.
- PostgreSQL pool acquisition, statements, locks, and transactions are bounded
  and pass saturation/failure tests without process crashes or leaked work.
- The management UI passes refresh-generation and revoke partial-failure tests.
- The four consumers use the same candidate artifact commit and pass the gates
  listed above, including response-loss/restart tests.
- Upgrade and whole-train rollback have been exercised in packaged,
  production-shaped environments; the supported contract matrix has been proved
  to interoperate, and every incompatible contract combination fails clearly
  before the affected authority operation.
- Public SDK docs, recovery guidance, changelog, package exports, and examples
  match the shipped behavior; the editor example is understandable without
  reading SDK internals.

## Delivery slices

Keep pull requests and commits reviewable in this order:

1. Contract ADR, version matrix, generated mutator catalogue, consumer API
   spikes, frozen public API, fingerprint encoding, artifact inventory, mismatch
   tests, and green baseline.
2. Numbered SQLite migration runner, backup/restore path, historical fixtures,
   interruption recovery, and corruption UX.
3. Local durable journal, fencing/retention implementation, filesystem
   durability, and cross-platform fault-injection suite.
4. Hosted generic journal, external-side-effect recovery, retention, and
   provider conformance.
5. Unified request options, timeout policy, boundary decoder, and database
   bounds.
6. Management refresh/revoke correctness.
7. SDK subpaths, external-store adapter, public docs, API fixtures, and bundle
   budgets.
8. Optional internal module extraction as a separately tracked, non-blocking
   slice unless it is required to implement or review a correctness boundary.
9. Candidate packaging and consumer migrations, one repository/PR at a time:
   Editor first for API integration, then Workouts, Pickle, and TaskNotes.
10. Dark/parallel authority deployment, coordinated activation, and packaged
    canaries in the order Workouts, Editor, Pickle, TaskNotes; then observation,
    release notes, and beta gate.

Each slice must leave the repository green. Do not combine a schema change, a
public API redesign, a large file split, and a consumer migration in one review.
