# Record editing session

Status: **experimental** on branch `record-session`. Exported only from
`@mdbase-dev/connect/advanced`, not the stable root package.

The SDK's single operations (read, revision-checked update, outcome-unknown
recovery through `PendingMutationStore`, watch) stop short of "a record I have
open and am typing into". Three application-local implementations of that layer
exist today:

| Implementation | Location | Scope |
| --- | --- | --- |
| `NoteSession` + `NoteSessionStore` + `NoteOperationCoordinator` (+ `KeyedOperationQueue`, `pending-note-mutation.ts`) | `mdbase-connect/apps/editor/src` | title/body/frontmatter of the open note; background saves of other notes |
| `SourceDraftSession` | `mdbase-reader/apps/reader/src` | body of a source note, shared live text across panes, local crash drafts |
| `AnnotationEditSession` | `mdbase-reader/apps/reader/src` | body of an annotation, single-owner editor lease, memory only |

This document records how they behave, the semantics chosen for the SDK
session, and why.

## Correction to the brief

The brief places Reader's acknowledgement/false-conflict fix in
`SourceDraftSession`. It is actually in **`AnnotationEditSession`** (commit
`4fedb58`, `annotation-edit-session.ts` `incoming` queue), and the three
regression cases live in `annotation-save-acknowledgement.test.ts` and construct
`AnnotationEditSession` directly. `SourceDraftSession` does not defer
classification while a write is in flight: its `receive()` compares text
immediately, so it has the same latent bug if the shared resource publishes the
normalized response before `seen` records the acknowledged revision.

Consequence for step 4: moving only `SourceDraftSession` onto the SDK would not
exercise the regression tests. The SDK session therefore replaces the
**writer and classification** of both Reader sessions. The annotation
single-owner editor lease, deletion lock, and legacy-draft compatibility stay in
Reader as a thin wrapper, as the brief directs.

## Behaviour matrix

"Editor" = `NoteOperationCoordinator` + `NoteSession` + the `App.tsx` wiring
(`refreshCachedNote`, `applyRemoteDocument`, autosave effect, `keepLocalVersion`).

