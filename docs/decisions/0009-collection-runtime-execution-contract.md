# ADR 0009: Cross-repository collection runtime execution contract

- Status: accepted (Phase 0 contract review)
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
struct HostClaimId([u8; 32]); // opaque host-generated recovery token
struct ChangeEventId(Uuid); // durable provider-feed identity
struct ChangeWatermark(u64); // durable provider-feed ordering
struct OperationDeadline(Instant); // process-local absolute monotonic deadline
struct OperationContext<'a> {
    cancellation: &'a OperationCancellation,
    deadline: OperationDeadline,
}
struct ChangeFeedOwnerId([u8; 32]); // secret singleton host-feed capability
struct ChangeFeedTransferId(Uuid); // host-generated durable idempotency identity
struct ReadCursor { /* opaque provider snapshot pin and ordering state */ }
struct ChangeFeed { /* opaque fenced handle for the current owner process */ }
struct ChangeFeedBaseline {
    fencing_epoch: u64,
    acknowledged_through: ChangeWatermark,
    feed_head: ChangeWatermark,
}
struct ChangeFeedTransferIntent {
    id: ChangeFeedTransferId,
    current: ChangeFeedOwnerId,
    next: ChangeFeedOwnerId,
    expected_acked_through: ChangeWatermark,
}
struct ChangeFeedTransferReceipt {
    id: ChangeFeedTransferId,
    fencing_epoch: u64,
    acknowledged_through: ChangeWatermark,
    feed_head: ChangeWatermark,
}

enum PreparationOutcome {
    NoMutation(ExecutionOutcome),
    Prepared(PreparedMutation),
}

struct ExecutionOutcome {
    result: OperationResult,
    generation: CollectionGeneration,
    changes: ChangeSet,
    commit_id: Option<CommitId>,
    change_event: Option<(ChangeEventId, ChangeWatermark)>,
}

enum ChangeSet {
    None,
    Exact(ChangeBatch),
    CollectionWide { reason: RebuildReason },
}

enum RebuildReason {
    RecoveryReconciliation,
    ExternalChangeUncertain,
    ControlResourceChange,
    ChangeFeedRetentionGap,
}

// One immutable mdbase-owned representation with bounded page iteration.
// Large known batches may be journal-backed rather than copied into Connect.
struct ChangeBatch { /* exact count, digest, bounded page reader */ }
```

`RecordChange` identifies created, updated, deleted, or renamed records and carries
the canonical path, before/after revisions and canonical type sets, plus exact
changed frontmatter field paths and a body-change marker. A rename is one
logical change with its reference updates represented in the same atomic outcome;
callers must not reconstruct it from operation-specific JSON. `ResourceChange`
identifies configuration, type-definition, contract, view-source, binary/file, and other
collection resources. An exact batch is consumed in bounded pages from one
immutable mdbase-owned representation, so a large atomic batch or
reference-updating rename is not copied into an unbounded `Vec` in every host
layer. `CollectionWide` is reserved for reconciliation or an external change that
cannot be narrowed safely; it is not an overflow fallback for a known mutation.

The provider also emits an external event using the same normalized `ChangeSet`:

```rust
struct RuntimeChangeEvent {
    event_id: ChangeEventId,
    watermark: ChangeWatermark,
    generation: CollectionGeneration,
    changes: ChangeSet,
    origin: ChangeOrigin,
    commit_id: Option<CommitId>,
}

