# ADR 0009: Cross-repository collection runtime execution contract

- Status: proposed (Phase 0 API audit)
- Date: 2026-08-11
- Connect baseline: `d4138fb93ea0606d141139c96062136fee1cd409`
- mdbase-rs baseline: `ca71aeb5b375c98de1cb5631ddffe6f89c264672`
- Companion provider review: `mdbase-rs/docs/architecture/collection-runtime-api-phase0.md`
- Companion fixtures: `mdbase-rs/docs/architecture/collection-runtime-api-fixtures.json`

## Context

Collection semantics currently cross the repository boundary as an operation result
plus Connect-side invalidation hints. mdbase-rs owns the collection, filesystem
transaction, cache, and watcher behavior, while Connect owns authorization, grants,
admission, application request receipts, routing, and lifecycle. The current
boundary does not carry a generation, an exact change set, or the filesystem
transaction identity. Consequently Connect infers invalidation from JSON and asks a
second watcher service to rescan after a successful operation.

The Phase 0 task, `Coordinated local collection runtime simplification.md`, requires
the provider to become the semantic owner. This ADR records the API and ownership
contract before any implementation or scheduler/NATS change. It does not change
runtime behavior.

## Decision

Define one provider-neutral execution contract in mdbase-rs. Connect adapts its
authorization and durable application-request machinery to that contract; it does
not reinterpret collection operation JSON or maintain a second collection watcher.
The mdbase-rs API review and fixtures are the normative provider-level draft. The
following names and invariants are the cross-repository agreement.

### Provider result types

The provider exposes the following conceptual Rust types. Exact module placement and
serialization are implementation details to be resolved in the provider PR; these
types must not include grant, application, or transport state.

```rust
struct CollectionGeneration {
    runtime_epoch: Uuid,
    sequence: u64,
}

struct CommitId(Uuid); // opaque mdbase filesystem-transaction identity

struct ExecutionOutcome {
    result: OperationResult,
    generation: CollectionGeneration,
    changes: ChangeSet,
    commit_id: Option<CommitId>,
}

enum ChangeSet {
    None,
    Exact(ChangeBatch),
    CollectionWide { reason: RebuildReason },
}

// One immutable mdbase-owned representation with bounded page iteration.
// Large known batches may be journal-backed rather than copied into Connect.
struct ChangeBatch { /* exact count, digest, bounded page reader */ }
```

`RecordChange` identifies created, updated, deleted, or renamed records and carries
the canonical path plus before/after revisions where available. A rename is one
logical change with its reference updates represented in the same atomic outcome;
callers must not reconstruct it from operation-specific JSON. `ResourceChange`
identifies configuration, type-definition, contract, view-source, and other
collection resources. An exact batch is consumed in bounded pages from one
immutable mdbase-owned representation, so a large atomic batch or
reference-updating rename is not copied into an unbounded `Vec` in every host
layer. `CollectionWide` is reserved for reconciliation or an external change that
cannot be narrowed safely; it is not an overflow fallback for a known mutation.

The provider also emits an external event using the same normalized `ChangeSet`:

```rust
struct ExternalChange {
    generation: CollectionGeneration,
    changes: ChangeSet,
    origin: ExternalChangeOrigin,
}

enum ExternalChangeOrigin { Filesystem, RecoveryReconciliation }
```

The event may have no `CommitId`: an external editor is not an application request
and does not have a Connect transaction identity.

### Prepare, commit, and cancel

The provider operation is split into an opaque prepared mutation and an outcome:

```rust
trait CollectionRuntime {
    fn read(&self, request: ReadRequest, pin: Option<CollectionGeneration>)
        -> Result<ReadOutcome, RuntimeError>;
    fn prepare(&self, request: MutationRequest, cancel: &Cancellation)
        -> Result<PreparedMutation, RuntimeError>;
    fn commit(&self, prepared: PreparedMutation)
        -> Result<ExecutionOutcome, RuntimeError>;
    fn cancel(&self, prepared: PreparedMutation) -> Result<CancelOutcome, RuntimeError>;
    fn resolve_commit(&self, commit_id: &CommitId)
        -> Result<Option<DurableCommitState>, RuntimeError>;
    fn recv_external_change(&self, timeout: Duration)
        -> Result<Option<ExternalChange>, RuntimeError>;
}

impl PreparedMutation {
    fn commit_id(&self) -> &CommitId; // available after durable prepare
}

enum DurableCommitState {
    Prepared,
    Committing,
    Committed { changes: ChangeSet },
    CancelledBeforeCommit,
    NeedsManualRecovery,
}
```

These signatures are intentionally conceptual. `prepare` may validate, resolve
references, calculate the exact change set, and stage the durable transaction. It is
cancellable until the canonical write boundary. A successful prepared handle exposes
its `CommitId` only after the mdbase prepared journal is durable. Connect must persist
the application-request-to-commit association before calling `commit`; the identifier
cannot first appear in the post-commit outcome.

