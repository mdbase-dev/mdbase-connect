# Architecture

mdbase editor is a client-side application deployed as one static site. The
editing workspace uses an explicitly authorized collection grant. The design
keeps collection transport, lifecycle, editing state, and rendering separate.
Account administration lives on the separate Connect portal; the editor has no
account console. The **Open Connect** command carries collection context there,
and old `/connect` bookmarks forward to the portal without creating a gateway or
SDK owner (`src/main.tsx`).

## Dependency direction

```text
React composition (App, feature views)
        │
        ├── collection index controller ──┐
        ├── file inventory / asset stores ┤
        ├── note session store            ├── narrow gateway contracts
        └── operation coordinator ────────┘
                                              │
                                  NativeEditorGateway / demo gateway
                                              │
                                  @mdbase-dev/sdk (production access)

Open Connect command ── collection-context link ── Connect portal (account APIs only)
```

The route entry point mounts `SdkEditorRoot`, which owns `createMdbase` and
borrows its current connection for `NativeEditorGateway`. It lazy-loads `App`.
The demo gateway is selected only by a development build or an explicit
`VITE_MDBASE_EDITOR_DEMO=1` build plus a positive `?demo=` count.
Connect links open the canonical server
origin with `?collection=<id>`; the portal remembers valid collection context
without selecting an arbitrary collection. **Open editor** returns to the
Editor with collection context, where the SDK reuses an existing authorization
or begins the standard approval transaction.

Views may depend on model types and pure domain helpers. They do not own remote
request generations, snapshot tokens, mutation queues, or authoritative note
documents. Infrastructure implements `CollectionGateway`; it does not reach
into React.

## Remaining legacy dependencies

The retired `ConnectCollectionGateway` has no production or demo constructor:
`main.tsx` creates only the demo gateway, and `SdkEditorRoot.tsx` creates only
`NativeEditorGateway`. Its injected connection/session tests and the old
`note-recovery.test.ts` exercised that retired path. Native transport and exact
mutation recovery remain covered by `native-gateway.test.ts` and
`next-editor-records.test.ts`, using the SDK's `MemoryReplica`.

The Editor still requires `@mdbase-dev/connect` for its live record session,
error/outcome handling, model vocabulary, and demo observer. Removing the package
is unfinished. In particular, the pinned SDK's public `RecordSession` has no
exclusive-operation callback corresponding to the session's `run`, nor a
base-aware draft restore corresponding to `restore`. `App.tsx` uses those for
note operations and browser draft recovery. Replacing them needs a coordinated
session migration; copying the old session or adding an adapter that recreates
its methods would preserve the mechanism this cleanup is meant to remove.
`demo-observe.ts` also still runs `MdbaseQueryObserver`; the demo and its test
fixtures have not yet been ported to the SDK testing kit.

`@mdbase-dev/connect-dev` and the separate `@mdbase-dev/connect-testing` package
are no longer Editor dependencies. The remaining legacy test problem constructors
come from the retained client's advanced entry; they do not constitute an SDK
fixture migration. Shared Person identity constants and identity types come
from `@mdbase-dev/sdk`.

The direct `@mdbase-dev/connect-protocol` file pin is intentional. Manifest checks
still import it, and cloud-ops `tools/sdk-repin/archive.mjs` opts `apps/editor`
into `protocolImporters` and requires its existing direct file pin before planning
a repin. `config/client-apps.json` also names both server/MCP Dockerfiles as
replacement references. The native publisher verifies that the direct protocol
archive is byte-identical to the authenticated SDK's bundled archive. Removing
this pin requires coordinated changes to those owners. Vendor files and native
publisher verification are unchanged here.

Other direct workspace consumers of `@mdbase-dev/connect` are
`packages/devkit`, `packages/testing`, and `services/mcp`. The protocol additionally
serves `packages/client`, `packages/sync`, `packages/webhooks`, `apps/portal`,
`apps/desktop`, `services/server`, and the SDK's bundled dependency. No workspace
package is removed by this Editor cleanup.

## Collection index

`CollectionIndexController` is the single authority for the visible collection
index. It exposes immutable snapshots through the external-store contract and
owns:

- cancellable structure and content requests;
- request generations and collection snapshot tokens;
- progressive structure/content status;
- hydration deduplication and retry state;
- reconciliation of accepted creates, updates, renames, and deletes with older
  in-flight snapshots.