enum ChangeOrigin { KnownMutation, Filesystem, RecoveryReconciliation }
```

The event may have no `CommitId`: an external editor is not an application request
and does not have a Connect transaction identity.

### Prepare, commit, and cancel

The provider operation is split into an opaque prepared mutation and an outcome:

```rust
trait CollectionRuntime {
    fn read(&self, request: ReadRequest, context: &OperationContext<'_>)
        -> Result<ReadOutcome, RuntimeError>;
    fn open_read(&self, request: ReadRequest, context: &OperationContext<'_>)
        -> Result<ReadPage, RuntimeError>;
    fn read_page(&self, cursor: &ReadCursor, context: &OperationContext<'_>)
        -> Result<ReadPage, RuntimeError>;
    fn release_read(&self, cursor: ReadCursor, context: &OperationContext<'_>)
        -> Result<(), RuntimeError>;
    fn prepare(&self, request: MutationRequest, claim: &HostClaimId,
               context: &OperationContext<'_>)
        -> Result<PreparationOutcome, RuntimeError>;
    fn attach_prepared(&self, claim: &HostClaimId, context: &OperationContext<'_>)
        -> Result<Option<PreparedMutation>, RuntimeError>;
    fn commit(&self, prepared: &PreparedMutation, context: &OperationContext<'_>)
        -> Result<CommitAttempt, RuntimeError>;
    fn cancel(&self, prepared: &PreparedMutation, context: &OperationContext<'_>)
        -> Result<CancelOutcome, RuntimeError>;
    fn resolve_commit(&self, commit_id: &CommitId, context: &OperationContext<'_>)
        -> Result<Option<DurableCommitState>, RuntimeError>;
    fn resolve_claim(&self, claim: &HostClaimId, context: &OperationContext<'_>)
        -> Result<Option<(CommitId, DurableCommitState)>, RuntimeError>;
    fn change_page(&self, batch: &ChangeBatch, after: Option<ChangePageCursor>,
                   limit: usize, context: &OperationContext<'_>)
        -> Result<ChangePage, RuntimeError>;
    fn open_change_feed(&self, owner: &ChangeFeedOwnerId,
                        context: &OperationContext<'_>)
        -> Result<ChangeFeed, RuntimeError>;
    fn transfer_change_feed(&self, intent: &ChangeFeedTransferIntent,
                            context: &OperationContext<'_>)
        -> Result<(ChangeFeed, ChangeFeedTransferReceipt), RuntimeError>;
    fn ack_change_feed_transfer(&self, transfer: &ChangeFeedTransferId,
                                context: &OperationContext<'_>)
        -> Result<(), RuntimeError>;
    fn establish_change_feed_baseline(&self, feed: &ChangeFeed,
                                      context: &OperationContext<'_>)
        -> Result<ChangeFeedBaseline, RuntimeError>;
    fn read_change_events(&self, feed: &ChangeFeed,
                          after: Option<ChangeWatermark>, limit: usize,
                          context: &OperationContext<'_>)
        -> Result<RuntimeChangeEventPage, RuntimeError>;
    fn ack_change_events(&self, feed: &ChangeFeed, through: ChangeWatermark,
                         context: &OperationContext<'_>)
        -> Result<(), RuntimeError>;
    fn ack_commit_resolution(&self, commit_id: &CommitId,
                             context: &OperationContext<'_>)
        -> Result<(), RuntimeError>;
}

impl PreparedMutation {
    fn commit_id(&self) -> &CommitId; // available after durable prepare
}

enum DurableCommitState {
    Prepared,
    Committing,
    Committed { outcome: ExecutionOutcome },
    RejectedBeforeCommit { rejection: CommitRejection },
    CancelledBeforeCommit,
    NeedsManualRecovery,
}

struct CommitRejection { /* versioned canonical semantic failure, no content */ }

enum CommitAttempt {
    Committed(ExecutionOutcome),
    RejectedBeforeCommit { rejection: CommitRejection },
    SettlementPending { commit_id: CommitId },
}

enum CancelOutcome {
    CancelledBeforeCommit,
    AlreadyCommitStarted,
    AlreadyCommitted(ExecutionOutcome),
    AlreadyRejected(CommitRejection),
    NeedsManualRecovery,
}
```

These signatures are intentionally conceptual. `prepare` may validate, resolve
references, calculate the exact change set, and stage the durable transaction. It is
cancellable until the canonical write boundary. A successful prepared handle exposes
its `CommitId` only after the mdbase prepared journal is durable. Before calling
`prepare`, Connect generates an unguessable `HostClaimId` and durably records request
ID -> host claim. The provider stores only that opaque token plus a canonical mutation
digest. It does not acquire a Connect request or grant type. Connect augments its row
with `CommitId` before calling `commit`; the transaction identifier cannot first
appear in the post-commit outcome.

Every potentially blocking provider call receives one process-local
`OperationContext` with an absolute monotonic deadline and cooperative cancellation
token. Provider runtime/journal/feed gates use cancellable, bounded acquisition; the
current blocking `RwLock::read`/`write` seam is not sufficient. Connect applies the
same absolute request deadline before provider entry, but it does not assume that its
executor can bound a gate wait inside a generic mdbase host. Feed ownership conflict
returns a typed error rather than waiting for the other owner. Feed
open/transfer/baseline/read/ack, batch paging, cursor release, and resolution calls
are all bounded by a context.

Invalid/precondition-failed work, dry runs, and semantic no-ops return
`PreparationOutcome::NoMutation` with `ChangeSet::None` and no commit/event identity.
Connect finalizes that result and removes its unused claim. Only `Prepared` enters
the cross-journal hand-off below.

`commit` owns the durable boundary. Its context bounds runtime-gate/journal-lock
acquisition before the phase transition. Expiry there returns typed
`commit_not_started` and leaves the journal `Prepared`, allowing Connect to retry or
cancel the same durable request according to its journal. Once the fsynced
`Committing` transition wins, canonical settlement ignores caller cancellation and
completes or recovers the transaction. If the foreground context expires during
settlement, the provider returns `SettlementPending { commit_id }`; its durable
worker continues without retaining the caller task or Connect permits. A lost
response after that boundary is `outcome_unknown`/pending at the Connect layer,
never evidence that the request was not sent. `cancel` is idempotent: before commit
it releases a prepared transaction (`CancelledBeforeCommit`); after durable commit
it reports `AlreadyCommitted` and returns or permits recovery of the outcome.

The durable hand-off is therefore:

1. Connect durably records request ID -> new opaque host claim;
2. mdbase prepares that claim and returns a durable opaque `CommitId`;
3. Connect records claim -> `CommitId` and asks mdbase to commit; and
4. Connect records the final application receipt after commit or recovery resolves.

If Connect stops before step 2, `resolve_claim` is absent and the same request/claim
may prepare. If it stops after step 2 but before copying `CommitId`, `resolve_claim`
returns the prepared transaction. Reusing one claim with a different mutation digest
is `claim_mismatch`. After restart, `resolve_claim`/`resolve_commit` distinguish
prepared, committing, committed, rejected-before-commit, cancelled-before-commit,
and manual-recovery states. mdbase proves its filesystem write set or its durable
pre-write rejection; Connect independently proves what happened to the authorized
application request. A claimed prepared transaction is never guessed from elapsed
time or discarded merely because the host has not copied `CommitId`.
When the durable state is `Prepared`, `attach_prepared(claim)` reconstructs a new
process-local handle from the journal so recovery can commit or cancel; it does not
prepare again. Later states are resolved without requiring the lost handle.

Before `prepare` returns, the fsynced provider journal contains schema version, host
claim, commit ID, versioned mutation digest, stable event ID, and exact batch
count/digest/backing reference. The winning `Prepared -> Committing` transition runs
under the runtime ordering gate, rechecks filesystem preconditions, assigns the
then-next generation and watermark, and fsyncs them with `Committing` before the
first canonical write. Preparation does not hold that gate or reserve ordering gaps
while waiting for Connect. Recovery uses the descriptor to append or find the same
event before reporting success, including a crash after the final file write.

If the commit-time recheck observes an external edit or another failed precondition,
the same journal lock atomically records `RejectedBeforeCommit` with a versioned
canonical `CommitRejection`, releases the reserved event/batch backing, and fsyncs
that final state without assigning a generation/watermark or changing canonical
files. Claim and commit identity continue resolving to the same rejection until
Connect has durably finalized and acknowledged the original request's semantic
conflict receipt. Connect never maps this to cancellation, `not_sent`, or an absent
claim, and never retries it under a new application request identity.

The generation stored with `Committing` is historical to that runtime epoch. After a
restart, recovery preserves commit/event/watermark/batch identity but reports the
recovered observation in the new runtime epoch; it never revives an old generation
pin. Connect deduplicates effects by provider event ID, not generation equality.

The mdbase `CommitId` is the filesystem transaction identity and must remain
recoverable across process termination for as long as its journal or bounded
completed marker is needed to resolve a claimed Connect request. It is distinct from
the Connect application request ID. Connect stores the `CommitId` only in private
local durable request support state; it must never substitute one identity for the
other, use it as a grant identifier, or expose it to an application or transport as
a path/content locator. After its final receipt and derived change rows are durable,
Connect acknowledges commit resolution and the associated provider watermark so
mdbase may retire bounded support state.

Connect may remove a pre-prepare host claim only after `resolve_claim` is absent and
it has durably finalized the application request as `not_sent`. mdbase never
age-evicts claimed prepared/committing/unresolved-committed or unacknowledged
rejected state; it backpressures new preparation until Connect cancels, resolves and
acknowledges, or an explicit audited abandonment operation proves no write began.

Claims are collection-local; a movable filesystem root is not part of the digest.
Version 1 claim digests are SHA-256 over RFC 8785/JCS of spec profile, operation
name, normalized input, and explicit preconditions. Version 1 batch digests hash the
canonically ordered normalized change items. The provider
review defines the exact ordering; both repositories share fixtures for digest and
page boundaries rather than independently serializing them.

Cancellation has two clocks. The operation context stops provider gate acquisition,
validation, preparation, feed work, and a provider transaction while it remains
durably `Prepared`. The same absolute application deadline also stops waiting for a
response. Once mdbase durably records `Committing`, settlement continues in a
background recovery task that does not inherit the caller token or its foreground
deadline.

Provider `commit` and `cancel` use the same transaction lock and durably
compare-and-set `Prepared` to `Committing`, `RejectedBeforeCommit`, or
`CancelledBeforeCommit`. The fsynced phase transition is the linearization point.
The winner is idempotent; the loser returns the exact durable winning state. Two
reattached callers therefore cannot both cross the boundary.

| State observed when the deadline/cancellation wins | Connect response |
| --- | --- |
| before prepare | `operation_cancelled` with `not_sent` |
| prepared and provider confirms `CancelledBeforeCommit` | `operation_cancelled` with `not_sent` |
| provider reports `RejectedBeforeCommit` | final semantic failure for the original request; never cancellation or an absent claim |
| cancel/commit race is unresolved | pending/`outcome_unknown`; never `not_sent` |
| provider reports `Committing` or `Committed` | final outcome when available, otherwise pending/`outcome_unknown` |

Thus the outer deadline never labels a durable mutation `not_sent` merely because
the foreground handler stopped waiting. Reads remain cancellable throughout. Every
queue and provider wait is bounded, and durable settlement cannot retain a global,
per-grant, or collection-executor permit after foreground execution has detached.

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

### Durable change feed and bounded batches

Known commits and external/recovery observations share a durable, pull-based mdbase
feed. Each event has an opaque `ChangeEventId` and monotonic `ChangeWatermark` that
survive a runtime-epoch restart. The per-collection Connect runtime persists one
random, unguessable `ChangeFeedOwnerId` secret capability; it is never exposed as a
public identifier. `open_change_feed` fences a stale process handle and rejects a
different owner until explicit lifecycle transfer. This is a singleton consumer
contract, not a shared destructive cursor. Connect pages the feed, stages and
finalizes derived rows, then monotonically acknowledges the provider watermark.
Redelivery after a crash is idempotent. The provider's completed commit marker
includes the same event identity, so the direct mutation outcome and later feed
replay cannot create two app events.

Opening the same owner increments the provider's durable fencing epoch; the returned
`ChangeFeed` carries that epoch, Connect stores it as `consumer_epoch`, and every
read/ack verifies it. For transfer, Connect first durably records an unguessable
`ChangeFeedTransferId`, current/next owner capabilities, and the exact expected
acknowledged head. `transfer_change_feed` atomically persists that intent/result and
installs the next owner/epoch. A retry with the exact tuple returns the same receipt
whether the provider still has the old owner or has already installed the next;
anything else is `change_feed_transfer_mismatch`. Connect durably installs the
receipt in its feed state, then calls `ack_change_feed_transfer`. The provider retains
one completed receipt and rejects another transfer until that acknowledgement.
Acknowledgement atomically leaves a bounded tombstone for the last acknowledged
transfer ID, and repeating acknowledgement for that ID succeeds. A crash after
provider acknowledgement but before Connect deletes `connect_installed` therefore
repeats acknowledgement and completes cleanup; a crash on either side of the
provider/SQLite boundary resumes forward without losing the usable capability. Loss
of the old secret requires a user-confirmed
administrative rebaseline that creates a continuity barrier; normal startup cannot
seize the feed.

Before first provider cutover, `establish_change_feed_baseline` starts native
observation and atomically persists the authoritative watcher snapshot/feed head
under the runtime ordering gate. It is idempotent for that owner. Any startup race or
uncertainty creates the stable reconciliation epoch, so Connect can resume
`provider_baselining` after a crash without an observation gap. The returned
acknowledged watermark equals the feed head; its fencing epoch is the current opened
handle's epoch. After the initial baseline is durable, a retry returns that same
watermark/snapshot receipt even if a later external event is already pending; the
later event remains the first post-baseline event. Watermarks use checked succession
and never wrap.

The provider assigns known-commit and accepted-watcher generations/watermarks under
one runtime ordering gate. A prepared transaction does not retain that gate while
waiting for Connect; only its commit transition and filesystem settlement do.

Acknowledgement is contiguous. Equal or older acknowledgements are idempotent;
ahead-of-head or gap-skipping acknowledgement is `invalid_change_ack`. Reading after
head is empty. Reading before retained history creates/returns the live
`change_feed_reset_required` reconciliation barrier; it never advances silently.

No semantic event crosses an unbounded Rust channel. A capacity-one coalescing wake
signal may tell Connect to pull; the durable feed remains authoritative. Watcher
startup, backend/scan failure, or external edit pressure durably sets one versioned
provider reconciliation epoch with a stable event ID. Its state is
`Required -> Reconciling -> EventDurable -> Acknowledged`. Failed scans return the
same epoch to `Required`; restart from `Reconciling` retries it; restart from
`EventDurable` replays the same event. A successful scan atomically installs a
pending watcher snapshot, appends exact changes where safe or one
`CollectionWide(RecoveryReconciliation)` event, and records `EventDurable`. Only
provider-feed acknowledgement promotes that pending snapshot and clears the marker.
Activity after the durable event starts a following dirty epoch. Runtime health
reports this state as degraded instead of silently logging and losing the obligation.

An exact `ChangeBatch` has a digest, count, bounded page size, and one provider-owned
backing representation. Claimed known mutations reserve batch/event capacity before
durable prepare; exhaustion is `runtime_capacity_exhausted` before any canonical
write. External pressure cannot be rejected, so it coalesces behind a durable
collection-wide reconciliation marker held in a separately reserved emergency slot
and bounded descriptor area that ordinary batches cannot consume. Failure to persist
that emergency marker makes runtime health terminal/unavailable rather than claiming
continuity. Referenced known batches remain available
until both commit resolution and their provider watermark are acknowledged. Active
batches are never silently evicted. A process-local handle may expire, but reopening
an unacknowledged event reconstructs it from durable backing. Backing retires only
after acknowledgement; a later stale handle receives typed `change_batch_expired`.

Retention is finite and configuration exposes limits for pending events, metadata
bytes, active batch handles, page size, and acknowledged-state age. Unacknowledged
state does not age-evict and therefore backpressures new preparation. The implementation must test those
limits with deliberately tiny capacities. This is admission/backpressure policy, not
a second scheduler and not a reason to copy large change vectors into Connect.

### Connect persistence, scope, and privacy

Provider metadata is private authority support state. The Connect cutover migration
is additive and preserves every existing application cursor:

```sql
CREATE TABLE collection_runtime_feed_state (
  collection_id TEXT PRIMARY KEY,
  feed_owner_id TEXT NOT NULL,
  consumer_epoch INTEGER NOT NULL,
  next_expected_watermark INTEGER NOT NULL,
  processed_through INTEGER NOT NULL,
  acknowledged_through INTEGER NOT NULL
);

CREATE TABLE collection_runtime_feed_transfers (
  collection_id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL UNIQUE,
  current_owner_id TEXT NOT NULL,
  next_owner_id TEXT NOT NULL,
  expected_acked_through INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('intent', 'provider_transferred', 'connect_installed')
  ),
  provider_consumer_epoch INTEGER,
  provider_acknowledged_through INTEGER,
  provider_feed_head INTEGER
);

CREATE TABLE collection_runtime_cutovers (
  collection_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (
    state IN ('legacy', 'stopping_legacy', 'provider_baselining', 'provider')
  ),
  legacy_last_cursor INTEGER,
  continuity_barrier_cursor INTEGER,
  provider_feed_owner_id TEXT,
  provider_consumer_epoch INTEGER,
  provider_baseline_watermark INTEGER
);

CREATE TABLE collection_runtime_events (
  collection_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_watermark INTEGER NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'complete')),
  expected_item_count INTEGER NOT NULL,
  batch_digest TEXT NOT NULL,
  next_item_index INTEGER NOT NULL DEFAULT 0,
  first_application_cursor INTEGER,
  last_application_cursor INTEGER,
  processed_at TEXT,
  PRIMARY KEY (collection_id, provider_event_id),
  UNIQUE (collection_id, provider_watermark)
);

CREATE TABLE collection_runtime_event_items (
  collection_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  private_payload TEXT NOT NULL,
  item_digest TEXT NOT NULL,
  application_cursor INTEGER,
  PRIMARY KEY (collection_id, provider_event_id, item_index),
  UNIQUE (collection_id, application_cursor)
);

CREATE TABLE collection_change_heads (
  collection_id TEXT PRIMARY KEY,
  head INTEGER NOT NULL
);

CREATE TABLE collection_runtime_continuity_barriers (
  collection_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  provider_event_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (collection_id, cursor),
  UNIQUE (collection_id, provider_event_id)
);
```

Feed transfer is a four-step idempotent hand-off. Connect inserts `intent` before
calling mdbase. It writes the exact provider receipt and changes the row to
`provider_transferred`; retrying the provider with the stored tuple is safe if a
crash precedes that write. In one SQLite transaction it then verifies the receipt's
acknowledged watermark against feed state, replaces `feed_owner_id` and
`consumer_epoch`, and marks `connect_installed` without changing the existing
processed/acknowledged watermark. Finally it acknowledges the transfer receipt to
mdbase and deletes the intent row. Provider acknowledgement is idempotent for its
bounded last-acknowledged tombstone. Restart resumes from any recorded state; a crash
after the provider transfer but before SQLite therefore still has both owner
capabilities and the idempotency ID, while a crash after SQLite but before provider
ack repeats only acknowledgement. Owner capabilities are protected local support
state and never logged, transported, or returned to applications.

`next_expected_watermark` is the only event Connect may stage; the singleton adapter
never works ahead of a gap. Each bounded `change_page` is verified against its page
cursor and inserted into `collection_runtime_event_items` in a short immediate
transaction. A page must begin exactly at `next_item_index`; an earlier page is an
idempotent replay only when every item digest matches, while a later page is rejected
as `invalid_change_page`. Updating staged rows and `next_item_index` is one SQLite
transaction. After the exact item count and canonical rolling digest match the
provider descriptor, one final SQLite
transaction allocates a contiguous application-cursor range, uses ordered
`INSERT ... SELECT` to append the existing `collection_changes` rows without a Rust
`Vec`, marks the event complete, and advances `processed_through` and
`next_expected_watermark`. `collection_change_heads` is seeded from each collection's
existing `MAX(cursor)` and becomes the sole allocator/current-cursor source. A
zero-item or `CollectionWide` event increments that head and inserts only a row in
`collection_runtime_continuity_barriers`; no synthetic row enters
`collection_changes`.

For storage, `CollectionWide` uses `expected_item_count = 0`. Its version 1
descriptor is exactly the JCS object
`{"schema_version":1,"kind":"collection_wide","reason":<reason>}`, and
`batch_digest` is its SHA-256 digest. The closed version 1 reason strings are
`recovery_reconciliation`, `external_change_uncertain`,
`control_resource_change`, and `change_feed_retention_gap`; future reasons require a
new descriptor schema version.
Exact type sets are deduplicated and UTF-8 byte sorted; changed fields are
deduplicated canonical JSON Pointers in the same ordering. Each normalized record
item includes an explicit JSON boolean `body_changed`; it is never a field sentinel
and participates in item/batch hashing.

A crash during page staging resumes at the highest contiguous `next_item_index`. A
crash before the final transaction exposes no partial application event. A crash
after it finds a complete primary key and only advances/repairs
`acknowledged_through` after provider acknowledgement. The provider watermark may be
acknowledged only when every earlier event is complete. No existing
`collection_changes` row or cursor is rewritten. The final migration may add foreign
keys/indexes, but it must preserve the explicit feed-state row, page idempotency,
digest check, finalization atomicity, and cursor continuity rules.

Cutover is per collection and has exactly one application-change writer:

1. `legacy`: the existing Connect watcher is the sole writer. Provider outcomes may
   be observed in shadow mode but neither the direct handler nor provider feed writes
   application changes.
2. Under the collection executor and SQLite writer gate, Connect enters
   `stopping_legacy`, stops and joins that collection's legacy watcher, drains its
   already-produced events, then in one transaction records `legacy_last_cursor`,
   allocates a private continuity barrier, and enters `provider_baselining`. After
   this commit the legacy path is permanently fenced from `append_changes`.
3. While collection operations are paused, Connect persists a newly generated
   `provider_feed_owner_id` in the `provider_baselining` cutover row, opens that same
   owner, and asks mdbase to idempotently establish the feed-owner baseline and
   watcher snapshot under its runtime ordering gate. Any uncertainty becomes the same
   durable reconciliation epoch/barrier mechanism. A crash repeats open/baseline with
   the stored owner; the watermark/snapshot baseline is unchanged even though the
   reopened handle has a newer fencing epoch. If a post-baseline event arrived before
   the crash, the repeated baseline still succeeds and leaves that event pending.
4. Connect requires `baseline.acknowledged_through == baseline.feed_head`. In one
   SQLite transaction it inserts `collection_runtime_feed_state` with
   `feed_owner_id = provider_feed_owner_id`, `consumer_epoch = baseline.fencing_epoch`,
   `processed_through = acknowledged_through = baseline.feed_head`, and
   `next_expected_watermark = checked(baseline.feed_head + 1)`; records
   `provider_consumer_epoch` and `provider_baseline_watermark`; and enters `provider`.
   A checked-successor failure is terminal and never wraps. Only after this commit
   does the provider feed become the sole application-change writer and collection
   service resume. A crash before the transaction repeats step 3; a crash after it
   observes the complete `provider` state and never re-baselines.

Crash recovery resumes the recorded state forward; it never enables both writers.
An in-flight legacy database transaction finishes before step 2's writer-gate
transaction, and no new legacy event is admitted afterward. Rollback to legacy, if
needed during development, first stops the provider consumer and allocates another
continuity barrier. This intentionally trades one scoped refresh at beta cutover for
a simple no-gap/no-duplicate ownership boundary.

In `provider` state, the provider-feed finalizer is the sole writer of
`collection_changes`, including changes caused by a foreground mutation. The direct
mutation handler durably stores its application receipt with private commit/event
identity and sends only a coalescing feed wake-up; it never appends change rows. It
may return the mutation result before the feed event becomes visible, because reads
already observe committed collection state and the resumable changes stream is
eventually advanced by the durable feed. A caller that explicitly waits for change
visibility waits on the event's `complete` row with a bounded deadline. After a crash
between receipt and finalization, replay of that event ID stages/finalizes the rows
once; after the reverse ordering, receipt recovery joins the same event ID.

Application-facing change payload v2 contains only a schema version, normalized
event kind, collection-relative visible `path`/`from`, opaque before/after revisions,
matched authorized types, changed-field names, and an optional reset reason. It never
contains record snapshots, bodies/frontmatter, absolute paths, `CommitId`,
`HostClaimId`, provider event identity/watermark, transaction paths, grant IDs, or
application request IDs. Existing v1 rows remain readable during the additive
migration.

Connect projects each completed provider batch against the current grant at
read/delivery time. A
rename wholly inside a contract scope remains a rename; one leaving scope becomes a
delete, one entering scope becomes a create, and one wholly outside scope is absent.
For contract-scoped grants, resource changes that could alter type/scope semantics
become a private continuity barrier; resource paths are not disclosed.
`CollectionWide` is likewise stored only as a private barrier. An application whose
cursor crosses it receives the existing content-free `reset: true` page result and
refreshes through its authorized query/read projection; it does not receive a
synthetic event saying that unrelated content changed. This necessarily reveals only
that continuity cannot be proved, the same fact already exposed by retention reset.
The authorization snapshot is always the current grant when `changes` is read or a
delayed notification is evaluated; historical authorization never widens delivery.

The migrated `changes()` implementation consults the earliest private barrier after
the caller's `after` cursor before selecting visible rows. If one exists, it returns
no event payloads, `reset: true`, and the current `collection_change_heads.head`, so
the application's subsequent authorized refresh establishes continuity at the live
head. Barrier rows are never serialized as `CollectionChange`. Normal retention
prunes them only with the same reset boundary used for old change rows; a caller from
before retained history still receives `reset: true`.

Runtime notification criteria are evaluated locally against authorized normalized
events. A collection-wide barrier never directly triggers a push criterion. The
authority first reconciles the criterion's current authorized projection against its
last evaluation snapshot and signals only an actual authorized match; until that
finishes notification health is degraded/retryable. The cloud path remains the
existing content-free signal ID, grant ID, criterion ID, and opaque application
cursor; no provider-feed metadata crosses the control plane. This ADR therefore
changes neither notification transport nor NATS privacy boundaries.

### Generation and pinned reads

Every successful runtime state transition returns a `CollectionGeneration`. The
generation is opaque to Connect and SDK consumers except for equality and cursor
pinning. A paginated read may request a generation pin. If that generation is no
longer available (including after a runtime restart), the provider returns a typed
`generation_expired` result; it must not silently mix records from two snapshots.
Creating a cursor atomically pins the immutable query/index snapshot used by the
first `open_read` page. `ReadPage.next` is an opaque `ReadCursor`; `read_page` both
uses and renews its idle lease, and `release_read` ends it explicitly. Replaying one
cursor token before expiry returns the same page/next token, making response loss
safe. Connect never
reconstructs a cursor from a generation or reissues a later page as a new read.
Mutations may advance the active generation without altering that pin.
Pins have finite count/byte budgets, idle leases, hard lifetimes, and explicit
release; admission fails with `cursor_capacity_exhausted` rather than evicting a live
pin. Lease expiry, runtime close/restart, or a non-retainable rebuild returns
`generation_expired`. Phase 0 does not require durable snapshot retention. A restart
creates a new opaque runtime epoch, and rebuildable caches/indexes are reconstructed
from authoritative state. Recovered durable commits/events keep their stable IDs and
watermarks but are observed at a generation in this new epoch; any historical
generation retained in a receipt remains non-pageable audit metadata.

### State ownership

| State | Owner | Classification and rule |
| --- | --- | --- |
| Markdown records, files, configuration, type/contract definitions, view sources | mdbase-rs | Authoritative collection state; filesystem transactions are the only write path. |
| Transaction journal, staged entries, opaque host claim, `CommitId`, bounded completed resolution markers | mdbase-rs | Durable support state; recover before accepting conflicting work and retain resolution until the host acknowledges its receipt. |
| Provider change event IDs/watermarks, reconciliation marker, acknowledged watcher snapshot, exact batch backing | mdbase-rs | Durable support state; replay until monotonic acknowledgement and never silently discard known changes. |
| Parsed collection, query/link indexes, compiled plans, watcher snapshot, runtime epoch | mdbase-rs | Rebuildable state; no caller treats it as collection truth. |
| Accounts, grants, scopes, application identity, request IDs/host claims/commit associations/receipts/outcomes | Connect | Authoritative application/control-plane state; host claim and commit ID remain private recovery metadata separate from collection truth. |
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
| `crates/connect-agent/src/watcher.rs:45-49,99-103,179-193` | Supervisor, runtime-event, and per-worker command paths use unbounded channels. | Replace semantic delivery with the durable provider pull/ack feed; any wake channel is bounded and coalescing. |
| `crates/connect-agent/src/watcher.rs:208-215,223-231,277-280` | Rescan, watcher-stop, and persistence failures are logged while the worker can continue or exit without a durable retry obligation. | Provider persists `reconciliation_required`, exposes degraded health, and clears it only after acknowledged reconciliation. |
| `crates/connect-agent/src/runtime_notifications.rs:23-30,45-50` | Notification event and timer command inputs are unbounded; a rejected runtime event is only logged. | Change events are replayed from durable Connect rows; timer commands receive a separate finite command policy. |
| `crates/connect-agent/src/server/files.rs:141-155,191-208` | File move/delete/upload commit call `watcher.rescan` after registry mutation. | File operations use `ResourceChange`/record changes from the same provider outcome. |
| `crates/connect-agent/src/server.rs:73-75,198-203` | `AgentState` owns the watcher and refreshes it from the collection registry. | Connect lifecycle owns registration, but provider lifecycle owns collection runtime/watch state after migration. |

## Fixture and API-review coverage

The companion JSON fixture file is deliberately provider-neutral and maps each
operation to an expected outcome. The adapter must preserve these mappings:

| Fixture | Provider outcome | Connect behavior |
| --- | --- | --- |
| Create record | `RecordChange::Created`, new generation, `Some(CommitId)` | Persist receipt/commit/event metadata; wake the sole feed finalizer, which publishes the exact created change once. |
| Update record | `RecordChange::Updated` with before/after revision | Persist and publish revisioned change; no path rescan. |
| Delete record | `RecordChange::Deleted` with prior revision | Persist and publish deletion; no inferred invalidation. |
| Rename with reference updates | Atomic `Renamed` plus verified reference updates in one `ChangeSet` | Deliver one outcome/change batch; do not decode `references_updated` from JSON. |
| View-source mutation | `ResourceChange::ViewSource`, unless provider cannot prove narrower scope | Rebuild affected view/query state according to resource kind; do not force collection-wide invalidation by default. |
| External edit | `ChangeOrigin::Filesystem`, normalized record/resource changes, and no application request ID | Advance local change/notification cursors and reconcile; never manufacture an app receipt or commit ID. |
| Dry-run, invalid, or no-op | `ChangeSet::None`, no commit ID, no generation advance for rejected work | Return validation result without notification or cache invalidation. |
| Cursor across concurrent mutation | Every page reads the first page's pinned generation | Preserve the opaque provider cursor; never reissue the page against current state. |
| Cursor expiry/restart | Typed `generation_expired` | Return the versioned refresh condition; do not hide it with an automatic mixed-snapshot retry. |
| Cancellation before commit | Durable `CancelledBeforeCommit` | Only then return `operation_cancelled`/`not_sent` and retire the host claim. |
| Cancellation at/after commit boundary | Committing/committed state remains recoverable | Detach foreground wait, retain durable settlement, and return pending/`outcome_unknown` when final state is unavailable. |
| Crash after provider prepare | `resolve_claim` finds the same commit | Reconcile request -> claim -> commit without manufacturing a second mutation. |
| Crash after last file write | Recovery appends/finds journal's exact event descriptor | Persist one exact event and final receipt; never infer collection-wide effects. |
| Cancel/commit race | One durable provider phase transition wins | Map only confirmed cancellation to `not_sent`; otherwise settle the same commit. |
| Partial large-batch staging | Replayed pages retain item indexes and digests | Keep rows private until count/digest finalization; resume without duplicating app cursors. |
| Direct receipt before feed finalization | Same provider event remains pending | Return the mutation receipt; replay/finalize the event once after restart without a second direct write. |
| Grant narrows after a canonical event is staged | Provider event remains private authority support state | Project only through the current narrowed grant; prove no previously staged path, type, field, or resource metadata can be read through `changes()`. |
| Crash after provider feed transfer before SQLite receipt | Exact transfer tuple returns the same provider receipt | Resume the persisted intent, install the next owner/epoch once, acknowledge the provider receipt, and retain a usable fenced handle. |
| Crash after provider baseline before feed-state insert | Same owner returns the same watermark/snapshot baseline | Initialize processed/acknowledged at the baseline head and next expected at its checked successor; never replay pre-baseline events. |
| Watcher failure/restart gap | Durable collection-wide reconciliation event | Persist one private continuity barrier; return scoped `reset: true` only when a current grant crosses it. |
| Repeated reconciliation retry | Stable provider epoch/event identity | Do not create duplicate barriers or notification evaluations. |
| External rename without proof | Delete plus create | Apply scope projection to each side; never infer an identity from timing alone. |

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

The current transaction journal cannot satisfy this contract unchanged. Phase 1
must version/migrate its descriptor to add host claim/digest, stable event identity,
exact batch backing, commit-time generation/watermark ordering, cancelled state, and
acknowledged completed markers before Connect enables any provider cutover. Old
profiles recover their v1 journals with existing semantics first; only then may new
v2 preparation be admitted.

## Resolved review choices

- A runtime restart creates a new generation epoch and expires outstanding snapshot
  pins. Persisting snapshots across restart is outside this task.
- Provider errors use stable semantic names including `generation_expired`,
  `cursor_capacity_exhausted`, `change_batch_expired`, `runtime_capacity_exhausted`,
  `claim_mismatch`, and commit states. Their versioned application wire mapping is a
  later compatibility phase; Phase 0 does not change transport envelopes.
- One known atomic commit is one provider change event. External changes observed by
  one successful debounced final-state comparison are one event. Startup/recovery is
  a separate event boundary. Events are never merged across an acknowledged
  watermark.
- A configured record file is a `RecordChange`. Collection configuration, types,
  contracts, and saved-view sources use their explicit `ResourceChange` kinds. Other
  files, including binary objects managed by the file API, use `ResourceChange::File`.
  An external rename is emitted only when identity is provable; otherwise it is a
  delete plus create.
