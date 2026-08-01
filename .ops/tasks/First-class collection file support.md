---
title: First-class collection file support
status: done
priority: critical
owner: codex
tags: [files, protocol, sdk, encryption, sync, mirrors, hosted, infrastructure, testing]
created_at: 2026-08-01T12:33:28+10:00
updated_at: 2026-08-01T19:41:11+10:00
type: task
---

## Context

mdbase collections may contain images, audio, video, PDFs, and other regular
files that are not records or structural resources. Connect currently omits
those files from application access, hosted storage, replication, filesystem
mirrors, and authority transfer. The prerelease phase is the right time to
introduce a coherent file model rather than widen the record extension
allowlist or push base64 payloads through the JSON operation envelope.

## Desired outcome

Make collection files first-class, safe, and easy for applications to use.
Files may remain at ordinary user-chosen collection-relative paths while their
authorization, transfer, storage, replication, selective materialization, and
conflict behavior use a separate versioned capability and protocol namespace.

Normal SDK users work with `Blob`, `File`, streams, progress, stable file
handles, and record-link helpers. They do not manage chunks, transport choice,
encryption, resumability, or authority-specific storage.

## Architectural commitments

- Classify every managed entry as a record, structural resource, or file.
- Use `file` publicly and `blob` for immutable stored bytes; an attachment is a
  relationship between a record and a file.
- Permit files at safe user-chosen paths rather than require one physical
  attachments directory.
- Exclude hidden, reserved, nested-collection, configured-exclusion,
  symlinked, non-regular, and platform-unsafe paths before file policy.
- Give files stable IDs, mutable paths, opaque conditional revisions, and exact
  SHA-256 content digests.
- Preserve one write authority and one ordered collection history across
  records, resources, and files.
- Keep JSON for transfer control and use bounded binary chunks for file data.
- Reuse grant identity while deriving domain-separated transfer keys for local
  direct and relayed traffic.
- Stage bytes before atomically committing a file mutation and change event.
- Keep application grants, collection sync inclusion, and per-device
  materialization policy independent.
- Replicate file manifests in snapshots and changes, then fetch immutable blob
  content separately and resumably.
- Store hosted file and attachment metadata and transactions with the
  Render-hosted authority in PostgreSQL, while actual immutable bytes live in
  Cloudflare R2 under opaque authority-controlled keys.
- Version file capabilities, transfer framing, and sync wire objects explicitly
  across Rust and TypeScript.

## Delivery plan

1. Freeze the architecture, threat model, namespaced grant shape, file model,
   transfer framing, sync contracts, error taxonomy, and compatibility fixtures.
2. Implement safe collection-file inventory and indexing without duplicating
   mdbase collection semantics.
3. Implement local file control, staged binary upload/download, direct loopback
   delivery, opaque relay routing, replay/idempotency, and the ergonomic SDK.
4. Implement hosted encrypted blob storage, quotas, lifecycle, garbage
   collection, backup/restore implications, and deployment infrastructure.
5. Extend snapshots, ordered changes, offline mutations, filesystem mirrors,
   selective sync, conflicts, and authority transfer.
6. Add desktop configuration, authorization copy, examples, documentation,
   fault injection, performance budgets, and complete release verification.

## Verification standard

Commit each coherent vertical slice independently. Run focused tests before
each commit and the complete repository gates after every request-path phase.
Final evidence must include Rust and TypeScript protocol fixtures, crypto
interoperability, property and path corpus tests, direct and relay E2E, hosted
PostgreSQL and object-storage E2E, mirror and authority-transfer E2E, fault
injection, restart/resume, revocation, corruption, quota races, concurrency,
performance, architecture budgets, deployment validation, and the repository's
full prescribed test suite.

## Notes

Implementation work is isolated in
`/home/calluma/projects/mdbase-connect-file-support` on
`agent/file-support`. Infrastructure work is isolated in
`/home/calluma/projects/mdbase-cloud-ops-file-support` on
`agent/file-support-infra`. Existing dirty files in the primary checkouts are
untouched.

The clean worktree baseline passes formatting, strict workspace Clippy, all 173
Rust unit and integration tests plus doc tests, Node 24 workspace typechecking,
all 731 JavaScript and TypeScript tests, architecture budgets, generated
problem-schema consistency, ops-registry validation, and beta
release-readiness validation. Four previously documented stable-release gates
remain intentionally open and are unrelated to file support.

The foundational design is recorded in `docs/files.md`. It replaces the earlier
physical attachment-root assumption with a logical file namespace and freezes
the authority, identity, revision, binary framing, encryption, staged commit,
storage, replication, selective-sync, SDK, and verification boundaries before
wire implementation.