An accepted mutation is overlaid onto older results so stale pagination cannot
roll the UI backwards. The overlay is retired after a refresh that began after
that mutation; otherwise an old local value could hide a later remote edit.

Structure and content are intentionally separate. The complete folder and
metadata index becomes usable first, while note bodies hydrate in the
background for full-text search and backlinks. Both the native SDK and demo
gateways implement these semantics. Hydration requires an explicit successful
structure-completion state; a stopped or failed list request is not treated as
complete.

## Collection files

Files are a collection-scoped index and an on-demand asset pipeline, not note
fields. `FileInventoryController` progressively lists descriptors, owns request
generations and cancellation, exposes failures instead of silently dropping
them, and reconciles accepted uploads and file watch events. Notes and files
share the virtualized collection browser and folder tree while retaining
separate identities and navigation behavior.

`FileAssetStore` downloads only assets that a visible embed or file workspace
acquires. Entries are keyed by file identity and revision, concurrent reads are
deduplicated, oversized previews are rejected before download, and object URLs
are revoked on revision changes, eviction, and collection reset. Both entry
count and byte budgets bound the cache.

Markdown embed discovery uses the CodeMirror Markdown syntax tree so examples
inside code are not fetched. One resolver handles standard image destinations,
relative paths, and wiki embeds with deterministic normalized matching; unsafe
schemes, traversal, and ambiguous basenames remain unresolved. The attachment menu, clipboard images and file drops share one upload pipeline
and the same note-relative attachment location. Paste/drop uses view-local,
edit-mapped insertion anchors (drop coordinates, not the current selection).
Image upload widgets occupy their own block even mid-paragraph; completed image
references are separated from prose by line breaks. Upload and failure widgets
never enter the saved Markdown. Errors use plain language and only transient
failures offer Retry; permanent size/type/permission failures offer Remove.
The file commits first; only then does the editor insert an independently undoable
Markdown reference. Navigation, removal, deleted anchors and read-only/frozen
notes cannot receive late references; a menu upload's queued links carry the
note editor key they were made for, and leaving that note drops them. A
multi-file selection uploads every file it can and names each one that failed. This makes partial failure explicit: a
committed file survives even if insertion is removed or the later note save
fails. File size/type authorization stays in the collection gateway/SDK.

## Note editing

`NoteSessionStore` owns one session per open or background-saving note. A
session contains the authoritative remote document, persisted draft, live
draft, save state, conflict state, and mutation activity. React state mirrors
the active session only for rendering; it is not a second source of truth.

The retained `MdbaseRecordSession` in `note-session.ts` serializes writes per
session, including the `runNoteOperation` callback in `App.tsx`. Autosave, explicit
flushes, property updates, rename, and delete cannot race each other. A change
made during an active save schedules exactly one follow-up save. Navigation and
collection switching flush through the same coordinator.

Optimistic index changes are made only through `CollectionIndexController`.
Delete uses a staged tombstone until the remote operation succeeds and restores
the summary on failure.

## Search

The full-text search index normalizes titles, paths, metadata, and bodies once
per changed record. `IncrementalNoteSearchIndex` reuses entries whose record
identity and type context are unchanged, and removes entries for deleted paths.
Search never performs a remote query. Unlinked mentions reuse the hydrated
search entries (including their original display titles), caching syntax
exclusions and paragraph bounds by entry identity. Snippets reuse the shared
Markdown-to-prose cleaner; display emphasis offsets remain separate from raw
source mutation offsets. Discovery excludes H1 titles and longer source-title
phrases, and its collapsed footer renders only five results until Show all N.
Only an explicit Link action reads its source note, then flushes and writes through the same
revision-aware session operation queue. Undo refuses changed text rather than
replacing newer edits. The list is virtualized so collection
size does not translate directly into DOM size.

## UI boundaries

`App.tsx` is the application orchestrator: connection/session lifecycle,
navigation, active editing commands, and composition. Self-contained UI lives
outside it:

- `editor-commands.ts` owns canonical command labels and shortcuts; menus,
  shortcut matching/help, and QuickOpen bind the same definitions;
