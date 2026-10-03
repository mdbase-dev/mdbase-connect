# Architecture

mdbase editor is a client-side application with two deliberately separate
authorities. `/connect` uses `@mdbase/connect-management` and the user's account
session for control-plane administration. The editing workspace uses an
explicitly authorized `@mdbase-dev/connect` collection grant. The design keeps
account management, collection transport, lifecycle, editing state, and
rendering separate even though the application is deployed as one static site.

## Dependency direction

```text
React composition (App, feature views)
        │
        ├── collection index controller ──┐
        ├── file inventory / asset stores ┤
        ├── note session store            ├── narrow gateway contracts
        └── operation coordinator ────────┘
                                              │
                                  @mdbase-dev/connect or demo adapter

ConnectApp ── shared EditorRail ── @mdbase/connect-management ── account APIs only
```

The route entry point lazy-loads `App` and `ConnectApp` independently, while
both compose the same primary editor rail. Opening Connect replaces the
editor's note-list context with current-collection and account navigation. It
does not construct a collection gateway or start collection authorization.
Collection context is carried in `?collection=<id>` and remembered locally for
direct entry. Without a valid remembered or requested collection, Connect opens
the account-wide collection list rather than selecting an arbitrary collection.
Choosing Notes, Types, Settings, or **Open in editor** creates a normal
`?collection=<id>` editor navigation; the collection session then reuses an
existing grant or begins the standard approval transaction.

Views may depend on model types and pure domain helpers. They do not own remote
request generations, snapshot tokens, mutation queues, or authoritative note
documents. Infrastructure implements `CollectionGateway`; it does not reach
into React.

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
background for full-text search and backlinks. Both the connect and demo
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
notes cannot receive late references. This makes partial failure explicit: a
committed file survives even if insertion is removed or the later note save
fails. File size/type authorization stays in the collection gateway/SDK.

## Note editing

`NoteSessionStore` owns one session per open or background-saving note. A
session contains the authoritative remote document, persisted draft, live
draft, save state, conflict state, and mutation activity. React state mirrors
the active session only for rendering; it is not a second source of truth.

`NoteOperationCoordinator` serializes writes per session. Autosave, explicit
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
  pure selection model and browser-local, collection-scoped pin persistence;
- selection lives in App independently of the open note session. Batch actions
  reuse the operation coordinator and collection mutation scope, collecting
  successful inverse operations for one Undo and preserving partial failures
  for retry. Property Undo checks the written revision, not a freshly fetched
  revision, so it cannot overwrite later changes;
- `TypeBrowser.tsx`, `PropertiesPanel.tsx`, and `NewNoteComposer.tsx` own their
  feature workspaces;
- `Brand.tsx` and the dialog/menu components are reusable presentation.

Heavy editor and type workspaces are lazy-loaded. An application error boundary
contains unexpected render failures and offers recovery.

`ConnectApp.tsx` owns account navigation and control-plane actions. Its client
always sends browser credentials to the configured Connect origin, which must
explicitly trust the editor origin. The server accepts that session only from
the configured origin. This account session is not accepted by collection
operation routes as an application grant.

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