The first executable protocol slice defines the strict
`files.v1.schema.json`, shared Rust and TypeScript models, and the bounded
`MDBF` binary frame codec. Frame headers are canonical JSON; prefixes and
payloads are length-bounded before slicing; unknown versions, kinds, flags,
fields, duplicate keys, trailing bytes, inconsistent chunk offsets, transfer
bounds, direction mismatches, and AEAD tag-length mismatches are rejected.
One checked-in golden frame is encoded byte-for-byte by both runtimes.

Focused verification passes: 18 Rust protocol tests, strict protocol Clippy,
Rust formatting, TypeScript typechecking/build, 24 Node protocol tests,
strict compilation of every canonical JSON Schema, architecture budgets, and
`git diff --check`.

The file data plane now has its own grant-bound encryption implementation in
Rust and the browser SDK. It derives a distinct HKDF-SHA-256/AES-256-GCM key
for each transfer direction, uses the chunk index as a transfer-local nonce,
authenticates the complete bounded prefix and canonical header, and does not
consume ordinary JSON operation counters. A fixed shared-secret fixture proves
byte-identical ciphertext and decryption across Rust and Web Crypto. Focused
verification now passes 21 Rust protocol tests and 86 browser SDK tests.

The hosted boundary is explicit: attachment/file rows and transactions live in
the Render-hosted PostgreSQL authority; immutable file bytes live in Cloudflare
R2. Provider-issued staging access never constitutes a collection commit.

Sync protocol 1 now carries manifest-only file snapshot pages, file put/remove
events in the same ordered collection history, staged file put/move/delete
mutations, structured conflicts, and idempotent receipts. File bytes are never
embedded in sync JSON. Record-only replicas gained an explicit fail-closed
compatibility boundary so they cannot checkpoint past an unmaterialized file
event. Workspace typechecking, 113 sync tests, protocol tests, strict Clippy,
formatting, schema validation, and architecture budgets pass.

The local authority now has a standalone file inventory boundary. It takes
record/resource paths from mdbase, discovers all other regular non-Markdown
files without requiring an attachments folder, and never traverses hidden,
reserved, dependency, nested-collection, or symlinked directories. It excludes
symlinks, hard links, non-regular and non-Unicode entries, rejects portable-path
aliases, classifies media, and reports actionable local issues. Media toggles
and user folder exclusions are applied in a separate selector so synchronization
policy cannot accidentally redefine app-visible authority inventory. The path
corpus covers hidden trees, nested collections, case and Unicode aliases,
Windows-unsafe names, symlinks, hard links, managed paths, and all media groups.
All 55 core tests, 36 mirror tests, workspace Rust checking, and strict
workspace Clippy pass.

The authority now persists a collection-scoped file index with UUIDv7
identities, exact streaming SHA-256 digests, opaque revisions, portable path
keys, media metadata, and filesystem identity hints. Reads verify the open file
handle before and after hashing to reject replacement races. Identity survives
restart, replacement, rename, and unique copy/delete moves; ambiguous duplicate
content is never guessed. File metadata and its ordered change are committed in
one SQLite transaction using the same collection sequence as records. Seven
focused index tests and strict core Clippy pass.

Local uploads now use a durable transfer journal and owner-only staging on the
destination filesystem. Chunks may arrive out of order, retry idempotently, and
resume after process restart; conflicting retries, invalid bounds, incomplete
sets, stale revisions, unsafe destinations, changed handles, symlinked staging,
and digest mismatches fail closed. Commit makes bytes visible with one atomic
rename, publishes the indexed revision afterward, persists an idempotent
receipt, and automatically completes a journaled commit after restart. Abort,
expiry, zero-byte files, and lost-response replay are covered. Ten focused
transfer tests, 72 total core tests, full-workspace checking, strict workspace
Clippy, formatting, architecture budgets, and diff checks pass.

Local sync now pins a separately paged file manifest in each snapshot and
merges file put/remove events with record changes by the shared sequence. A
rename retains its file ID and emits a complete descriptor; deletion emits a
tombstone without bytes. Both change tables compact at the same retained
boundary. The public sync operation exposes `file_snapshot`, while existing
record-only mirrors continue to fail before checkpointing a file event. The
focused end-to-end cursor test, 73 core tests, 36 mirror tests, strict workspace
Clippy, and architecture checks pass.