- `CollectionRail.tsx` owns folder expansion persistence;
- `NoteSearchField.tsx` owns tag/type filter suggestions and chips;
- `NoteList.tsx` owns list virtualization, keyboard focus, selection gestures,
  search result rendering, and list status copy. `note-list-view.ts` holds the
  pure filter/facet/status types, scope labels, selection/sort/drag vocabulary,
  and browser-local, collection-scoped pin persistence. Both list and search
  controls consume that leaf model; it never imports a view;
- selection and its inline property form live in App independently of the open
  note session. `use-note-actions.ts` owns explicit note mutation orchestration
  (duplicate, rename/move, delete, property/source updates, validation, mention
  linking), request guards, action errors and single/batch Undo state. It consumes
  the existing session store, collection index, mutation scope and serialized
  operation seam; it creates no second record store or write queue. App supplies
  navigation/history/pin and active-view updates, and resets action state at the
  existing collection-transition boundary. Batch actions collect successful
  inverse operations for one Undo and preserve partial failures for retry.
  Property Undo checks the written revision, not a freshly fetched revision, so
  it cannot overwrite later changes;
- `TypeBrowser.tsx` and `PropertiesPanel.tsx` own their feature workspaces.
  `type-presentation.ts` supplies the initial Type draft and readable
  field-kind labels without moving UI copy into schema mutation policy;
- a new note has no workspace of its own: it opens in the ordinary note editor.
  `new-note.ts` is the pure model of a note that is not written yet (where it
  starts, what its type requires, the path it will take); App holds the unsaved
  notes and writes each one once, after which it is an ordinary note session;
- `Brand.tsx` and the dialog/menu components are reusable presentation.

Heavy editor and type workspaces are lazy-loaded. The metadata-icon glyph CSS
is owned by `PhosphorIcon`, whose only consumer is the lazy Types workspace;
the writing/loading shell uses SVG icons and does not load the icon-picker font
or its full glyph catalog. A URL-restored Types surface reads the selected
source when the collection becomes ready; loaded/dirty drafts and failed reads
are not automatically replaced or retried. Pending source is a loading state,
not a YAML validation error. An application error boundary
contains unexpected render failures and offers recovery.

Portal `ConnectApp.tsx` owns account navigation and control-plane actions.
Its management client sends browser credentials only to its own Connect
origin. This account session is not accepted by collection operation routes
as an application grant.

## Invariants

1. Every remote result is accepted only by the request generation that started
   it.
2. Snapshot tokens are explicit request/result data, never hidden mutable
   gateway state.
3. An accepted local mutation cannot be undone by an older list or hydration
   response.
4. A newer authoritative refresh can retire old mutation overlays.
5. At most one write pipeline runs for a note session.
6. Switching collections cancels index work and clears every collection-scoped
   store before loading the next collection.
7. Demo mode follows production pagination and hydration semantics.
8. No Connect account response contains record bodies, collection paths, or
   reusable collection credentials.
9. File bytes are fetched on demand, bounded in memory, and never treated as
   part of the collection note index.
10. Every object URL has one store owner and is revoked when its asset leaves
    that store.

## Verification

`pnpm typecheck` uses strict TypeScript with unused code checks. `pnpm test`
covers domain logic, controllers, components, race conditions, and recovery.
The Playwright suite covers production-shaped user flows, accessibility,
responsive behavior, and a 10,000-note collection. `pnpm build` is followed by
`pnpm check:bundle`, which enforces gzip budgets for initial JavaScript and CSS.
CI runs all four gates before deployment.

## Comments

A collection with a type that implements `mdbase.comment` gets comments on
every note. The contract's reading (threads, anchors, the fields a new comment
or a change writes) is shared in `@mdbase-dev/ui/comments`, with the thread
panel and the CodeMirror anchors beside it, so the Editor and other apps agree
on what a comment is. `note-comments.ts` maps the contract onto the type's own
field names; `use-note-comments.ts` derives the open note's threads from the
collection index, so comments written elsewhere arrive with every other
change, and writes through the gateway into the same index.

Comment records are ordinary notes: they appear in lists and open like any
other file. A stored anchor counts positions in the note's stored body, which
includes a heading title the editor shows separately and may keep `\r\n`, so
positions are shifted to and from the editor's text and the quote remains the
authority. There are no comments before a collection is connected.
