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
- Connect's cloud-copy creation appends only policy items (`genesis`,
  `member-set`, enrolments) and a rekey. It never writes an `entry`. App
  setup (`approved-new-collection`) runs only after the app opens the new
  collection, so the SDK controls what is written first.
- The generic WASM runtime already opens local-only replicas, but only over
  `MemStore`. Before this work, the first-party app composition
  (`crates/wasm/src/app.rs`) was synced-only, with trust pins.

## Model: an unsynced collection

The SDK can create one **unsynced collection** per app and browser storage
scope. It is an ordinary local-only replica in the app's existing runtime
Worker, stored in a `TentativeStore`. Its device keys are created locally and
never registered with Connect. It has its own UUID, which is never sent to the
control plane.

Apps reach it through the same `MdbaseApplicationConnection` they use for a
synced collection. Records, queries, `describe`, types, record leases,
`observe` and link preflights all run in the same core. Files are the
exception in this version: a local-only replica refuses attachment uploads
with `upgrade_required`, and the grant's file actions omit `"add"`, so apps
hide attach as they already do for a read-only grant. App code does not
branch on whether the collection is synced. TaskNotes' repository rule ("UI
and application code must not branch on storage") holds unchanged.

On creation, the unsynced collection is configured from the app's
declaration without a review step. It is new and empty, so there is nothing
to review.

### Runtime work

- `rt_app_open_local` opens a local-only first-party composition:
  `TentativeStore` plus `LocalOnly` mode, with no log endpoint, genesis, policy
  pins or HTTP signer. Device keys are drawn fresh on every open and never
  stored; nothing is signed. The bootstrap is a small canonical CBOR map
  (collection, replica, device, opened state, SQLite version) with no secrets.
  Log binding, reconnect and control-plane binding are refused.
- It reuses the existing owner lease, tabs and Worker. `TentativeStore` assumes
  that only a log receipt means saved; for local-only, local confirmation is
  final, and the `unsynced` phase tells apps to say so (origin storage may be
  evicted).

## API sketch

The feature is opt-in from the declaration options:

```ts
const mdbase = createMdbase(declaration, { unsynced: true });
```

A new phase. Apps render it like `ready`:

```ts
| { kind: "unsynced"; collectionId; connection: MdbaseApplicationConnection; rechecking }
```

The phase applies when the app opted in, `start()` finds nobody signed in and
no collection requested, and the person did not just sign out; or when the app
calls `mdbase.unsynced.open()` from a gesture ("Continue without connecting").
Signing in from it shows the ordinary `authorizing` phase with the work still
open behind it. Choosing a collection leaves it.

There is no new save state. Local commits confirm at once, so the write
ledger reads `"saved"`; the phase tells the app to say "Saved only in this
browser" instead of "Saved".

Every tab's snapshot carries `unsyncedWork: {since} | null`, whichever
collection it shows. It is set by the first submit to the unsynced collection
and read at Worker start without opening the collection (or creating its
database). It is a marker, not a count: deleting records does not clear it;
only discarding the collection does. Apps use it to offer "Connect to sync
your work" and, when signed in elsewhere, to keep offering the transfer.

How it fits the existing session: the Worker keeps the unsynced collection
beside the sign-in session's collections and reports it as the tab's open
collection, with the session's own status alongside. Readiness, automatic
setup, tabs and ports therefore run unchanged. The URL selection never sees
it.

Actions, each called from the user's gesture:

```ts
mdbase.unsynced.open()                        // built
mdbase.unsynced.planTransfer({ map })         // built: B, review bringing it into the open collection
mdbase.unsynced.transfer(plan, { onProgress }) // built: B, execute a reviewed plan
mdbase.unsynced.syncAsNew(options)            // A: turn sync on as a new collection
mdbase.unsynced.discard()                     // explicit, confirmed by the person
```

The SDK already requests persistent storage at app start and reports the
answer as `snapshot.storage.persistent`; nothing new is needed here. Losing
browser storage is the main risk, and Safari may clear script-written storage
for sites that are not used for a while. When `persistent` is false, the
prompt to connect becomes more prominent.

## Connecting

### A. Turn sync on as a new collection

This is the default path when the person has no collection yet, or chooses
"New collection" while connecting.

1. Sign in if needed. The existing portal "New collection" flow creates an
   empty cloud-copy collection and approves it for the app in the same window
   (`created_collection_ids`, opened as `approved-new-collection`).
2. Instead of applying the declaration's setup, the SDK copies the unsynced
   collection's configuration and type resources into the new collection.