| Behaviour | Editor | Reader source (`SourceDraftSession`) | Reader annotation (`AnnotationEditSession`) | SDK decision |
| --- | --- | --- | --- | --- |
| **States** | `saved / waiting / saving / conflict / recovery`; `conflict` is also used for a plain save failure (UI label "Save failed"); `deleted` flag; separate `activity` for rename/delete/properties | `saved / unsaved / saving / error` + `conflict: Source \| null` + `recovered`, `locallySaved`, `localProblem` | `loading / saved / unsaved / saving / error` + `conflict` + `locked`, `editing` | `saved / unsaved / saving / conflict / recovery / error / deleted`. A failed write is `error`, not `conflict` (the editor conflation is a presentation bug: it hides whether a newer version exists). `waiting` ≡ `unsaved`. Lease/lock/loading/local-storage flags stay app-level. |
| **Autosave debounce** | 650 ms after the last draft change (React effect) | 1000 ms after the last edit | 1000 ms after the last edit, computed from `editedAt` | Idle debounce, `autosave.idleMs` per session; each app keeps its value. `autosave: false` for explicit-save surfaces. |
| **Edits during a save** | `saveAgain` → exactly one follow-up save of the latest draft | generation counter → `unsaved`, local store, reschedule the debounce | retained; after the write settles, reschedule the debounce | Coalesce: one follow-up write of the latest draft after the in-flight write settles, at `lastEdit + idleMs` (immediately if that has passed — annotation test "preserves typing during a slow save" requires the second write within 1 ms of settlement), or at once when `flush()` is waiting. |
| **Write serialization** | `KeyedOperationQueue` per session; rename/delete/properties also run through it | single `inFlight` promise | single `inFlight` promise; deletion `lock()` drains it | One write queue per record. Other record operations (rename, delete, whole-document replace) run through the same queue via `session.run(op)`. |
| **Revision check** | `update({ ifRevision: document.revision })` | **refresh before every write**, then `persist(current, body)` with the refreshed revision if the body is unchanged remotely | `persist(base, body)` with the base revision; refresh only after a failure | Write with the base revision. A stale revision is reported by the transport with the current record, then classified (below). Reader's source adapter keeps refresh-before-write inside its transport because its tests (and gateway) rely on it. |
| **External change while clean** | adopt remote (`applyRemoteDocument`) | adopt remote body | adopt remote | Adopt. |
| **External change while dirty** | **any** foreign revision ⇒ conflict (whole record) | conflict only if the remote *body* differs from both base and draft; metadata-only change rebases silently (tested: "permits metadata-only revision changes") | same as source | **Field-level three-way**: conflict only if a part the user changed locally (body, or a frontmatter key they patched) was also changed remotely to a different value. Otherwise rebase onto the remote revision and keep the draft. Rationale: Reader tests require it; the editor has no test or product rule requiring metadata-only conflicts; DATA_MODEL §23 forbids whole-document last-write-wins, which field-scoped writes satisfy. The editor currently sends the full frontmatter in `titlePatch`, which would clobber a remote metadata change on rebase; the SDK sends only dirty keys. |
| **Remote equals draft** | not recognized (still conflict) | not a conflict; saved | adopt and clear (tested: "uses the verified latest base when an older response follows a matching remote edit") | Convergent remote (same content as the draft for every dirty part) is adopted as saved. Exact equality, no normalization. |
| **Own acknowledgement vs external change** | waits for the queue, then `next.revision === document.revision` | `seen` revision set; **no deferral** during a write (latent false-conflict) | `seen` set **and** defers every incoming record while a write is in flight, then drops the acknowledged revision and classifies the rest | Deferral + revision identity: records received while a write (or recovery) is unsettled are queued; after settlement the acknowledged revision is recorded as seen and the remaining records are classified. Never by text comparison or whitespace trimming. |
| **Clean after an acknowledgement** | clean iff draft equals the *sent* draft (`persistedDraft = snapshot`); server text is not adopted | status `saved`, local text kept, but later comparisons use the server body, so a normalized response makes an unchanged draft look dirty | clean iff draft equals the sent body; the normalized server text is then adopted into the textarea | Clean iff the draft equals what was sent (mutation identity). The SDK never rewrites text under a live editor; it records that the sent text corresponds to the acknowledged revision. External changes are compared with the acknowledged *record*, local dirtiness with the *sent* text. A surface that wants the normalized text (Reader annotations) adopts it from `snapshot.record`. Comparing against the server body instead would loop forever when a serializer appends a newline. |
| **Stale publication** | request epochs; `revision === document.revision` | `seen` set (tested) | `seen` set | `receive()` (a publication, possibly stale) ignores revisions already seen. `refresh()` reads inside the write queue and applies the result even if its revision was seen before: record revisions are SHA-256 of the document bytes (`mdbase-rs` `operations/read.rs`), so an external revert repeats an old revision. The editor's watch path uses `refresh()`. |
| **Failed write** | reject; state `conflict`; no automatic retry; no re-read | `error`; one refresh to detect a conflict; explicit retry; draft stored locally | `error` unless the refresh shows a conflict or a convergent remote; no background retry loop (tested) | `error`; one read to classify (conflict / convergent / still error); no automatic retry. |
| **Outcome unknown** | `pendingSave = { requestId, draft }`; state `recovery`; next save **recovers** the exact request instead of writing; failed probe retains identity; SDK settlement (`isPending`) decides when the intent is resolved | none: a later save sends a **new** write (violates Reader DATA_MODEL §23) | none (same violation) | Editor semantics. `recovery` blocks new writes until the pending mutation settles; the recovered result is the acknowledgement; newer typing is retained and saved afterwards. **Reader is not wired yet**: its repositories wrap failures in `ConnectRepositoryError` and drop `request_id` (see risks). |
| **Rename / move** | explicit rename flow (preflight, `updateRefs`, own recovery); `NoteSessionStore.move` rekeys the same session | sources are keyed by Reader `id`; path looked up by id; session unaffected | same, by annotation id | Session identity is the session object, independent of path: the adapter writes to `base.path` of the current record, so a record received or refreshed at a new path is followed. An app-initiated rename runs through `session.run` and hands its result to `accept(record)`. Apps key their own session stores and rekey them (editor `NoteSessionStore.move`; Reader keys by record id). No protocol record id exists; no protocol change was needed. |
| **Deletion** | staged tombstone, `deleted` flag stops saves; delete runs in the queue | refresh returns `null` ⇒ error "no longer exists", draft retained | `deleted()` + `lock()` lease | State `deleted`; draft retained; no writes. App-owned delete flows run through `session.run`. Locking/leases stay in Reader. |
| **Multi-view sharing** | one session per note in `NoteSessionStore`; one active view | one session per source per gateway (module `WeakMap`), shared text, synchronous notification to every view; last view detaching does **not** cancel the save (tested) | one per annotation (cache), single editor owner | One session object shared by every view (an external store: `subscribe`/`getSnapshot`). **No registry or `retain()/release()` was built**: both apps already own keyed caches, and Reader's test requires the writer to keep going after the last view detaches, which reference counting would only have to work around. Listeners are notified synchronously on every edit. |
| **Local crash drafts** | none (memory only; the SDK pending store keeps outcome-unknown requests) | localStorage, batched checkpoints (500 ms idle / 3 s max), `baseBody` for conflict-on-restore, unload tracking | memory only; legacy IndexedDB read-only compatibility | Not an SDK store; the adapter boundary is the plug point. `restore({ body, baseBody? })` offers a draft (a conflict if its base is unknown or changed) and never writes by itself; `autosave()` resumes it. The app learns of its own acknowledgements inside its adapter's `write` (Reader clears its localStorage copy and publishes there). Reader and editor differ deliberately. |
| **Flush** | recover pending first; throw if remote conflict; loop until clean | loop `save()` while `unsaved`; throw on conflict/error; return base record | `save()` | `flush()`: settle recovery, then write until clean; reject on conflict, error or deletion; resolve with the saved record. |
| **Conflict resolution** | "Use latest" adopts remote; "Keep my edits" rebases onto remote and saves | `resolve("remote")` adopts and clears local copy; `resolve("local")` rebases, stores, saves | `resolve("remote")` clears; `resolve("local")` rebases, `unsaved` (tested: no write until an explicit save) | `resolve({ keep: "theirs" })` adopts; `resolve({ keep: "mine" })` rebases onto the remote revision and marks unsaved (autosave decides when to write); `resolve({ body })` for merged text. |

