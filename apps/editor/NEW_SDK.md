# Native SDK record adapter

`NextEditorRecords` is a source-only data-layer foundation for the editor's
new-SDK gateway. It does not replace the active Connect gateway. An explicitly
owned SDK sign-in binding can now use the existing connection screen; genuine
native collection composition is still pending. The source is developed on the non-deploy
`next/new-sdk` integration lane; no staging or production publication is implied.

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

The active gateway still uses Connect. Shared SDK web sign-in/native collection
opening and manifest-driven setup are owned by the SDK workstreams; do not copy
TaskNotes' Worker, lease, authentication or SQL-bootstrap glue into the editor.
Files, native catalog/type management, live observation, attention/conflict UI,
validation and the gateway session bridge still need qualification/integration.
The launch uses relay/hosted routes only. Browser direct-access controls must
consume the shared unsupported compatibility port and hide/skip gracefully.

The SDK is release's qualified `b9965703` packed artifact, recorded in
`vendor/mdbase-next-sdk.json` with verified SHA256/SHA512. Its original 750928
bytes include SDK837's host/caller lifetime composition fix and SDK832's optional
bounded `problemDetail`, plus the earlier public factory/provider-receipt helpers.
Release verified all 278 regular members, 1678 SDK tests and five browser checks
(with three existing runtime-gated skips). The editor consumes SDK snapshots
directly without a new diagnostic parser, raw-error logging or retry authority.
This pin enables no new factory or per-app native composition.
Both Docker dependency-install contexts copy this same file before installation. This
source/package pin is not per-app trust/origin/runtime/session/operation approval;
the old gateway remains active and the earlier unsafe SDK807 archive is not reused.

Unit tests use SDK MemoryReplica and are not native/LAB evidence. SDK811 now honors
`create.document` through its shared synthetic parser; restore verifies the actual
SDK document submission without an app-side source-create fixture bridge.

## Existing connection screen, public SDK actions

`App` accepts an optional owner-supplied `nativeSignIn` binding. That branch uses
`ConnectScreen` and the same shared layout and styled controls, without creating
any legacy session snapshot or starting legacy gateway/index/file stores. The
production entry point still supplies its existing gateway; no new route or
unqualified native configuration is enabled.

`createNativeSignIn` forwards explicit app/release/origin/runtime/stores/locks and
the original signal to `AppWebSignInSession`. Approval, polling, account/collection
selection and custody belong to the SDK. The collection callback explicitly
refuses with **Opening collections isn't available in this build yet.** It cannot
manufacture a connection, setup result, save state or native-ready gateway.

Sign in synchronously reserves a named 620×760 popup before SDK startup/renewal.
The trusted Connect popup retains its opener so the parent can close it after
cross-origin navigation. A blocked popup falls back to a tab with its opener
immediately detached; a blocked tab has an explicit retry action. Only the SDK's
validated URI is navigated, using the original handle. Reopen reuses that handle
or replaces a manually closed window; view replacement closes only its own popup.

Pairing alone never closes a popup while the SDK remains `authorizing`. Public
completed/terminal states close it automatically. SDK snapshots supply actual
email and selected metadata; generic refusal is not labelled user decline. Sign
out waits for successful SDK `close()` and means local shutdown, not revocation
or erasure. Forget uses the SDK's actual selected ID. View teardown never closes
the borrowed SDK session, and retired actions cannot publish to a replacement.

Tests use labelled SDK snapshot/action stand-ins. Real Chromium verifies popup
geometry, retained opener, cross-origin UI closure and 390px long-email layout,
not native authentication, factory/producer ABI, browser custody or LAB acceptance.
Qualified per-app inputs and genuine native composition remain required.