3. It then runs the same transfer engine as path B, with an identity map.
   Record IDs, paths, types and settings are unchanged, so app caches and
   links by ID remain valid.

This path has no mapping and nothing to reconcile. It does not use adopt:
adopt in the browser would mean building and uploading a generation-0
snapshot from the app Worker, signed by a device the service just enrolled,
for collections that are small by construction. One engine for both paths
is less to maintain, and every transferred record goes through the ordinary
create and upload lanes.

### B. Bring it into an existing collection

This path is used when the person picks a collection that already holds work.

- The destination is the collection the tab has open (`ready`). Choosing a
  collection in the connect flow opens it; the transfer then runs there.
- `planTransfer({map})` compares the source with the destination and writes
  nothing. Each record is `create`, `present` (its ID is already in the
  destination) or `skipped` (the map returned null). A taken path is renamed
  beside it (`todo.md` becomes `todo 2.md`), and types the destination lacks
  are listed in `missingTypes`; the records are still created.
- The app supplies `map(record) => CreateInput | null`. For TaskNotes, that
  is its status, priority and custom-field mapping. Editor needs none. The
  map may not change a record's ID.
- `transfer(plan)` creates each record using **its source UUID**, with a
  mutation ID derived from the intent `unsynced/1, source, record`. There is
  no journal: record IDs are random UUIDs, so an ID already in the
  destination came from an earlier transfer and counts as done, and the
  deterministic mutation ID makes a resent create the same write. An
  interrupted transfer, in this tab, another tab or after a reload, is
  resumed by planning again. Records that fail are reported in `failed`.
- The Worker attaches the unsynced collection to the tab only for the
  duration of a plan (`attachUnsynced` / `detachUnsynced`), beside the
  collection the tab shows, and closes it again when nothing holds it.
- The destination's configuration is never replaced. (There are no files to
  move in this version; see above.)

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
  transferred item, plus 30 days. It is reachable only from the app's
  collection settings, where the person can transfer it again (path B, which
  is idempotent) or delete it earlier. There is no separate restore.
- Starting fresh later (signed out, or after deleting the copy) creates a new
  empty unsynced collection. It never reopens a transferred one.

## Shared UI (`@mdbase-dev/ui`)

- `CollectionGate` and `CollectionPanel` render `unsynced` as usable. They
  show the persistent "Saved only in this browser · Connect to sync your work"
  line once `unsyncedWork` is set.
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
- Hides attach for the unsynced collection (its grant omits file `"add"`),
  and must not treat a missing `confirmedSeq` as unsaved: for an unsynced
  collection, local confirmation is the final state.
- Its per-collection preferences keyed by `collectionId` need no change.

**Journal (later).** Its `localStorage` drafts could become records in the
unsynced collection, and its handoff could become path A or B.

## What this replaces

- TaskNotes' local repository and transfer ledger, and Journal's draft store
  and adoption logic: three app-specific mechanisms become one SDK mechanism.
- No new storage engine: the existing replica, `TentativeStore`, Worker and
  owner lease are reused. The additions are:
  - one runtime composition (local-only app);
  - one phase;
  - one SDK namespace (`unsynced`);
  - a stateless transfer engine (no journal).

## Delivery

1. This note.
2. Runtime: the local-only app composition over `TentativeStore`, with tests
   for reopening, the owner lease across tabs, and storage faults.
3. SDK: the `unsynced` option, phase, Worker host, `unsynced.open()` and the
   `unsyncedWork` marker (built). The real app WASM is exercised by the
   runtime and SDK loader smokes.
4. Path B: `planTransfer` and `transfer` (built; idempotent without a
   journal). Still to do: the after-transfer lifecycle (`transferred`,
   account binding, recovery window, `discard`).
5. Path A: the portal's new-collection flow, resource copy, then the same
   transfer.
6. Shared UI.
7. Editor adoption, in this repository.
8. SDK release, then TaskNotes adoption and PR #362.

## Decisions

1. **Does Connect write an `entry` at creation?** No. Cloud-copy creation
   writes policy items and a rekey only, and app setup runs after open. Path A
   no longer depends on this, because it uses the transfer engine, not adopt.
2. **Files before connecting:** not in this version. The runtime refuses
   local-only attachments, and the grant hides attach. This can be revisited
   once a transfer can move attachment bytes through the upload lane.
3. **Recovery window:** confirmed plus 30 days. The copy can be transferred
   again or deleted; there is no separate restore or export.
4. **Name:** `unsynced`. It matches "sync off" in `PRODUCT.md`; "draft" is
   already used by record leases.