### Differences settled without product input

- Error vs conflict state (editor conflation) — fixed in the SDK; presentation
  follows.
- Whole-record vs field-level conflict — field-level (above).
- Outcome-unknown recovery — adopted for Reader; its DATA_MODEL already
  requires it.

No semantic conflict was found that the specs leave undecided.

## SDK shape

```ts
import { RecordSession, type RecordSessionAdapter } from "@mdbase-dev/connect/advanced";

const adapter: RecordSessionAdapter<MyRecord> = {
  revision, body, frontmatter,          // accessors over the app's record value
  write(base, { body?, patch? }),       // revision-checked against base; only dirty parts
  read?(base),                          // current record, or null when deleted
  recover?(requestId), isPending?(requestId)  // exact outcome-unknown continuation
};
const session = new RecordSession(record, adapter, { autosave: { idleMs: 1000 } });
session.subscribe(listener); session.snapshot;   // { state, body, frontmatter, record, remote, dirty, error, pendingRequestId }
session.setBody(text); session.patchFrontmatter(patch);
session.receive(record);   // publication from another view/resource
await session.refresh();   // authoritative read behind this session's writes
await session.save(); await session.flush();
session.resolve({ keep: "mine" | "theirs" } | { body });
session.discard(); session.accept(record); session.markDeleted();
await session.run(operation);  // rename/delete/etc. in the same write queue
session.restore({ body, baseBody }); session.autosave();
```

Differences from the brief's indicative API, with the evidence:

- **Adapter, not `connection.records.open(path)`.** A connection-bound adapter
  was written and then removed: neither consumer could use it. Reader writes
  through its own repositories (domain `Source`/`Annotation` values), and the
  editor must also run on its demo gateway. It would be about 30 lines to
  restore when a third-party consumer exists.
- **No registry or `release()`** (see the multi-view row).
- **`refresh()` added** (see the stale-publication row).
- `save()` rejects when its write or recovery failed. Autosave swallows the
  rejection, and the snapshot carries `error`.