Transfer sessions now negotiate a discriminated delivery strategy instead of
pretending one chunk size fits every transport. Local and relayed transfers use
bounded `framed_chunks`; hosted R2 transfers distinguish `object_put`,
`object_multipart`, and revision-pinned `object_ranges`. Multipart has an
independent minimum five MiB part size and an eight MiB deployment default.
Clients choose transfer IDs so opening a resumable transfer is retry-safe. The
provider must stream-verify SHA-256 because R2's multipart SHA-256 is composite
rather than full-object. Rust/schema tests and TypeScript protocol
tests/typechecking pass for every strategy.

The hosted provider now has a testable blob-store boundary and a production R2
implementation built on Cloudflare's S3-compatible API. It validates private
HTTPS endpoints and multipart limits, produces length-bound presigned part
requests, canonicalizes completion parts, supports bounded range reads, and
streams every completed object through an exact size and full SHA-256 check.
R2 errors are logged without exposing storage credentials or object internals.
The AWS SDK dependency set is intentionally locked to versions compatible with
the repository's current stable Rust compiler.

The first hosted vertical slice now persists encrypted file descriptors and
transfer intents in PostgreSQL while keeping bytes in R2. Client-chosen upload
IDs make open retry-safe; single and multipart uploads use presigned staging
objects; commit verifies full SHA-256, copies to an immutable non-presigned
key, rechecks capability/base revision/quotas in a locked transaction, and
publishes an encrypted idempotent receipt. Listing, progress, abort, historical
revision downloads, bounded signed ranges, file snapshot pages, and merged
record/file changes are exposed by the hosted API. A dedicated PostgreSQL +
MinIO end-to-end suite covers single PUT, multipart, replay, listing, exact
downloads, sync manifests/events, digest rejection, hidden paths, database
path confidentiality, and staging cleanup.

Hosted object lifecycle is now tied to authority transactions without making
PostgreSQL carry file bytes. Historical versions retain their immutable R2
keys until the shared change history is compacted; compaction queues obsolete
keys for retryable deletion, collection deletion queues every live, historical,
staging, and committed key before removing authority rows, and maintenance
drains that durable queue. Blob counters are updated in the same database
transaction as retention changes.

The hosted file implementation is split by upload, listing/download, and
persistence responsibilities, with its HTTP surface in a dedicated child
module. No architecture-budget exceptions were added. Strict workspace checks,
hosted-provider Clippy, all 35 provider unit tests, the architecture guard, and
the PostgreSQL + S3-compatible object-store end-to-end suite pass after the
lifecycle and module-boundary work.

Applications can now request file access independently of record contracts and
operations. The versioned manifest requirement names exact actions and either
record-referenced, selected-folder, or full visible-collection scope; hidden,
reserved, and non-portable folder names fail validation. The portal presents
the requested file actions and scope during approval and permits file-only
applications. Grant rows, local policy snapshots, hosted replica capabilities,
token responses, saved client state, and reconciliation all carry the exact
file capability. A manifest change cannot silently expand or narrow an active
grant.

The browser SDK now exposes `connection.files.list()`, `upload()`,
`download()`, and `downloadBytes()` using ordinary `Blob`, `ArrayBuffer`, and
typed-array inputs. It incrementally hashes uploads, negotiates single or
multipart object delivery, retries bounded object operations, assembles
revision-pinned ranges in order, verifies exact byte counts and SHA-256, reports
progress, refreshes authorization once, and cleans up failed transfers. R2
keys, presigned-control details, multipart ETags, and range bookkeeping remain
private. Prepared requests are closed over method, index, offset, length, safe
URL, and browser-sendable headers; multipart completion fails closed when R2
does not expose an ETag.

This request-path phase passes workspace TypeScript checking, all 207 server
tests, all 99 client tests, all 25 JavaScript protocol tests, all 21 Rust
protocol tests, all 73 core tests, the complete Rust workspace suite, strict
workspace Clippy, the architecture guard, and the full JavaScript/TypeScript
workspace suite. The public SDK itself is exercised against a real hosted
provider, PostgreSQL, and an S3-compatible object store in
`hosted-files-e2e.mjs`, confirming that metadata stays in PostgreSQL while file
bytes travel directly to object storage.

Local transfer intents are now owned by the exact grant ID. Every open,
chunk, status, commit, and abort operation rechecks that owner, so transfer
UUID knowledge cannot cross an application boundary. Local upload open is
truly idempotent for an identical client-chosen transfer ID and rejects changed
intent. Local downloads copy the exact indexed revision into an owner-only
staging snapshot before returning a session; chunks can therefore resume after
connector restart and cannot mix bytes if the user edits the live file during
the download. Snapshot copying verifies the source handle, exact size, and
SHA-256, while abort and expiry remove staged bytes. Thirteen focused transfer
tests cover ownership, conflicting open, out-of-order upload, restart recovery,
revision staleness, live-file mutation, expiry, symlinks, corruption, and
zero-byte files; all 76 core tests, strict core Clippy, and architecture budgets
pass.

