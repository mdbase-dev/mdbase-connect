# Work before connecting

Status: proposal. First consumers: TaskNotes and Editor.

An app may let a person start working before they sign in or choose a
collection. That work is kept only in this browser until the person connects
it to a synced collection. The SDK owns the storage and the handoff, so apps
do not each build their own.

## Product rules

- **One progression:** start working, connect a collection, continue
  there. Browser-only work is a way to begin, not another place to keep
  collections. It never appears in the collection list or switcher, and
  people cannot name it or make several.
- **Honest wording.** On the web, the status is "Saved only in this browser".
  In native shells it is "Saved only on this device". Once there is something
  worth keeping, the app shows one quiet, persistent prompt: "Connect to sync
  your work". "Saved", "Syncing" and "Saved on this device; waiting for sync"
  keep their current meanings and are never shown for this work.
- **Returning users stay where they were.** A signed-in person with a
  selected collection never lands in browser-only work. Signing out or a
  connection problem never silently starts a new browser workspace.
- **Nothing is lost silently.** After a transfer, the browser copy is kept
  for recovery until the destination has confirmed every item.

`PRODUCT.md` already describes "sync off" as a state of a collection, not a
kind of collection. This proposal follows that definition. The browser work is
a collection with sync off, held by this browser, and connecting turns sync on.

## What exists today

Three apps keep work in the browser before connecting, and each does it
differently:

