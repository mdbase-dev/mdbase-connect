# Collection files

Status: implemented pre-release protocol 1; wire compatibility may still change

## Purpose

mdbase collections may contain images, audio, video, PDFs, and other regular
files that are neither records nor structural resources. Connect treats these
objects as **collection files**. A file becomes an **attachment** only when a
record refers to it.

Applications should work with stable file handles, `Blob`, `File`, streams,
progress, and record-link helpers. Binary framing, encryption, resumability,
transport selection, staging, and provider storage are SDK and authority
responsibilities.

Files retain ordinary collection-relative paths. Connect does not require a
physical `attachments/` folder. The security boundary is a separate logical
file namespace, capability, transfer protocol, and materialization policy.

## Entry classification

Every managed collection entry has exactly one semantic class:

1. **record**: an ordinary record recognized by the collection's configured
   record policy;
2. **resource**: configuration, type, contract, schema, saved-view source, or
   another explicitly supported structural document; or
3. **file**: an eligible regular file that is neither a record nor a resource.

Classification precedes media selection. A configured `.mdx` record remains a
record even if a replica enables `other` files. File discovery uses the same
collection exclusions and nested-collection boundaries as `mdbase-rs`; Connect
must not reproduce a second interpretation of collection layout.

The following paths are outside the file namespace before any user selection
is evaluated:

- any path with a dot-prefixed component;
- Connect, mdbase, version-control, dependency, cache, and migration state;
- configured exclusions and nested collection roots;
- symlinks, reparse points, non-regular files, and unsafe hard-link cases;
- paths rejected by the shared portable-path policy; and
- paths that collide under case folding or Unicode normalization.

Hidden paths use this portable component rule rather than an operating-system
attribute. Connect never traverses an excluded directory to discover files.

## Authoritative file model

The provider-neutral file descriptor is:

```text
file_id          immutable UUIDv7 identity
path             mutable portable collection-relative path
revision         opaque authority revision for conditional mutation
content_digest   sha256:<lowercase hex> of the exact bytes
size             unsigned byte length
media_class      image | audio | video | pdf | other
```

`revision` and `content_digest` are intentionally distinct. Moving a file
changes its revision without changing its bytes. A provider may also change
revision construction without changing the exact digest contract used to
verify transfers and filesystem materialization.

The authority owns the mapping from stable file ID and path to one immutable
blob revision. The blob store owns exact bytes; it does not decide path,
authorization, mutation, or collection policy.

Local authorities keep descriptors in a durable SQLite index. A filesystem
watcher advances a durable observed generation for any collection change; the
next new listing reconciles that generation, while a bounded age check recovers
from missed watcher signals. Reconciliation walks eligible paths and hashes
verified handles once per generation, not once per page. Listing pages then use
bounded indexed queries. Continuation cursors are opaque and tied to one index
revision, so a refresh that changes descriptors expires the cursor instead of
silently mixing two inventories. A dirty signal or no-op reconciliation does
not invalidate an in-progress page sequence.

## Authority and commit ordering

Records, resources, and files share one collection write authority and one
ordered collection history. A committed file create, replacement, move, or
delete increments the collection head and publishes a typed change. Uploading
staged bytes does not modify collection state.

The change union adds:

```text
file_put     complete current file descriptor
file_remove  file ID, previous path, and tombstone revision
```

Change entries never contain blob bytes. A move is `file_put` for the same file
ID at a new path. Retained versions and snapshot leases keep referenced blob
revisions alive for the same bounded history used by replication.

## Versioned capabilities

Grant capabilities are discriminated and independently versioned rather than
represented by one ever-growing operation list:

```json
{
  "kind": "files",
  "protocol_version": 1,
  "actions": ["list", "read", "add", "replace", "move", "delete"],
  "scope": {
    "kind": "selected_folders",
    "folders": ["Photos", "Documents"]
  }
}
```

The initial file scope modes are:

- `selected_folders`: files below authority-approved collection folders; and
- `collection`: every eligible file in the logical file namespace.

Folder scopes are optional least-authority boundaries, not required storage
roots. Read and write actions are reviewed separately. The authority rechecks
the live grant at transfer creation, for every local chunk or hosted range, and
at commit. Revocation rejects the next bounded request; a response already
authorized and in flight may finish, and bytes already received cannot be
recalled.

