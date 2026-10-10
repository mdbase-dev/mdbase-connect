# Native SDK record adapter

`NextEditorRecords` is a source-only data-layer foundation for the editor's
new-SDK gateway. It does not replace the active Connect gateway or add a working
new-SDK sign-in mode yet. The source is developed on the non-deploy
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

The SDK is the release-supplied `5369226d` packed artifact recorded in
`vendor/mdbase-next-sdk.json`, not npm. It contains no unmerged Files API.

Unit tests use the SDK MemoryReplica and are not native/LAB evidence.
MemoryReplica currently ignores `create.document`; the restore test explicitly
supplies synthetic source-creation behavior while verifying exact document
submission. The SDK workstream is fixing this generic test-fixture omission.
