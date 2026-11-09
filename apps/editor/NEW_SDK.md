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
- Private collections use the SDK's account-bound Native inventory, canonical
  Add action and shared gate/switcher rows, not an app-owned section or raw
  authorization adapter. Unknown browser grants are not imported or relabeled;
  approve them again through Add a collection. Legitimate current-account
  inventory, including collections needing synchronization, remains available.
  The SDK owns Native clients and sign-out cleanup; the editor never closes them.
  Custom adapters and their fenced client lifetimes are isolated test seams,
  ignored outside test builds. Native owner-delete parity is not yet qualified.

## Work before connecting

`createEditorMdbase` passes `unsynced: true`, and the gate and switcher take
`unsynced` (see `docs/architecture/work-before-connecting.md`). A signed-out
start, or **Continue without connecting** on the signed-out screen, opens this
browser's unsynced collection; the gate hands its connection to the editor as
in phase `ready`, under the same native gateway. It is never listed in the
switcher, and people cannot name it or make several.

- The rail's status reads the shared "Saved only in this browser"
  (`syncState() === "unsynced"`), never Connected, Saved or "waiting for sync":
  local confirmation is final there.
- Once something is saved, the gate's one quiet line above the editor repeats it
  with **Connect to sync your work**. With a collection open, its banner offers
  **Bring it in** (identity map, `addTypes: true`) or **Discard…** after the
  person confirms. `.editor-collection-frame` stacks those lines above the
  editor within the viewport.
- Attach stays hidden: the unsynced grant has no file `add` action, and the
  gateway already offers uploads only for an explicit `add`.

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

## SDK pins and target builds

The ordinary Editor dependency is the committed production SDK archive described
by its matching `vendor/sdk-production-*.json` metadata. The central SDK repin
updates the archive, metadata/facts, manifest and frozen lock together. The
publisher verifies npm integrity and provenance for that exact version.
Staging uses the same version's attested `sdk-staging.tgz` release asset, never
the production archive or rewritten trust. See [NATIVE_PUBLISHER.md](./NATIVE_PUBLISHER.md).

Editor imports the exact npm UI version in `package.json`; the ordinary frozen
lock pins its integrity, and the style-token gate checks installed UI CSS.
Shared UI owns opening progress, slow warnings, focus, storage warnings and
Private entry; there is no app-side progress shim. SDK sign-out attempts
whole-store grant cleanup and reports incomplete cleanup. Account-bound routing
must still hide another account's surviving grants.

LAB publication is a separate isolated rehearsal path. `pnpm build:lab` generates
the canonical `https://editor-lab.mdbase.dev/` declaration and requires a
separately authenticated LAB SDK. A production SDK refuses that declaration.
The ordinary build retains production defaults.

This native entry replaces the legacy `ConnectCollectionGateway` bootstrap for
this lane. The old OAuth collection chooser does not expose next `cloud_copy`
collections; widening its eligibility filter would not install a native client.
No collection version or consent policy is relaxed. The pin and offline build
are not per-app trust/origin/runtime/session/operation approval, publication, or
live qualification. Publishing the LAB candidate requires separate approval.

Native record-session recovery, typed schemas, file uploads and file change
notifications still require public SDK APIs or qualification. Direct access is
hidden in native mode. Do not copy TaskNotes' Worker, lease, authentication or
SQL-bootstrap glue into the editor.

Unit tests use SDK MemoryReplica and are not native/LAB evidence. SDK811 now honors
`create.document` through its shared synthetic parser; restore verifies the actual
SDK document submission without an app-side source-create fixture bridge.

DOM tests use the SDK's public `createTestApp` account-view fixture for
lifecycle/readiness and public SDK clients over MemoryReplica for data. Separate
qualification-only tests drive the real SDK entry and grant crypto/store/cleanup,
with scripted Worker, CP and native transport/setup boundaries. Neither suite
proves live Worker reference verification, P2P admission or LAB operation.