Media classes support understandable sync selection and approval copy, but are
not trusted content types. Extension classification, MIME declarations, and
content sniffing cannot turn an unsafe path into an eligible one.

## Control and data planes

Small commands remain bounded encrypted JSON:

- list and inspect files;
- open upload or download;
- inspect transfer progress;
- commit or abort an upload; and
- move or delete a committed file.

File bytes use a separate negotiated data plane. Local direct and relayed
transfers use independently authenticated indexed frames with a default of one
MiB and a four MiB maximum. Hosted direct uploads use a presigned single PUT
for small and empty objects, or presigned multipart parts for larger objects;
R2 parts default to eight MiB because every non-final R2 part must be at least
five MiB. Hosted downloads use authenticated, revision-pinned range endpoints
that recheck the live replica and grant before reading each bounded R2 range.
The provider validates the exact streamed length, sends an explicit
`Content-Length`, and stops reading R2 when the application cancels. Upload and
download part sizes are separately configured, so increasing multipart upload
throughput cannot accidentally increase download memory use.
Hosted range responses are not MDBF frames and do not relax the smaller relay
memory bound.
The client chooses the transfer UUID so opening a transfer is retry-safe. The
durable transfer record contains that opaque ID, direction, grant binding, file
intent, expected size, optional declared digest, base revision, accepted chunk
map, opaque multipart receipts recovered from R2, expiry, and terminal receipt.

Uploading follows this state machine:

```text
open -> receiving -> complete -> committed
  |         |           |
  +---------+-----------+-> aborted | expired
```

Only `receiving` accepts chunks. Retrying an accepted chunk must present the
same authenticated bytes. Commit rechecks authorization, path policy, quota,
base revision, completeness, exact size, and the full content digest before it
atomically installs the file entry and change receipt.

Downloads pin one file revision for their lifetime and support indexed range
reads. The protocol lets a client that retains the transfer identity resume
those reads while its grant, revision, and expiry remain valid. A live SDK
download keeps one identity while retrying unopened chunks and can switch local
delivery between direct and relay. The current public `downloadStream()` does
not persist a stopped download or resume a hosted range after some of its bytes
have already reached the consumer; callers reopen the pinned revision instead.

For local downloads, path-scope authorization runs inside the authoritative
reconcile-and-open operation against the descriptor that will actually be
staged. A file moved outside a selected-folder grant cannot exploit a stale
listing descriptor between the scope check and the verified open.

## Binary frame

The binary carrier begins with a bounded framing prefix followed by an
authenticated header and payload:

```text
magic              4 bytes: MDBF
frame_version      u8: 1
frame_kind         u8: upload_chunk | download_chunk
flags              u16 big endian, zero in v1
header_length      u32 big endian
payload_length     u32 big endian
header             exact UTF-8 JSON bytes
payload            plaintext or AEAD ciphertext according to protection
```

The header contains the protocol, protection profile, grant and authority
binding, collection and transfer IDs, direction, chunk index, byte offset,
negotiated chunk size, plaintext length, total size, scope epoch, and key
ID. Headers use the canonical field order with no insignificant whitespace so
Rust and TypeScript produce identical bytes. The complete prefix and exact
header bytes are authenticated associated data. Routers may inspect the header
but cannot rewrite it without authentication failure.

Frames are bounded before allocation. Unknown versions, kinds, flags,
duplicate fields, inconsistent lengths, overflow, trailing bytes, and chunks
outside the declared transfer are rejected before storage.

## Transfer encryption

Local direct and relayed files use mandatory grant-bound end-to-end
encryption. A unique transfer key is derived from the existing grant shared
secret with HKDF-SHA-256 and a domain-separated context containing at least:

- `mdbase-file-transfer-v1`;
- grant, application, connector, and collection IDs;
- scope epoch and key ID;
- transfer ID; and
- direction.

AES-256-GCM authenticates each chunk independently. The unique transfer key
allows the chunk index to participate in the 96-bit nonce construction without
sharing the ordinary operation counter. Reusing an index with different bytes
is rejected and requires a new transfer.

The loopback and relay carry the same binary frame. The relay routes bounded
opaque frames in memory, applies credential, grant, size, concurrency, and
backpressure checks, and never persists ciphertext. Exact chunk receipts make
direct-to-relay retry idempotent.

