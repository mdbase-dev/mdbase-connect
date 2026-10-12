# Native SDK mode

`SdkEditorRoot` runs the editor over the SDK's `createMdbase` entry, behind the
shared collection screens from `@mdbase-dev/ui/collections`. The source is
developed on the non-deploy integration lane; no staging or production
publication is implied.

## Public entry and lifecycle

- `createEditorMdbase` builds the declaration from the checked-in
  `.well-known/mdbase-app.json` and calls `createMdbase`. `main.tsx` constructs
  one entry for the module lifetime; construction does no registration IO.
- `SdkEditorRoot` starts the entry (StrictMode safe) and renders `CollectionGate`.
  The gate owns sign-in, choosing, approval, setup, problems, deletion and
  sign-out (`signOut()`, never `close()`). The editor never closes the entry.
- The editor opens only for the connection the gate hands over in phase `ready`.
  The native scope is keyed by connection ID and generation; losing readiness or
  currentness unmounts it and retires its gateway. The borrowed client is never
  closed by the editor.
- In the editor, the rail header holds `CollectionSwitcher` (`variant="full"`,
  `allowDelete`). Its `onBeforeLeave` confirms unsaved type or creation drafts
  and, for a switch, drains pending saves and mutations first. Adding a
  collection resolves inside the click so its Connect window keeps the gesture.
- Private collections (app grants relayed to a computer) are listed in a section
  beside the gate while choosing, because the gate lists only the installation's
  collections. An opened Private collection owns its own client and closes it
  when the editor leaves it; owners delete through the shared delete dialog.

## Native gateway

`NativeEditorGateway` implements the editor's existing `CollectionGateway` over
`connection.records`, `connection.files` and `connection.people`:

- Notes: `NextEditorRecords` (below), fenced by connection currentness.
- Index: `NativeNoteObservation` registers the SDK change watch before reading one
  complete, `asOf`-consistent `pages()` snapshot, rereads changed records by
  original ID, and reports created/updated/renamed/deleted/reset changes. A
  resumed watch triggers one complete reread. Optimistic overlays are
  presentation only.
- Permissions come from the native grant: `records.create` → create,
  `records.edit` → update/rename, `records.delete` → delete. Type install and
  type management stay off; file upload stays off because the public grant has
  no file action set.
- Files list/read by native digest; people use `people.directory({ members:
  "omit" })`; contracts use `queryContract`; validation and preflights use the
  native operations.
- `describe()` is marked `typing: "names_only"`: native describe has type names,
  paths and contract bindings, but no type schemas/versions or contract
  schemas/implementation digests. Those fields are empty and the Person starter
  upgrade check is skipped.
- Type sources are read with `resources.get`. Creating/editing types and type
  packs are refused without writing; collection setup belongs to SDK `configure`.

# Native SDK record adapter

## Record operations

- Reads the actual complete source plus body/effective metadata. Every mutation
  base requires the actual body/document and a matching native source revision,
  including uncached reads. Missing/inconsistent source is an explicit refusal,
  never reconstructed YAML.
- Carries genuine native record identity and the revision the editor opened.
  Patches, body edits, complete-source replacements, rename and delete retain
  explicit CAS; stale edits do not gain a freshly read revision.
- Waits for the original mutation receipt, then requires confirmed, unprotected
  current readback before returning a saved note. Pending/unresolved/held readback
  and ambiguous submission failures (including internal SDK response errors)
  retain the original mutation ID. A confirmed create whose readback fails is
  retained for receipt/readback recovery, not silently submitted again. Error
  codes alone are not evidence that a native mutation was never captured.
- Uses the SDK's real rename/delete preflight operations. No empty-preflight
  fallback or JavaScript backlink evaluation is provided.
- The existing note-session store remains responsible for drafts and write
  serialization. The native adapter is not another note index or persistent
  journal. Native base views are retained in at most 128 slots with an 8 MiB
  source/frontmatter text estimate; larger views are not cached.
- Disposing the adapter aborts its lifetime and drops cached base views. It does
  not close the shared sign-in session's client.

## Remaining integration

Runtime composition, the production entry point, native record-session recovery
state (an interrupted write is recovered from the pending-operation notice),
typed schemas, file uploads and file change notifications wait for public SDK
APIs or qualification. The launch uses relay/hosted routes only; direct access
is hidden in native mode. Do not copy TaskNotes' Worker, lease, authentication or
SQL-bootstrap glue into the editor.

The SDK is release's original `ad69a506` dev archive (not release-qualified),
recorded in `vendor/mdbase-next-sdk.json` with verified SHA256/SHA512. It exposes
the public `MdbaseConnect` declaration helper, the structural
`MdbaseApplicationEntry` type and the `createApplicationFixture` test seam. Its
original connect-protocol dependency archive sits beside it in `vendor/` and
both are ordinary file dependencies; nothing is repacked, aliased or swapped.
Both Docker dependency-install contexts copy both files before installation.
This pin is not per-app trust/origin/runtime/session/operation approval, and
its public constructor remains an explicit unavailable shell until runtime
composition lands in the SDK.

Unit tests use SDK MemoryReplica and are not native/LAB evidence. SDK811 now honors
`create.document` through its shared synthetic parser; restore verifies the actual
SDK document submission without an app-side source-create fixture bridge.

Tests use the SDK's `createApplicationFixture` for lifecycle/readiness and real
public SDK clients over MemoryReplica for data. They are not native/LAB evidence.