| App | Storage | Handoff |
|---|---|---|
| Journal (`mdbase-journal`) | `localStorage` drafts, Web Lock per draft | Picks the record UUID and mutation ID before the create, then makes ordinary record creates into the first collection that opens |
| TaskNotes (PR #362, held) | Its own IndexedDB snapshot repository (`local-task-repository.ts`) | Reviewed status, priority and custom-field mapping, then creates records through an app ledger |
| Editor (`apps/editor`) | None: it starts only inside an open collection | — |

The runtime already has the parts needed to do this once:

- `mdbn-replica` has a **local-only mode** (`SyncMode::LocalOnly`). Commits
  confirm locally, `confirmed implies published` (`replica-client-api.md` §6),
  and there is no log.
- `TentativeStore` (`crates/store-file/src/tentative.rs`) is the browser and
  Capacitor SQL store (sqlite-wasm over OPFS `opfs-sahpool`). It keeps pending
  work across reopens and declares itself Disposable.
- **Adopt** (`crates/replica/src/replica/adopt.rs`, `snapshot.md` §7) turns
  sync on for existing content. It builds generation 0 from a source that
  names record IDs, uploads it and appends a `base`. Record IDs are kept.
  Policy lets a keyed non-hosted device sign a `folder` base.
- The generic WASM runtime already opens local-only replicas, but only over
  `MemStore`. The first-party app composition (`crates/wasm/src/app.rs`) is
  synced-only, with trust pins.

## Model: an unsynced collection

The SDK can create one **unsynced collection** per app and browser storage
scope. It is an ordinary local-only replica in the app's existing runtime
Worker, stored in a `TentativeStore`. Its device keys are created locally and
never registered with Connect. It has its own UUID, which is never sent to the
control plane.

Apps reach it through the same `MdbaseApplicationConnection` they use for a
synced collection. Records, files, queries, `describe`, types, record leases,
`observe` and link preflights all run in the same core. App code does not
branch on whether the collection is synced. TaskNotes' repository rule ("UI
and application code must not branch on storage") holds unchanged.

On creation, the unsynced collection is configured from the app's
declaration without a review step. It is new and empty, so there is nothing
to review.

### Runtime work

- A local-only first-party composition: `TentativeStore` plus `LocalOnly` mode,
  with no log endpoint, genesis or policy pins. It reuses the existing owner
  lease, tabs and Worker. `TentativeStore` currently assumes that only a log
  receipt means saved. Local-only gets its own durability statement: committed
  locally, origin storage may be evicted.
- An `AdoptSource` that reads from an unsynced replica, for turning sync on
  (below).

## API sketch

The feature is opt-in from the declaration options:

```ts
const mdbase = createMdbase(declaration, { unsynced: true });
```

A new phase. Apps render it like `ready`:

```ts
| { kind: "unsynced"; connection: MdbaseApplicationConnection; unsynced: MdbaseUnsyncedSummary }
```

`MdbaseUnsyncedSummary` has these fields:

- `items: number`: records and files.
- `persisted: boolean`: whether `navigator.storage.persist()` was granted.
- `state: "empty" | "has_work" | "transferring" | "transferred"`.
- `transfer?: { collectionId; progress; problem }`.

The phase applies when the app opted in, nobody is signed in, and nothing is
selected, or when the person returns to it from the chooser. In every other
phase, `snapshot.unsynced` carries the same summary so a ready app can offer
"N items are saved only in this browser".

The save state for this collection is a new `SaveState` value,
`"saved_in_browser"`. It is never `"saved_on_device"`, which means "waiting
for sync". Apps map it to the copy above.

Actions, each called from the user's gesture:

```ts
mdbase.unsynced.syncAsNew(options)            // A: turn sync on as a new collection
mdbase.unsynced.planTransfer(collectionId)    // B: review bringing it into an existing one
mdbase.unsynced.transfer(plan, { map })       // B: execute a reviewed plan
mdbase.unsynced.discard()                     // explicit, confirmed by the person
```

The SDK requests persistent storage on the first committed write. Losing
browser storage is the main risk, and Safari may clear script-written storage
for sites that are not used for a while. When `persisted` is false, the prompt
to connect becomes more prominent.

## Connecting

### A. Turn sync on as a new collection

This is the default path when the person has no collection yet, or chooses
"New collection" while connecting.

1. Sign in if needed. Connect creates an empty cloud-copy collection and
   approves it for the app in the same window.
2. The SDK opens a **fresh synced replica** for that collection and calls
   `begin_adopt` with an `AdoptSource` over the unsynced replica. The source
   names every record ID, the configuration and type resources, the inclusion
   settings and the files.
3. The base installs through the ordinary staged install. Record IDs, paths,
   types and settings are unchanged, so app caches and links by ID remain
   valid.

This path has no mapping and nothing to reconcile. It relies on Connect
writing no `entry` before the app appends the `base`; a log may hold policy
and rekey items before it (`snapshot.md` §7).

### B. Bring it into an existing collection

This path is used when the person picks a collection that already holds work.

- `planTransfer` compares the source with the destination. It reports
  configuration and type differences, path collisions, and records whose IDs
  already exist there.
- The app supplies `map(record) => CreateInput | null`. For TaskNotes, that
  is its status, priority and custom-field mapping. Editor needs no mapping
  beyond a path policy.
- `transfer` creates each record using **its source UUID** and a mutation ID
  derived from the transfer ID and record ID. Retrying is idempotent: an
  existing destination record with the same ID and digest counts as done.
  Progress is journalled in the unsynced store's host table. An interrupted
  transfer resumes after a reload, and a second tab sees the same progress.
- The destination's configuration is never replaced. Files are uploaded
  through the ordinary upload lane.

A file-level join (`snapshot.md` §9) is not used here. A join assumes both
sides are copies of the same collection; joining unrelated content would hold
every difference.

### After either path

- The connected collection becomes the selection, and the phase becomes
  `ready`.
- The unsynced collection becomes `transferred`. It is then bound to the
  destination's account scope: other accounts on this browser never see it,
  and signing out of that account erases it with the rest of that scope.
- The browser copy is kept until the destination has confirmed every
  transferred item, plus a recovery window (proposed: 30 days). It is
  reachable only from the app's collection settings, and the person can
  delete it there earlier.
- Starting fresh later (signed out, or after deleting the copy) creates a new
  empty unsynced collection. It never reopens a transferred one.

## Shared UI (`@mdbase-dev/ui`)

- `CollectionGate` and `CollectionPanel` render `unsynced` as usable. They
  show the persistent "Saved only in this browser · Connect to sync your work"
  line once `items > 0`.
- The connect flow is the existing sign-in and chooser, with one change. When
  there is unsynced work, the chooser leads with "New collection from this
  work" (A) and lists existing collections as "Add to …" (B). Path B goes
  through the app's own review only when `planTransfer` reports something to
  decide.
- The progress and recovery screens are shared, using
  `transfer.problem` and `describeError`.
- The collection switcher does not list the unsynced collection.

## Consumers

**TaskNotes.**

- Deletes `local-task-repository.ts`, its IndexedDB snapshot store and the
  app transfer ledger. The `TaskRepository` runs over the unsynced connection
  like any other collection.
- `local-transfer.ts` keeps only `suggestTransferPlan` and the status,
  priority and custom-value mapping, as the `map` for path B.
- PR #362 is rebased onto the SDK release before it merges.

**Editor.**

- Gains a workspace before sign-in: the gate renders `unsynced` like
  `ready`.
- Must stop treating `confirmedSeq` as the definition of a saved upload or
  readable file (`native-gateway.ts` file reads and uploads). For an unsynced
  collection, local confirmation is the final state.
- Its per-collection preferences keyed by `collectionId` need no change.

**Journal (later).** Its `localStorage` drafts could become records in the
unsynced collection, and its handoff could become path A or B.

## What this replaces

- TaskNotes' local repository and transfer ledger, and Journal's draft store
  and adoption logic: three app-specific mechanisms become one SDK mechanism.
- No new storage engine: the existing replica, `TentativeStore`, Worker,
  owner lease and adopt code are reused. The additions are:
  - one runtime composition (local-only app);
  - one phase;
  - one save state;
  - one SDK namespace (`unsynced`);
  - a transfer journal.

## Delivery

1. This note.
2. Runtime: the local-only app composition over `TentativeStore`, with tests
   for reopening, the owner lease across tabs, and storage faults.
3. SDK: the `unsynced` option, phase, summary, `saved_in_browser`, scope and
   persistence request.
4. Path A: an `AdoptSource` over an unsynced replica, and the Connect step
   that creates the collection and approves it for adoption.
5. Path B: `planTransfer` and `transfer`, with the resumable journal.
6. Shared UI.
7. Editor adoption, in this repository.
8. SDK release, then TaskNotes adoption and PR #362.

## Open questions

1. Does creating a collection in Connect ever append an `entry`, such as
   initial configuration, before the app could append `base`? If it does, path
   A needs Connect to create the collection "for adoption".
2. Base source: reuse `folder`, or add a `browser` value to the wire enum? The
   current proposal is to reuse `folder` unless provenance is needed for
   support.
3. Files and attachments in the unsynced collection: does the adopt source
   carry them in generation 0, or are they ingested after the base as ordinary
   creates, as folder adoption does?
4. Recovery window length (30 days proposed), and whether the person can
   restore from the browser copy or only export it.
5. Name: `unsynced` (matches "sync off" in `PRODUCT.md`) versus
   `beforeConnecting`. "Draft" is already used by record leases.