Standard hosted authorities receive file bytes directly over TLS and encrypt
them at rest. If a deployment routes hosted content through an intermediary
outside the provider trust boundary, the file frame uses authority-terminated
AEAD. The product must describe these protection profiles accurately rather
than imply that hosted providers cannot decrypt content.

## Storage adapters

A local filesystem authority stages uploads on the destination filesystem,
uses owner-only temporary permissions, verifies bytes through a streaming
digest, and installs the result with atomic replacement. Crash recovery either
completes an already committed journal entry or removes an uncommitted staging
file; it never exposes a partial destination.

A hosted authority running on Render stores transactional file metadata,
record-held attachment references, grants, transfer state, quota accounting,
changes, versions, and receipts in PostgreSQL. Actual immutable file bytes live
in Cloudflare R2 under
opaque collection-scoped staging and committed object keys; neither the Render
filesystem nor PostgreSQL is a blob store. R2 credentials remain provider-only.
Any direct multipart upload uses short-lived authority-issued permissions for
one opaque staging object, and an R2 completion is not a collection commit. R2
exposes composite rather than full-object SHA-256 for multipart content, so the
provider streams the completed staging object through a SHA-256 verifier. The
Render authority still verifies the declared size and SHA-256 digest,
checks current grant/path/quota/base-revision state, finalizes the object, and
atomically commits its PostgreSQL file row and ordered change receipt.

Moving a hosted file is a PostgreSQL-only namespace mutation: the new revision
keeps the same immutable R2 object key, size, and digest. Deleting a file
atomically removes its current PostgreSQL row and writes a tombstone, but does
not synchronously delete R2 bytes. Retained versions continue to reference the
object until compaction proves that no current row, pinned snapshot, or retained
version needs it. Idempotency requests and receipts are encrypted in PostgreSQL
and bound to the calling replica, collection, mutation UUID, and exact source
revision and path.

R2's storage encryption is part of the standard-hosted at-rest boundary. Any
additional provider envelope-encryption profile must preserve resumable range
reads and avoid exposing collection keys in signed browser requests.
Cross-collection deduplication is excluded from protocol 1 to avoid equality,
lifecycle, and deletion coupling.

Garbage collection removes expired R2 staging objects and unreferenced retained
versions only after snapshot leases, transfer pins, mutation receipts, and
recovery retention permit it. Because moves share immutable objects across
revisions, GC counts and deletes unique object keys only after the final
PostgreSQL reference disappears. Provider deletion covers both
Render/PostgreSQL metadata and R2 object versions and is verified by restore and
deletion drills.

## Replication and selective sync

Pinned snapshots carry a file manifest at sequence `S`; they do not inline
bytes. Replicas compare exact content digests, fetch missing blob revisions,
stage and verify them, preflight the complete physical path set, then install
the manifest atomically. Incremental `file_put` and `file_remove` changes reuse
the same checks.

Writable replicas stage local file changes and submit conditional mutations
with durable IDs. Binary conflicts are never merged automatically. Resolution
keeps the authority version, replaces it with the local version against a new
base revision, or keeps both under distinct paths. A move can request canonical
Markdown reference updates through mdbase semantics.

Three policies remain independent:

1. **namespace safety** is mandatory and cannot be weakened;
2. **collection inclusion** selects images, audio, video, PDFs, other files,
   and additional excluded folders for authoritative synchronization; and
3. **device materialization** may retain fewer included files on a particular
   mirror or cache.

Records and required structural resources are not affected by file media
toggles. Changing a materialization policy has its own revision and reconciles
the file projection without granting new application authority.

Excluded folders use the same case-folded, Unicode-normalized portable path
identity as collision checks. A folder therefore remains excluded on every
supported filesystem, independent of the current device's case sensitivity.
After a successful durable mirror checkpoint, the device-local
content-addressed blob cache removes complete blobs not referenced by current
files, pending file mutations, or recovery state. Interrupted work files are
not treated as complete cache entries.

Authority transfer includes the pinned file manifest and independently
resumable blobs. The final authority manifest covers file IDs, paths, revisions,
digests, and sizes. Activation cannot occur until the target has verified every
included blob at the final fenced sequence.

## SDK contract

An application requests file intent independently from record contracts:

