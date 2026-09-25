# Record editing session

Status: **experimental, in progress** on branch `record-session`. Not exported
from the stable root package.

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
| **Stale publication** | request epochs; `revision === document.revision` | `seen` set (tested) | `seen` set | `seen` revision set per session (revisions are opaque, not ordered). |
| **Failed write** | reject; state `conflict`; no automatic retry; no re-read | `error`; one refresh to detect a conflict; explicit retry; draft stored locally | `error` unless the refresh shows a conflict or a convergent remote; no background retry loop (tested) | `error`; one read to classify (conflict / convergent / still error); no automatic retry. |
| **Outcome unknown** | `pendingSave = { requestId, draft }`; state `recovery`; next save **recovers** the exact request instead of writing; failed probe retains identity; SDK settlement (`isPending`) decides when the intent is resolved | none: a later save sends a **new** write (violates Reader DATA_MODEL §23) | none (same violation) | Editor semantics. `recovery` blocks new writes until the pending mutation settles; the recovered result is the acknowledgement; newer typing is retained and saved afterwards. |
| **Rename / move** | explicit rename flow (preflight, `updateRefs`, own recovery); `NoteSessionStore.move` rekeys the same session | sources are keyed by Reader `id`; path looked up by id; session unaffected | same, by annotation id | Session identity is independent of path. `session.moved(to, record)` rekeys after an app-initiated rename; an external `mdbase.record.renamed` event whose `previous_revision` is the session's revision is followed. No protocol record id exists, so "stable identity" is the session object plus revision lineage. |
| **Deletion** | staged tombstone, `deleted` flag stops saves; delete runs in the queue | refresh returns `null` ⇒ error "no longer exists", draft retained | `deleted()` + `lock()` lease | State `deleted`; draft retained; no writes. App-owned delete flows run through `session.run`. Locking/leases stay in Reader. |
| **Multi-view sharing** | one session per note in `NoteSessionStore`; one active view | one session per source per gateway (module `WeakMap`), shared text, synchronous notification to every view; last view detaching does **not** cancel the save (tested) | one per annotation (cache), single editor owner | One session per record per registry. `retain()/release()` reference-counts views; releasing the last view never cancels a pending write — the session is disposed only once settled and clean. |
| **Local crash drafts** | none (memory only; the SDK pending store keeps outcome-unknown requests) | localStorage, batched checkpoints (500 ms idle / 3 s max), `baseBody` for conflict-on-restore, unload tracking | memory only; legacy IndexedDB read-only compatibility | Not an SDK store. The session accepts a restored draft (`restore({ body, base })`, conflict-checked against the current record) and emits commit notifications so the app clears its copy. Reader and editor differ deliberately. |
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

To be completed with the implementation. Entry point: `@mdbase-dev/connect/advanced`.

## Record groups (open question, not built)

To be completed.
