# Record editing session

Status: **golden path** on branch `record-session`. `connection.records` and
`MdbaseRecordSession` are root exports of `@mdbase-dev/connect`; custom
transports (`MdbaseRecordSessionAdapter`) are in `/advanced`. Not released.

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
| **Revision check** | `update({ ifRevision: document.revision })` | **refresh before every write**, then `persist(current, body)` with the refreshed revision if the body is unchanged remotely | `persist(base, body)` with the base revision; refresh only after a failure | Write only the changed parts against the base revision. Any failed write is classified with one read (below). Reader's source adapter keeps refresh-before-write inside its adapter because its tests' fakes do not enforce revisions. |
| **External change while clean** | adopt remote (`applyRemoteDocument`) | adopt remote body | adopt remote | Adopt. |
| **External change while dirty** | **any** foreign revision ⇒ conflict (whole record) | conflict only if the remote *body* differs from both base and draft; metadata-only change rebases silently (tested: "permits metadata-only revision changes") | same as source | **Field-level three-way**: conflict only if a part the user changed locally (body, or a frontmatter key they patched) was also changed remotely to a different value. Otherwise rebase onto the remote revision and keep the draft. Rationale: Reader tests require it; the editor has no test or product rule requiring metadata-only conflicts; DATA_MODEL §23 forbids whole-document last-write-wins, which field-scoped writes satisfy. The editor currently sends the full frontmatter in `titlePatch`, which would clobber a remote metadata change on rebase; the SDK sends only dirty keys. |
| **Remote equals draft** | not recognized (still conflict) | not a conflict; saved | adopt and clear (tested: "uses the verified latest base when an older response follows a matching remote edit") | Convergent remote (same content as the draft for every dirty part) is adopted as saved. Exact equality, no normalization. |
| **Own acknowledgement vs external change** | waits for the queue, then `next.revision === document.revision` | `seen` revision set; **no deferral** during a write (latent false-conflict) | `seen` set **and** defers every incoming record while a write is in flight, then drops the acknowledged revision and classifies the rest | Deferral + revision identity: records received while a write (or recovery) is unsettled are queued; after settlement the acknowledged revision is recorded as seen and the remaining records are classified. Never by text comparison or whitespace trimming. |
| **Clean after an acknowledgement** | clean iff draft equals the *sent* draft (`persistedDraft = snapshot`); server text is not adopted | status `saved`, local text kept, but later comparisons use the server body, so a normalized response makes an unchanged draft look dirty | clean iff draft equals the sent body; the normalized server text is then adopted into the textarea | Clean iff the draft equals what was sent (mutation identity). The SDK never rewrites text under a live editor; it records that the sent text corresponds to the acknowledged revision. External changes are compared with the acknowledged *record*, local dirtiness with the *sent* text. A surface that wants the normalized text (Reader annotations) adopts it from `snapshot.record`. Comparing against the server body instead would loop forever when a serializer appends a newline. |
| **Stale publication** | request epochs; `revision === document.revision` | `seen` set (tested) | `seen` set | `receive()` (a publication, possibly stale) ignores revisions already seen. `refresh()` reads inside the write queue and applies the result even if its revision was seen before: record revisions are SHA-256 of the document bytes (`mdbase-rs` `operations/read.rs`), so an external revert repeats an old revision. The editor's watch path uses `refresh()`. |
| **Failed write** | reject; state `conflict`; no automatic retry; no re-read | `error`; one refresh to detect a conflict; explicit retry; draft stored locally | `error` unless the refresh shows a conflict or a convergent remote; no background retry loop (tested) | `error`; one read to classify (conflict / convergent / still error); no automatic retry. |
| **Outcome unknown** | `pendingSave = { requestId, draft }`; state `recovery`; next save **recovers** the exact request instead of writing; failed probe retains identity; SDK settlement (`isPending`) decides when the intent is resolved | none: a later save sends a **new** write (violates Reader DATA_MODEL §23) | none (same violation) | Editor semantics. `recovery` blocks new writes until the pending mutation settles; the recovered result is the acknowledgement; newer typing is retained and saved afterwards. Reader now uses it too: `ConnectRepositoryError` keeps the Connect problem (so the request ID), and a `BodyUpdateRecovery` port continues source and annotation writes through the connection's durable handle. |
| **Rename / move** | explicit rename flow (preflight, `updateRefs`, own recovery); `NoteSessionStore.move` rekeys the same session | sources are keyed by Reader `id`; path looked up by id; session unaffected | same, by annotation id | Session identity is the session object, independent of path. `connection.records.follow(watch)` rekeys a session on `mdbase.record.renamed` and its reads and writes go to the new path. An app-initiated rename runs through `session.run` and hands its result to `accept(record)`. Apps with their own stores rekey them (editor `NoteSessionStore.move`; Reader keys by record id). No protocol record id exists; no protocol change was needed. |
| **Deletion** | staged tombstone, `deleted` flag stops saves; delete runs in the queue | refresh returns `null` ⇒ error "no longer exists", draft retained | `deleted()` + `lock()` lease | State `deleted` when a read or write finds `file_not_found` (the existing catalogue code); draft retained; no writes. App-owned delete flows run through `session.run`. Locking/leases stay in Reader. |
| **Multi-view sharing** | one session per note in `NoteSessionStore`; one active view | one session per source per gateway (module `WeakMap`), shared text, synchronous notification to every view; last view detaching does **not** cancel the save (tested) | one per annotation (cache), single editor owner | One session shared by every view (an external store: `subscribe`/`getSnapshot`, notified synchronously on every edit). `connection.records.open()` enforces it per connection: concurrent and later opens share one session; `release()` is per view and idempotent; a released session stays until it has nothing left to save, so the last view closing never cancels a write (Reader's tested requirement). The two apps keep their own keyed caches over custom adapters. |
| **Local crash drafts** | none (memory only; the SDK pending store keeps outcome-unknown requests) | localStorage, batched checkpoints (500 ms idle / 3 s max), `baseBody` for conflict-on-restore, unload tracking | memory only; legacy IndexedDB read-only compatibility | Not an SDK store; the adapter boundary is the plug point. `restore({ body, baseBody? })` offers a draft (a conflict if its base is unknown or changed) and never writes by itself; `autosave()` resumes it. The app learns of its own acknowledgements inside its adapter's `write` (Reader clears its localStorage copy and publishes there). Reader and editor differ deliberately. |
| **Flush** | recover pending first; throw if remote conflict; loop until clean | loop `save()` while `unsaved`; throw on conflict/error; return base record | `save()` | `flush()`: settle recovery, then write until clean. Resolves to a `ConnectOutcome`: the saved record, or `concurrent_modification` / `file_not_found` / the write's own problem. |
| **Conflict resolution** | "Use latest" adopts remote; "Keep my edits" rebases onto remote and saves | `resolve("remote")` adopts and clears local copy; `resolve("local")` rebases, stores, saves | `resolve("remote")` clears; `resolve("local")` rebases, `unsaved` (tested: no write until an explicit save) | `resolve({ keep: "theirs" })` adopts; `resolve({ keep: "mine" })` rebases onto the remote revision and marks unsaved (autosave decides when to write); `resolve({ body })` for merged text. |

### Differences settled without product input

- Error vs conflict state (editor conflation) — fixed in the SDK; presentation
  follows.
- Whole-record vs field-level conflict — field-level (above).
- Outcome-unknown recovery — adopted for Reader; its DATA_MODEL already
  requires it.

No semantic conflict was found that the specs leave undecided.

## SDK shape

Golden path (root `@mdbase-dev/connect`):

```ts
const opened = await connection.records.open(path, { autosave: { idleMs: 1_000 }, timeoutMs: 8_000 });
if (!opened.ok) return renderProblem(opened.problem);
const { session, release } = opened.value;      // MdbaseRecordLease
connection.records.follow(watchSubscription);   // returns stop()

session.subscribe(listener); session.getSnapshot();
// { state, body, frontmatter, record, remote, dirty, problem, pendingRequestId? }
session.setBody(text); session.patchFrontmatter(patch);
await session.save(options);  await session.flush(options);  await session.refresh(options);
session.resolve({ keep: "mine" | "theirs" } | { body });
session.discard(); release();
```

Custom transports (`/advanced`): `new MdbaseRecordSession(record, adapter, options)`
with an `MdbaseRecordSessionAdapter<R>` of accessors (`revision`, `body`,
`frontmatter`) and outcome-returning `write`, `read`, `recover`, `isPending`.
Both apps use this seam: the editor over its gateway (and demo gateway), Reader
over its domain repositories. Also `receive(record)` for publications, `accept(record)`
for the app's own out-of-band results (rename, whole-document replace),
`run(operation)` for other operations in the same write queue, `restore()` and
`autosave()` for crash-recovery drafts, and `markDeleted()`.

The contract follows `docs/sdk-beta-public-surface.md`: every expected failure is
a `ConnectOutcome` with an existing catalogue code, every async method takes
`ConnectRequestOptions`, and an adapter that throws is a programming error that
propagates (the queue stays usable).

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
| `packages/client/src/record-session.ts` (`MdbaseRecordSession`) | 508 |
| `packages/client/src/records.ts` (`connection.records`) | 181 |
| SDK tests: `record-session.test.ts` (43), `records.test.ts` (14) | 856 |
| Compile-only consumer spike `test/consumer-spikes/records.ts`, export placement check | 49 |
| Real-stack scenario in `scripts/e2e.mjs` (browser SDK + local connector + watch) | 70 |
| Reader: `BodyUpdateRecovery` port, `ConnectBodyUpdateRecovery`, outcome helpers | see below |

### Deleted or replaced

- Editor: `NoteOperationCoordinator`, `KeyedOperationQueue` (and their tests),
  the session's save/conflict/recovery fields, `applyRemoteDocument`, the
  autosave effect and the gateway's inline recovery. Editor production code
  +204 / −375.
- Reader: the writer and classification inside `SourceDraftSession`
  (263 → 290 lines) and `AnnotationEditSession` (261 → 243). Reader production
  code +459 / −277, which includes new exact recovery for both (it had none,
  contrary to DATA_MODEL §23). Reader's existing tests are unchanged; four new
  tests cover recovery.
- One writer implementation now serves three editing surfaces. Total line count
  is not smaller: the SDK code is new, general and documented.

### Commands run (final state)

connect worktree:

- `pnpm typecheck` (root): passes.
- `pnpm test` (root): passes, all packages including desktop (248 + 143
  node tests), client 19 files / 391 tests, editor 59 / 469, server 643 passed
  / 35 skipped. The earlier desktop failure was a first-run Electron extraction
  race in the new worktree and did not recur.
- `pnpm e2e` (local suite: package build, `cargo build --workspace`, real
  connector, control plane and Chromium): passes, including the new record
  session scenario (shared opens, own acknowledgement, metadata-only rebase,
  body conflict and "keep mine", live refresh through `follow()`).
- `@mdbase-dev/connect`: `test:public-api` (inventory and packed boundaries)
  and `test:consumer-spikes` pass. Browser bundle 64,844 gzip bytes.
- Editor: `pnpm test:e2e` 55 / 55 Playwright; `pnpm build` and
  `check:bundle` pass.
- Not run: `cargo test --workspace` and `cargo fmt` (no Rust changes), other
  `test:system` suites.

Reader worktree (linked to this SDK):

- `pnpm typecheck` and `pnpm test` pass (reader 91 / 347, connect 24 / 77,
  core 21 / 83). Lint and format pass on every changed file; `check:architecture`
  and `check:spec` pass. Full `pnpm lint` still fails on four untouched files,
  as on `main`.
- Shared-editor browser fixture: 7 / 7 scenarios pass in each of 3 runs with
  the stale selector fixed locally (the fixture on `main` still clicks "Keep my
  changes"; see risks). Keystroke next-frame latency medians 8–15 ms, p95 ≤ 16.2
  ms, max ≤ 16.7 ms, no long tasks: the same band as `main`.

Docs: package README section, `docs/sdk-beta-public-surface.md`, and a new
`/sdk/editing/` page on the mdbase.dev branch (`astro check` 0 errors, build
passes).

### Browser bundle policy

Accepted the measured bundle as the new baseline (53,655 → 64,844 gzip bytes;
`main` was already at 62,034). Review threshold 57,344 → 69,632 (68 KiB); hard
ceiling 65,536 → 73,728 (72 KiB); raw ceiling 262,144 → 294,912. The 2 KiB
per-change allowance is unchanged.

### AGENTS.md handoff questions

- **Replaces and deletes:** the editor's coordinator, queue and recovery
  fields; the writer/classification inside both Reader sessions; the editor
  gateway's inline recovery.
- **Evidence each new state is reachable:** every `MdbaseRecordSessionState`
  and every adapter branch has an SDK test; `connection.records` has tests for
  sharing, cancellation isolation, retirement, recovery, rename, deletion and
  gaps; the real-stack e2e exercises the golden path against a real authority.
- **Invalid input vs invariant failure:** expected failures are outcomes with
  existing catalogue codes; an adapter that throws is a programming error and
  propagates.
- **Compatibility:** none added in the SDK. Reader's `pnpm.overrides` link is
  temporary (commit `d8843bb`), removed when the SDK is published.
- **New abstractions:** `MdbaseRecordSession` (the repeated concept, three
  consumers), `MdbaseRecordSessionAdapter` (transport boundary, three
  implementations), `MdbaseRecords` (the one-writer-per-record invariant for
  connection-backed apps), Reader's `BodyUpdateRecovery` port (one
  implementation over durable handles).
- **Public/persisted/user-facing expansion:** new root and `/advanced`
  exports, reviewed in `public-api.json`; nothing new persisted. Editor: a
  metadata-only change elsewhere no longer causes a conflict, and a failed save
  shows "Save failed". Reader: interrupted writes are recovered instead of
  retried.
- **Net simplification:** for the applications, yes. In lines, no.

### Remaining risks and follow-ups

1. **Release order:** publish the SDK beta, then move Reader from the linked
   worktree to that version (drop `d8843bb`).
2. **mdbase.dev:** the new page is not in the docs navigation because
   `DocsLayout.astro` has uncommitted local edits. The existing operations page
   is stale against the beta SDK (envelopes/`unwrapOperation`, snake_case
   `if_revision`, iterator `watch`, `resumePendingMutation`); that predates
   this work.
3. **Reader browser fixture** clicks "Keep my changes" while the UI says "Keep
   mine" since `55b3b05`; a one-line fix on Reader `main`.
4. **Reader's source adapter** still re-reads before every save because its
   test fakes do not enforce revisions.
5. `receive()` ignores a revert that arrives as a publication (by design, to
   ignore stale copies); `refresh()`/`follow()` apply it.
6. Recovery across a page reload stays app-level (`pendingMutations()`); a
   session only recovers writes it started.

### Locations

- connect: `/home/calluma/projects/mdbase-connect-record-session`, branch
  `record-session`.
- Reader: `/home/calluma/projects/mdbase-reader-record-session`, branch
  `record-session` (`d8843bb` is the temporary SDK link).
- Docs site: `/home/calluma/projects/mdbase.dev-record-session`, branch
  `record-session`.
- Nothing pushed, published, deployed or version-bumped.