```json
{
  "requirements": {
    "contracts": [],
    "files": {
      "actions": ["list", "read", "add", "replace", "move", "delete"],
      "scope": { "kind": "selected_folders", "folders": ["Photos"] }
    }
  }
}
```

The ordinary browser API exposes `connection.files`:

```ts
const stored = await connection.files.upload(
  `Photos/${browserFile.name}`,
  browserFile,
  { signal, onProgress }
);

const streamed = await connection.files.uploadStream("Media/video.mp4", {
  size: manifest.size,
  contentDigest: manifest.sha256,
  stream: response.body!
}, { signal, onProgress, transferId });

for await (const file of connection.files.list({ folder: "Photos" })) {
  const stream = await connection.files.downloadStream(file, { signal, onProgress });
  await stream.pipeTo(destination);
}

const moved = await connection.files.move(stored, "Archive/image.jpg");
await connection.files.delete(moved);
```

Move and delete are optimistic, identity-bound mutations. They default to the
descriptor's revision and a generated mutation UUID. Applications retrying an
ambiguous network failure can pass the same `mutationId` to receive the exact
durable receipt. Hosted wire requests use explicit `POST …/{file_id}/move` and
`POST …/{file_id}/delete` mutation endpoints so request bodies and proofs behave
consistently across browsers, proxies, and local encrypted transports.

Record-link helpers can build on this file API without redefining storage
paths. Protocol 1 intentionally does not impose a field schema on records, so
applications currently store the returned `fileId` or `path` through their
ordinary record operation:

```ts
const photo = await connection.files.upload("Photos/today.jpg", browserFile);
const journal = await connection.read({ path: "Journal/today.md" });
if (!journal.ok) return renderProblem(journal.problem);
const updated = await connection.update({
  path: journal.value.path,
  patch: { photo_file_id: photo.fileId, photo_path: photo.path },
  ifRevision: journal.value.revision
});
if (!updated.ok) renderProblem(updated.problem);
```

A schema-aware `attachments.add(...)` convenience API belongs in an
application contract or a future generic record-link API; it is not part of
the current client surface.

The hosted implementation already owns transport negotiation, incremental
hashing, single versus multipart R2 delivery, bounded sequential uploads and
range reads, retry, receipts, progress, abort cleanup, and exact verification.
`uploadStream()` requires an exact size and SHA-256 commitment and verifies the
one-shot source before commit. It does not accumulate multiple file parts: SDK
memory is bounded by one assembled negotiated part plus at most one bounded
source chunk. For a single-part upload, that part is the complete file. A retry
uses a newly opened source and the same caller-chosen transfer ID.
`download()` and `downloadBytes()` are convenience methods capped at 64 MiB;
larger downloads use `downloadStream()` so hosted response chunks flow through
native stream backpressure without assembling a complete range in memory.
Local and relayed authorities use the same facade with encrypted MDBF chunks.
Stable file IDs remain the machine identity; returned paths remain suitable for
human-readable Markdown links. Link resolution delegates to authority-owned
mdbase semantics.

The public problem taxonomy includes structured recovery for permission,
unsafe or occupied paths, unsupported selection, size, quota, stale revision,
incomplete or expired transfer, corrupt chunk, digest mismatch, unavailable
revision, and storage failure. Raw cryptographic errors and provider paths do
not cross the boundary.

## Verification

Cross-store lifecycle races use the deterministic harness described in
[Adversarial file lifecycle testing](adversarial-file-testing.md).

The file feature is not complete without:

- shared Rust and TypeScript fixtures for every JSON object and binary frame;
- cross-runtime key derivation, nonce, AAD, encryption, and tamper tests;
- portable-path, hidden-path, symlink, alias, and race property tests;
- chunk loss, duplication, reordering, corruption, retry, restart, expiry, and
  direct-to-relay recovery tests;
- grant narrowing and revocation during active upload and download;
- size, quota, concurrent commit, stale revision, and garbage-collection races;
- local filesystem crash recovery and atomic visibility tests;
- hosted PostgreSQL and object-storage integration, backup, restore, and
  deletion tests;
- snapshot, incremental sync, selective materialization, writable conflict,
  cursor reset, and authority-transfer end-to-end tests;
- SDK browser tests for `Blob`, stream, abort, progress, cache, and link helpers;
  and
- bounded-memory, throughput, latency, storage, and relay-backpressure gates.