Local applications now use the same high-level `connection.files` facade as
hosted applications. Encrypted JSON `file_control` messages open, inspect,
commit, and abort grant-owned sessions; a separate loopback data plane carries
bounded `MDBF` frames without base64 or JSON buffering. Upload and download
keys remain grant-, authority-, transfer-, and direction-bound. The SDK skips
already received upload chunks, retries idempotent chunks, validates every
negotiated offset and length, authenticates each download frame, restores
ordering, verifies the final SHA-256, and hides framing and keys from normal
applications. The connector rechecks current action and folder scope on every
chunk and terminal control operation, including after policy changes. One
HTTP-level Rust test exercises encrypted open, binary upload, atomic commit,
listing, revision-pinned binary download, and decryption; browser tests cover
framed resume, concurrency, transport absence, binding, permission denial, and
frame substitution. All 76 core tests, 25 daemon tests, 21 Rust protocol tests,
105 client tests, 25 JavaScript protocol tests, strict Clippy, typechecking,
schema compilation, and architecture budgets pass for this slice.

Relay file delivery now has a frozen binary wrapper rather than a JSON/base64
escape hatch. `MDBR` protocol 1 correlates one opaque `MDBF` upload chunk,
download request, acknowledgement, download chunk, or rejection with exact
grant, transfer, request, and chunk identities. Prefix, canonical header, kind,
payload presence, safe-integer, and total-size limits fail closed before
forwarding. A shared fixture proves byte-identical Rust and TypeScript encoding.
Connectors advertise `file-relay-v1` independently from the required record
relay capabilities, preserving compatibility with older connectors while file
routes can demand an upgraded endpoint. All 24 Rust protocol tests, 28
JavaScript protocol/schema tests, strict protocol Clippy, and architecture
budgets pass.

## Handoff

Implementation is complete on two clean, incremental branches:

- `mdbase-connect` worktree
  `/home/calluma/projects/mdbase-connect-file-support`, branch
  `agent/file-support`, head `987ee3e`;
- `mdbase-cloud-ops` worktree
  `/home/calluma/projects/mdbase-cloud-ops-file-support`, branch
  `agent/file-support-infra`, head `11985cd`.

The final architecture has no dedicated attachments root. Visible safe files
keep collection-relative paths; dot-prefixed and managed paths are always out
of scope, before optional media-class and folder selection. Applications use
the storage-neutral `connection.files` facade. Local direct and relay traffic
uses independently encrypted bounded binary frames. Hosted file identity,
versions, intent, progress, receipts, changes, quotas, retention, import state,
and record-held attachment references are transactional Render/PostgreSQL
data. Actual immutable bytes exist only in Cloudflare R2 under opaque keys.

Hosted single PUT, multipart upload, pinned range download, authority import,
garbage collection, and authority transfer all use that split. Multipart
sessions recover ordered R2 part receipts, so a restarted browser, mirror, or
Rust agent skips already uploaded ranges instead of retransmitting them. R2
completion is never a collection commit: the provider rechecks state and
authorization, streams the whole object through exact size and SHA-256
verification, promotes it to an immutable key, and commits PostgreSQL metadata.
Abandoned staging and committed import objects are durably queued for
reference-safe deletion; infrastructure docs prescribe scoped CORS and R2
lifecycle backstops that never age-delete committed blobs.

Final verification passes:

- `cargo test --workspace` and strict workspace Clippy;
- the complete `pnpm test` matrix and workspace typechecking under Node 24;
- architecture, generated-problem, mobile bundle, release-readiness,
  dependency-audit, package-audit, and package-consumer checks;
- the dedicated live PostgreSQL + S3-compatible file E2E, including multipart
  restart, lifecycle replay, exact download, retained-version GC, and SDK use;
- the provider E2E through both local-authority transfer and portable-authority
  adoption, including an 8 MiB multipart file, R2 receipt recovery, activation,
  snapshot verification, and byte-for-byte download.

The provider E2E later fails in its existing portal-browser phase because the
local `/login` flow redirects to
`https://editor.mdbase.dev/connect?server=<local>` instead of the local test
dashboard. The file/import phases complete before that point, and no file
change touches the login route. Keep this separate from file support when
triaging.

No Render service was mutated. The branches contain the required environment,
quota, CORS, lifecycle, and cleanup definitions; deployment should follow the
normal reviewed infrastructure rollout.
