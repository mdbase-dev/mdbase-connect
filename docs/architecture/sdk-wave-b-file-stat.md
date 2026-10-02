# Wave B B4: Exact file metadata lookup

Status: proposed; depends only on [B1](sdk-wave-b-capability-negotiation.md).
Baseline/provenance: B1. Batch stat is deliberately deferred until point lookup is
qualified; document batches (B3) and binary descriptors are different APIs.

## Current behaviour with evidence

- Protocol `packages/protocol/src/files.ts`, Rust
  `crates/connect-protocol/src/files.rs` define ListFilesRequest/ListFilesPage and
  CollectionFileDescriptor, but no stat. Client `packages/client/src/files.ts`
  accepts descriptors for download and exposes listing, not current lookup.
- Local `crates/connect-agent/src/server/files.rs` checks file `list` and filters
  inventory. `crates/connect-core/src/registry/files.rs` already has indexed lookup
  by ID/path, targeted reconciliation and `indexed_file_location` (external move
  detection). Reuse these; do not implement public stat as full inventory listing.
- Hosted `crates/connect-hosted-provider/src/provider/files/list_download.rs`
  paginates/decrypts rows before path filtering. `files/lifecycle.rs` and uploads
  already use keyed `path_token` of a portable path key to enforce uniqueness;
  point lookup can use that existing index, not scan/decrypt every descriptor.
- mdbase-rs owns collection path validity, portable path semantics and collection
  file eligibility; Connect owns stable file IDs, grants, descriptor inventory and
  digest/version pinning (`crates/connect-core/src/collection_files.rs` delegates
  discovery). Keep that existing ownership; no second extension/exclusion parser.
- Reports: Reader `packages/connect/src/{documents,collection-files}.ts` enumerates
  folders to reopen/export one document; Writer refreshes folders for changed files;
  editor uses full inventory for assets. TaskNotes commonly already has descriptors.

## Proposed wire/API

Advertise `files-stat-v1` via B1's authority describe/files page. Add file-control
message, preserving FILE_PROTOCOL_VERSION 1 and existing transfer framing:

```json
{"protocol_version":1,"type":"stat_file","path":"assets/book.pdf"}
```

Exactly one of collection-relative `path` or UUID `file_id`; reject both/neither,
invalid paths and extra keys. Response:

```json
{"protocol_version":1,"type":"file_stat","file":{"file_id":"<uuid>","path":"assets/book.pdf","revision":"<opaque>","content_digest":"sha256:…","size":1234,"media_class":"pdf","modified_at":"<timestamp>"}}
```

`file:null` means missing or not visible under the exact file scope; forbidden action
is a typed denial, not missing. Descriptor is the existing shape (valid media-class
values), not OS stat: no inode, absolute path, unapproved MIME inference or new time
semantics. Local lookup reconciles the target with current filesystem state and
returns a coherent descriptor or explicit unavailable/conflict; cached index alone
must not assert deleted/changed bytes are current. External ID moves reuse existing
identity checks, rechecking destination scope before returning; an unprovable ID
relocation is missing, not fabricated identity. Exceptional move reconciliation may
scan as today's implementation does; normal path lookup is point work.

Hosted `POST /v1/authorities/{collection_id}/files/stat` uses the same signed file
request proof/body binding as other control calls; local loopback/encrypted relay
carry the file-control message. Path token locates encrypted descriptor; decrypted
canonical path, collection and ID must agree with the index or fail as an invariant
violation. No persisted schema change should be needed. SDK
`files.stat({path}|{fileId}, options)` returns `ConnectOutcome<FileDescriptor|null>`.
Downloads remain revision/digest-pinned; a stat does not reserve bytes or excuse
revalidation on open/download. Optional future `statMany` must negotiate separately
or ship as bounded client composition, not imply cross-item atomicity.

## Authorization and compatibility

Stat requires existing **file list action**, not just record `read` or file `read`.
ADR 0013 file actions do not gain new effects: stat is point metadata enumeration,
not byte access. Local current cached grant and hosted installed policy check origin,
epoch/lease, list action and exact folder scope. Validate explicit path scope before
lookup; use the same null result for invisible ID targets and absence. No descriptor
or changed destination leaks outside the scope. Reject traversal, symlinks and
cross-collection IDs; use existing secure filesystem-open/reconciliation mechanisms.

On absent capability, Writer/Reader/editor/TaskNotes SDK fallback is their existing
paginated listing, narrowed to a known folder for paths (whole approved scope for
IDs), matching the portable path key. Do not claim it has point cost or an atomic
inventory snapshot; preserve listing reset/cancellation errors. Remove it under B1's
minimum-authority/consumer/rollback gate. MCP currently lacks a file-stat tool:
optional later tool requires declared file-list approval and the same discovery;
never derive it from record-read permission. No mandatory MCP migration.

Reader removes folder caches used solely for single-document discovery, retains URL
leases/export inventories. Writer replaces targeted refresh scans but retains browse
inventories. Editor uses stat for requested embeds, retains suggestion/file browsing
inventory and blob URL ownership. TaskNotes adopts only where a descriptor is absent
or stale. Obsidian stays on sync descriptors.

## Tests and size

M, 4–6 engineer-days. Local/hosted path and ID; portable case aliases; excluded or
record paths; deletion/external byte edits and rename in/out of scope; ID from another
collection; symlink/path traversal; denied list, read-only and revoked grants; zero
metadata leakage for invisible targets; stat→edit→pinned-download conflict. Assert
normal hosted path lookup decrypts one descriptor and local point lookup does not
warm/scan unrelated folders. Qualify old authority fallback, files-only discovery,
cancellation and file-list-changed behaviour. Benchmark one lookup in sdk-review's
5k-file inventory (calls/bytes), run request-path e2e on implementation.