The session builds on the existing operations and durable pending mutations
through the adapter (`update` with `ifRevision`, and `pendingMutation(id).recover()`
in the editor gateway). It does not duplicate `PendingMutationStore`. Recovery
across a page reload stays app-level: the editor's pending-mutation toasts list
`connection.pendingMutations()`.

## Record groups (open question, not built)

Nothing in either app needs grouping. Per-record sessions plus an app-level
coordinator suffice for a manuscript of chapter records. The coordinator
keeps a `Map<id, RecordSession>`, derives an aggregate state from the member
snapshots (for example "conflict if any member conflicts"), and flushes by
`Promise.all(members.map((s) => s.flush()))`. Watch events are routed to
`refresh()` per path. What per-record sessions cannot give is **atomic
multi-record writes**. If the writer spike needs them (for example moving a
passage between chapters as one revision-checked change), that is a
protocol/batch-operation question, not a session feature. It should be
settled there before any group API is added here.

## Results

### Added

| | Lines |
| --- | --- |
| `packages/client/src/record-session.ts` | 453 |
| `packages/client/src/record-session.test.ts` (39 tests) | 548 |
| `/advanced` exports + `public-api.json` | 10 |
| Reader `packages/connect/src/record-session.ts` (re-export) | 8 |

### Deleted or replaced

| | Before → after |
| --- | --- |
| editor `note-operation-coordinator.ts` + test | 215 → deleted |
| editor `operation-queue.ts` + test | 74 → deleted |
| editor production code overall (`apps/editor/src`, excluding tests) | +186 / −374 |
| editor tests (excluding the deletions above) | ported to the new contract; coordinator cases moved to the SDK |
| Reader `source-draft-session.ts` | 263 → 254 (writer/classification now SDK; checkpoints and publication stay) |
| Reader `annotation-edit-session.ts` | 261 → 213 (writer/classification now SDK; lease, lock and legacy drafts stay) |

The app-local writers are gone: no fourth parallel implementation remains.
Overall production code is **not** net smaller, though: the SDK adds about 450
lines, the apps remove about 230 net, and Reader's wrappers still map
snapshots and own device checkpoints.

### Commands run

connect worktree:

- `pnpm --filter @mdbase-dev/connect test`: 18 files / 371 tests pass
  (baseline 17 / 334).
- `pnpm --filter @mdbase-dev/connect test:public-api`: passes (inventory
  updated for the new `/advanced` names).
- `pnpm typecheck` (root): passes.
- `pnpm test` (root): **fails in `@mdbase/connect-desktop`**, which runs first:
  "Electron failed to install correctly" in this worktree's
  `node_modules/electron` (the error ends with `locales`: File exists). This is
  an installation problem in the new worktree; the desktop package does not use
  the SDK session. Because root `test` chains with `&&`, the remaining
  packages were run with `pnpm --filter '!@mdbase/connect-desktop' -r test`:
  all pass (client 371, editor 469 + script test, server 643 passed / 35
  skipped, sync 204, and the rest).
- Editor: `pnpm test` 59 files / 469 tests pass (baseline 61 / 476; the
  difference is the deleted coordinator/queue tests and the consolidated
  recovery test). `pnpm test:e2e` 55 / 55 Playwright tests pass, run twice.
  `pnpm build` and `pnpm check:bundle` pass (160.3 KiB initial JS).
- **Not run:** `pnpm e2e`, `pnpm test:system`, `cargo` (no Rust or protocol
  changes).

Reader worktree (linked to this SDK):

- `pnpm typecheck`: passes. `pnpm test`: passes (reader app 90 files / 346
  tests; `packages/connect` 23 / 74), with every session test and the three
  false-conflict regressions **unchanged**.
- `pnpm check:architecture` and `check:spec`: pass. `pnpm lint:code` and
  `format:check` fail **only on files not touched here** (`EnvironmentBadge.tsx`,
  `environment-badge.css`, `packages/connect/src/source-imports.test.ts`,
  `apps/extension/src/save-capture.ts`); the same errors occur on Reader `main`.