`commit` owns the durable boundary: once canonical writes begin, it ignores caller
cancellation and completes or recovers the transaction. A lost response after that
boundary is `outcome_unknown`/pending at the Connect layer, never evidence that the
request was not sent. `cancel` is idempotent: before commit it releases an unclaimed
prepared transaction (`CancelledBeforeCommit`); after durable commit it reports
`AlreadyCommitted` and returns or permits recovery of the outcome.

The durable hand-off is therefore:

1. mdbase prepares and returns a durable opaque `CommitId`;
2. Connect records request ID → `CommitId` in its application journal;
3. Connect asks mdbase to commit; and
4. Connect records the final application receipt after commit or recovery resolves.

After restart, `resolve_commit` distinguishes prepared, committing, committed,
cancelled-before-commit, and manual-recovery states. mdbase proves its filesystem
write set; Connect independently proves what happened to the authorized application
request. An unclaimed orphan prepared before step 2 may be discarded without a
canonical write. A claimed prepared transaction is resolved from both journals and
must not be guessed from elapsed time.

The mdbase `CommitId` is the filesystem transaction identity and must remain
recoverable across process termination for as long as its journal or bounded
completed marker is needed to resolve a claimed Connect request. It is distinct from
the Connect application request ID. Connect stores the `CommitId` only in private
local durable request support state; it must never substitute one identity for the
other, use it as a grant identifier, or expose it to an application or transport as
a path/content locator.

### Admission and collection-executor ownership

Global/per-grant admission and the future per-collection executor are two bounded
stages with one deadline, not two independent schedulers that each believe they own
execution. Admission may reserve bounded queue accounting, but a request waiting for
its collection lane must not hold a global worker/read/mutation execution permit.

The collection lane marks only its runnable head work. A shared fair execution-budget
arbiter grants the existing global, work-class, and per-grant execution capacity at
the point the collection can start it. Only then does the executor enter mdbase's
runtime gate. Permit order is therefore queue slot → runnable collection head →
shared execution budget → mdbase runtime gate. Cancellation or deadline expiry has
one owner at each state transition and releases every later reservation in reverse
order. Mutation commit ownership transfers to mdbase at the durable boundary and is
the sole exception to caller cancellation.

This preserves the current reserved mutation, foreground-read, background, and
per-grant guarantees without allowing a slow collection to consume every global
worker while its requests merely wait. The implementation may centralize the fair
budget arbiter, but it must not replace the explicit collection lanes with a generic
unbounded actor mailbox.

### Generation and pinned reads

Every successful runtime state transition returns a `CollectionGeneration`. The
generation is opaque to Connect and SDK consumers except for equality and cursor
pinning. A paginated read may request a generation pin. If that generation is no
longer available (including after a runtime restart), the provider returns a typed
`generation_expired` result; it must not silently mix records from two snapshots.
Phase 0 does not require durable snapshot retention. A restart creates a new opaque
runtime epoch, and rebuildable caches/indexes are reconstructed from authoritative
state.

### State ownership

| State | Owner | Classification and rule |
| --- | --- | --- |
| Markdown records, files, configuration, type/contract definitions, view sources | mdbase-rs | Authoritative collection state; filesystem transactions are the only write path. |
| Transaction journal, staged entries, `CommitId`, bounded completed resolution markers | mdbase-rs | Durable support state; recover before accepting conflicting work and retain resolution long enough for claimed Connect requests. |
| Parsed collection, query/link indexes, compiled plans, watcher snapshot, runtime epoch | mdbase-rs | Rebuildable state; no caller treats it as collection truth. |
| Accounts, grants, scopes, application identity, request IDs/receipts/outcomes | Connect | Authoritative application/control-plane state; separate from collection truth. |
| Connect notification/change cursor derived from provider outcomes | Connect | Durable application support state; derived from provider `ChangeSet`, never a second collection authority. |
| NATS envelopes and transport retry metadata | Connect/protocol | Transport concern only; no semantic change in Phase 0. |

## Current-main evidence

The audit found the following existing seams that the contract replaces in later
phases:

| Current path | Evidence | Contract implication |
| --- | --- | --- |
| `crates/connect-core/src/registry/operations.rs:36-76` | Local operations select `with_collection` for batch/mutations and `with_collection_read` otherwise; successful mutation calls a synchronization callback. | Provider must return the exact outcome and changes so this callback becomes an adapter, not a second semantic path. |
| `crates/connect-core/src/registry/operations.rs:379-417` | Scoped operations repeat the same mutation/read split and invalidation callback. | Authorization remains Connect-owned; collection effects move behind the provider contract. |
| `crates/connect-core/src/registry/operation_execution.rs:477-515` | `operation_invalidation` decodes `OperationResult`, calls `OperationRequest::affected_paths`, and falls back to `All` for legacy/unknown envelopes. | Remove operation-specific JSON/path inference after cutover; preserve `CollectionWide` as an explicit provider result. |
| `crates/connect-agent/src/server/scoped_operations.rs:3-131` | Agent invokes the registry and then calls `watcher.synchronize` for local and sync operations. | Consume provider outcomes and publish normalized changes; do not rescan after known mutations. |
| `crates/connect-agent/src/watcher.rs:18-26,39-96` | A separate supervisor owns refresh/synchronize commands. | The duplicate watcher is temporary compatibility code and is removed only after the provider event stream is live. |
| `crates/connect-agent/src/watcher.rs:145-242` | Each collection has a `CollectionWatcher` worker; explicit `rescan`/`rescan_paths` and filesystem events are persisted separately. | mdbase-rs becomes the single watcher/runtime owner and emits normalized external changes. |
| `crates/connect-agent/src/server/files.rs:141-155,191-208` | File move/delete/upload commit call `watcher.rescan` after registry mutation. | File operations use `ResourceChange`/record changes from the same provider outcome. |
| `crates/connect-agent/src/server.rs:73-75,198-203` | `AgentState` owns the watcher and refreshes it from the collection registry. | Connect lifecycle owns registration, but provider lifecycle owns collection runtime/watch state after migration. |

## Fixture and API-review coverage

The companion JSON fixture file is deliberately provider-neutral and maps each
operation to an expected outcome. The adapter must preserve these mappings:

| Fixture | Provider outcome | Connect behavior |
| --- | --- | --- |
| Create record | `RecordChange::Created`, new generation, `Some(CommitId)` | Persist application outcome and commit metadata; publish the exact created change. |
| Update record | `RecordChange::Updated` with before/after revision | Persist and publish revisioned change; no path rescan. |
| Delete record | `RecordChange::Deleted` with prior revision | Persist and publish deletion; no inferred invalidation. |
| Rename with reference updates | Atomic `Renamed` plus verified reference updates in one `ChangeSet` | Deliver one outcome/change batch; do not decode `references_updated` from JSON. |
| View-source mutation | `ResourceChange::ViewSource`, unless provider cannot prove narrower scope | Rebuild affected view/query state according to resource kind; do not force collection-wide invalidation by default. |
| External edit | `ExternalChangeOrigin::Filesystem`, normalized record/resource changes, and no application request ID | Advance local change/notification cursors and reconcile; never manufacture an app receipt or commit ID. |
| Dry-run, invalid, or no-op | `ChangeSet::None`, no commit ID, no generation advance for rejected work | Return validation result without notification or cache invalidation. |

The mdbase-rs review document additionally records current implementation evidence:
`src/runtime/provider.rs:18-25,135-243,245-297`,
`src/runtime/filesystem.rs:12-65`,
`src/runtime/operation.rs:84-136`, and
`src/transactions.rs:63-97,203-242,287-384`. Those references show why the
provider API must own the operation gate, transaction recovery, and normalized
change production before Connect can remove its duplicate watcher.

## Compatibility and migration rules

1. Introduce the provider result behind an additive internal API. Keep the current
   operation envelope as an adapter while both sides migrate.
2. Preserve old profiles by rebuilding generation/index state from authoritative
   files and recovering any durable transaction journal before serving requests.
3. Treat a missing portable result envelope as a compatibility condition during the
   adapter period, not as proof of a particular path change. The adapter may use a
   conservative collection-wide rebuild until the provider contract is available.
4. Keep provider generation, change, and commit metadata inside the authority/runtime
   adapter in the current phases. Existing relay, loopback, hosted, and direct
   application responses do not expose `CommitId`. Generation enters a versioned
   application wire contract only when generation-pinned pagination is implemented;
   it does not require a NATS framing redesign.
5. A generation-expired cursor is a typed refresh/retry condition. A commit outcome
   that is not yet known remains pending/unknown until the provider or recovery
   reports it; it is not retried as a new mutation without the original application
   request identity.

## Phased implementation boundary

Phase 0 is complete when both repositories have reviewed this contract, the API
fixtures pass review, and the ownership/identity decisions are accepted. This
change intentionally does not implement behavior, alter the Connect scheduler,
change admission/fairness, modify NATS, or remove the watcher.

The subsequent implementation order is: provider types and outcome production in
mdbase-rs; a Connect adapter that consumes outcomes and external events; compatibility
and recovery tests; then removal of `operation_invalidation` and the watcher
supervisor/rescans after cutover evidence. Performance observations are informative
for the task but are not claimed by this documentation-only Phase 0 audit.

## Open review questions

- Should `CollectionGeneration` be persisted across restart, or should the runtime
  epoch always invalidate outstanding pins? This draft chooses invalidation because
  Phase 0 does not promise snapshot retention.
- Which provider error name and wire representation should encode
  `generation_expired` and `outcome_unknown` across all transports?
- Should exact external changes be batched by filesystem debounce interval or by
  transaction/recovery boundary? Either choice must preserve generation ordering.
- Which file operations are represented as `ResourceChange` versus record changes?
  The provider must decide once and expose the result, rather than requiring Connect
  to infer it.