- Shared-editor browser fixture (`READER_AUDIT_SHARED_EDITING_ONLY=1`): fails
  on **Reader `main` and on this branch** at the same step, because commit
  `55b3b05` renamed the conflict button to "Keep mine" while
  `scripts/audit-simple-annotations.mjs` still clicks "Keep my changes". With
  that selector changed locally (not committed), both pass all 7 scenarios.
  Keystroke latency, 42 keys per run (median / p95 / max next-frame ms):

  | Run | main | branch |
  | --- | --- | --- |
  | 1 | 5.0 / 7.3 / 8.4 | 7.3 / 16.0 / 16.3 |
  | 2 | 14.5 / 15.9 / 16.5 | 4.3 / 15.8 / 16.5 |
  | 3 | 15.5 / 16.4 / 16.8 | 14.8 / 16.1 / 16.4 |
  | 4 | 5.4 / 11.2 / 16.6 | 7.3 / 8.8 / 13.3 |

  No long tasks in any run. The values sit at the ~16.7 ms frame boundary and
  vary as much between runs of the same build as between builds; there is no
  measurable difference.

### AGENTS.md handoff questions

- **What does this replace and delete?** The editor's
  `NoteOperationCoordinator`, `KeyedOperationQueue`, `NoteSession`'s
  save/conflict/recovery fields, `applyRemoteDocument` and the autosave effect,
  and the gateway's inline recovery. It also replaces the writer and
  classification inside both Reader sessions.
- **Evidence each new state is reachable:** every `RecordSessionState` and
  every adapter branch has an SDK test. `deleted` is reached through
  `read → null` (Reader) and `markDeleted` (editor, after a committed delete).
- **Invalid input vs invariant failure:** revision rejections and failed writes
  are expected and become `error`/`conflict` states. Missing recovery support
  is an explicit refusal ("No new write was attempted"), not a fallback.
- **Compatibility:** Reader's `pnpm.overrides` link is temporary. Its consumer
  is this proof, and it is removed before merge (commit `d8843bb`). No other
  compatibility paths were added.
- **New abstractions:** one, the `RecordSessionAdapter`. It is the transport
  boundary, with three implementations (editor gateway, Reader source
  repository, Reader annotation repository).
- **Public/persisted/user-facing expansion:** new `/advanced` exports (marked
  experimental). Nothing new is persisted. In the editor, a metadata-only
  external change no longer causes a conflict, and a failed save shows "Save
  failed" rather than being classed as a conflict.
- **Net simplification:** yes for the apps (one writer instead of three, and
  the editor's coordinator is gone). No for total line count; see Results.

### Remaining risks and follow-ups

1. **Reader outcome-unknown recovery is not wired.** `ConnectRepositoryError`
   drops `request_id`, so Reader still retries as a new write, contrary to
   DATA_MODEL §23 (the same as before this change). Fix: carry the problem
   through the repository error, and add a repository `recover(requestId)`
   mapping to `Source`/`Annotation`.
2. **Browser classic bundle.** `browser.ts` re-exports `/advanced` wholesale,
   so the experimental session adds about 1.8 KB gzip: 63,918 bytes against a
   65,536-byte hard ceiling. (Main was already over its review threshold at
   62,034.) Decide whether the classic global should exclude experimental
   exports.
3. **Reader refresh-before-write retained** in the source adapter, because its
   tests' fakes do not enforce revisions. It costs a read per save (as before),
   plus a second read on a metadata-only rebase.
4. **Editor behaviour changes** (listed above) are intended, but no product
   decision was requested; the specs do not require whole-record conflicts.
5. `receive()` still ignores a genuine revert arriving as a *publication*
   (Reader's shared resource). Reader's own writes surface it at the next save
   via the revision rejection; Reader could call `refresh()` on watch events
   if that matters.
6. Recovery across a page reload remains app-level (the editor's toasts; Reader
   has none).

### Locations

- connect: `/home/calluma/projects/mdbase-connect-record-session`, branch
  `record-session` (from `main` at `24b88ee2`).
- Reader: `/home/calluma/projects/mdbase-reader-record-session`, branch
  `record-session` (from `main` at `ba8cff4`). Commit `d8843bb` is the
  temporary SDK link.
- Nothing pushed, published, deployed or version-bumped. Main checkouts are
  untouched.
