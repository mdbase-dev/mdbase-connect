# Intent: the mutation and its operations

Status: draft for review, 2026-10-04.

A **mutation** is one logical write: one or more operations applied atomically, with
everything needed to plan them deterministically anywhere. Writes are intents, not
bytes. They say which fields to set, which items to add or remove, and which body text
to change. The planner turns them into exact documents at a log position.

The same mutation is:
- planned **optimistically** at the origin's local view;
- planned **authoritatively** by the writer at the exact log head (first valid wins,
  `log-entry.md` §3);
- **re-planned** by the origin to rebase pending work;
- **re-executed** by verifiers at the entry's position.

All four must reach the same result when they see the same state. So every input a
plan reads is either collection state at the planning position or a field of the
mutation.

## 1. Mutation

```cddl
; ---- mutation (intent.md §1) ----
mutation = {
  0: uuid,               ; id: mutation ID (UUIDv7), the idempotency key
  1: uuid,               ; origin: replica ID that captured the mutation
  2: seq,                ; base_seq: the origin's confirmed position at capture
  3: op-clock,           ; clock: the captured time (§4.1)
  4: bstr .size 32,      ; seed: entropy for generated values (§4.3)
  5: source,             ; source
  6: [+ op],             ; ops: applied atomically, in order
  ? 7: uuid,             ; on_behalf: grant ID of the client that submitted it
  ? 8: conflict-mode,    ; conflict_mode, default 0 (record)
  ? 9: level,            ; validated_at: validation level applied at submit (informational)
  ? 10: room-checkpoint, ; room: set when this write checkpoints a live room (§7)
}

source = &(
  api: 0,        ; a write through the API: lifecycle runs; request checks apply
  external: 1,   ; derived by ingest from an observed file change: no lifecycle, never rejected
)

conflict-mode = &(
  record: 0,     ; apply what merges; record field conflicts; status "conflicted"
  reject: 1,     ; any conflict rejects the whole mutation (all or nothing)
)

level = &( off: 0, warn: 1, error: 2 )
```

Field notes:

- **`id`.** Minted once per logical write by whoever first captures it: the client SDK
  (recommended, so that a retried submit over a broken connection is idempotent) or
  the replica. Re-planning and rebasing never change it. It is the idempotency key for
  the collection (`log-entry.md` §7).
- **`origin`.** The replica that captured the mutation and owns it while it is
  pending. A thin client's mutation has the serving replica as origin and the grant
  in `on_behalf`.
- **`base_seq`.** Informational for planning: plans read state at the planning
  position, not at `base_seq`. Merge bases are explicit in the operations (§3). It
  is used for diagnostics, for the rebase heuristic "has anything touched this
  record since?", and by the receipts horizon.
- **`source`.**
  - `external` is set only by the ingest path. A client cannot submit it.
  - `external` operations are never rejected for validation (spec 04, SC0). They run
    no lifecycle.
  - Only `document`, `file_put`, `file_attach` (§3.9), `file_delete` and
    `file_move` may appear with `source = external` when their profile is supported.
- **`on_behalf`.** Present exactly when a client other than the replica's own process
  submitted the mutation. Replicas check at replay that the grant was active at the
  entry's position and covers every operation (`policy.md` §6).
- **`conflict_mode`.** Chosen by the caller.
  - `record` (the default) follows spec 12: a write without `if_revision` is applied,
    and the concurrent change is not discarded silently. Conflicts are recorded in the
    entry, with both values kept.
  - `reject` gives apps all-or-nothing behaviour without whole-record CAS.
- **`validated_at`.** Records what the origin checked at submit (§6). It does not
  change planning at head.

## 2. Texts

Large strings (bodies, documents, resource files) have the type `text`:

```cddl
; ---- texts (intent.md §2) ----
text = tstr / text-index
text-index = uint      ; index into the enclosing log entry's text table (log-entry.md §2.2)
```

Outside a log entry (in the client API, in pending queues, in fixtures of bare
mutations) a `text` is always a `tstr`. Inside a log entry the writer may replace any
`text` with an index into the entry's text table. The table holds delta-encoded or
blob-backed text and deduplicates the same text between intent and result. Planning
and verification always see the resolved string.

Record documents and bodies are UTF-8 (spec 03). A file with a record extension whose
bytes are not valid UTF-8 is not a record. It is carried as a file (`file_put`) and
reported as an invalid record.

## 3. Operations

Every operation is a struct map with its kind at key 0.

```cddl
; ---- operations (intent.md §3) ----
op = create / update / document / delete / rename
   / resource-put / resource-delete
   / file-put / file-delete / file-move
   / conflict-dismiss / sync-settings / file-attach-v1
   / ordinary-attachment-continuation-v1
   / unindexed-markdown-put-v1 / record-to-unindexed-markdown-v1 / unindexed-markdown-to-record-v1
   / ordinary-file-to-record-v1

fm-map = { * tstr => value }     ; frontmatter mapping, order significant
field-ref = tstr                 ; spec 07 field reference, e.g. "status" or "meta.owner"
base-field = [key: tstr] / [key: tstr, observed: value]   ; 1 element = key was missing
doc-version = {
  0: path,          ; path
  1: text,          ; doc: the exact bytes of the document
}
blob-ref = {
  0: hash,          ; plain_hash: SHA-256 of the plaintext bytes (= the file's content digest and revision)
  1: uint,          ; size: plaintext length in bytes
  2: bstr .size 32, ; blob_id: keyed content ID (sealed-envelope.md §4.2)
  3: epoch,         ; id_epoch: the key epoch whose content key produced blob_id
  4: uint,          ; part_size: plaintext bytes per part (8 MiB by default); parts = ceil(size / part_size), at least 1
}
```

### 3.1 `create`

```cddl
create = {
  0: 1,
  1: uuid,            ; id: the new record ID (UUIDv7)
  ? 2: path,          ; path: explicit target path; absent = derive from path policy
  ? 3: tstr,          ; type: the type selector (spec 12 "selected types")
  ? 4: fm-map,        ; frontmatter: the draft frontmatter
  ? 5: text,          ; body
  ? 6: text,          ; document: complete source instead of frontmatter + body
}
```

- Follows the spec 12 create pipeline. Lifecycle `on_create` runs at planning with the
  mutation's clock and seed.
- `document` must not be combined with `frontmatter` or `body`; that is
  `invalid_request`.
- **Explicit path.** A collision with an existing record's path key is
  `path_conflict`, decided at head (S).
- **Derived path.** Takes the first free suffixed path (spec 02, SC5), decided at head.
  The final path is in the result.
- **An existing `id`.** If the record holding it was created by this same mutation ID,
  it is a duplicate (`log-entry.md` §7). Otherwise it is `invalid_request`.
- The client SDK mints `id`, so an app can refer to the record before confirmation.

### 3.2 `update`

```cddl
update = {
  0: 2,
  1: uuid,                          ; id
  ? 2: fm-map,                      ; patch: set these top-level keys
  ? 3: [+ field-ref],               ; unset: remove these keys
  ? 4: { + tstr => [* value] },     ; add: list items to add, per top-level field
  ? 5: { + tstr => [* value] },     ; remove: list items to remove, per top-level field
  ? 6: text,                        ; body: replacement body
  ? 7: [+ body-edit],               ; body_edits: edits against body_base
  ? 8: hash,                        ; body_base: SHA-256 of the body the edits or replacement were made against
  ? 9: text,                        ; body_base_text: that body, when the writer may not retain it
  ? 10: [+ base-field],             ; base: observed values of the touched keys
  ? 11: hash,                       ; if_revision: opt-in CAS on the whole document
}
body-edit = [start: uint, end: uint, insert: tstr]   ; offsets in Unicode scalar values of the base body
```

Spec 12 defines `patch`, `unset`, `add`, `remove`, `body`, `body_edits` with
`body_base` and `body_base_text`, and the request rules that make a request
`invalid_request`. They are encoded as above, with these additions:

- **`base`: the merge-relevant base for frontmatter.** It holds the value of each key
  the update touches through `patch` or `unset`, as the caller last saw it. A
  one-element entry means the key was missing. At planning, for each touched key `k`:
  - If `base` has no entry for `k`, the change is applied to the current value. This
    is a blind write per key: the writer at the later log position wins.
  - If the current value equals the base value (spec 12A equality), the change is
    applied.
  - Otherwise both sides changed `k`. The key's merge strategy (spec 07/12A) decides,
    with `B` = base, `F` = current, `S` = the update's value:
    - `max`, `min` and `union` combine;
    - `conflict` keeps `F` and records a field conflict holding all three values
      (`log-entry.md` §2.4).

  SDKs SHOULD send `base` for every key they set from a value they read. Without it,
  concurrent field edits silently last-writer-win by log order.
- **`add` / `remove`** need no base. They apply to the current value and commute
  (spec 12, SC2).
- **Body replacement with a base.** `body` with `body_base` (and optionally
  `body_base_text`) is a three-way body merge, exactly as spec 12 defines for
  `body_edits`, where the second version is the replacement body. `body` without
  `body_base` replaces blindly.
- **Body conflicts reject.**
  - A body conflict rejects the whole mutation with `conflict`, reason `body`
    (spec 12, `concurrent_modification` / `body_conflict`), whatever `conflict_mode`
    says.
  - An unobtainable base is reason `body_base_unavailable`.
  - Both are decided at head.
- **The writer's own base text.** The writer obtains the base body for a merge from
  `body_base_text`, from the record's current body if its digest matches, or from
  bodies it retains. Because replicas retain different histories, **a writer that
  merges from a retained body MUST copy it into `body_base_text` in the entry** before
  sealing. Verifiers can then always re-execute. In the entry the text is usually a
  cheap delta (`log-entry.md` §2.2).
- **`if_revision`.** Opt-in CAS (§5).
- **Update of a deleted record.** If the record has a tombstone (`snapshot.md` §3), it
  is resurrected from the tombstone's document and the update applies to it (spec
  boundary: this is the D8 policy). The path goes through the collision rule. The
  status is `merged`.
- **Update of an unknown record** (no record, no tombstone) is `not_found`.

### 3.3 `document`

```cddl
document = {
  0: 3,
  1: uuid,              ; id
  ? 2: doc-version,     ; base: the version the change was made against; absent = creation observed
  ? 3: doc-version,     ; new: the version written; absent = deletion observed
  ? 4: hash,            ; if_revision (api source only)
}
```

Whole-document change, used for two things:

1. **External edits** (`source = external`). Ingest derives `base` = the version this
   replica last knew was on disk for that path, and `new` = what is on disk now. Both
   travel in the operation, so any replica can re-plan it (DESIGN §2). In the log
   entry, `base` usually resolves to the record's previous document, so the delta
   costs almost nothing.
2. **API document replacement** (spec 12 `document`; `source = api`). `base` is the
   version the caller read (the SDK supplies it when it has one).
   - Lifecycle runs on `new`.
   - Without `base` it is a blind replacement.
   - With `if_revision` it is CAS.

At planning:
- If the current document equals `base`, `new` is applied.
- Otherwise the three-way record merge of spec 12A runs: `B` = base, `F` = current,
  `S` = new. A conflict keeps `F`'s value and is recorded.
  - `external`: never rejected. The origin device holds the file (`log-entry.md` §6).
  - `api`: follows `conflict_mode`.
- A `new` whose path differs from the current path is a move. It merges like the
  `path` rule in spec 12A.
- `new` absent is a deletion. Against a record changed since `base` it is superseded,
  as for `delete` with `base_revision` (§3.4).
- An unknown `id` is a creation, with or without `base`. With `base`, it is a late
  external edit to a record whose tombstone was pruned (`snapshot.md` §6), and the
  user's bytes are kept.

### 3.4 `delete`

```cddl
delete = {
  0: 4,
  1: uuid,             ; id
  ? 2: hash,           ; base_revision: revision the deleter saw (not CAS)
  ? 3: hash,           ; if_revision: opt-in CAS
}
```

- With `base_revision`, if the record changed after the deleter saw it, the delete is
  **superseded**. The record stays, and the entry records a conflict of kind `delete`
  with status `conflicted`. Losing an edit is worse than keeping a deleted record
  (D8).
- Without `base_revision`, the delete is unconditional.
- A successful delete leaves a tombstone holding the last document (`snapshot.md` §3).
- Deleting an unknown or already deleted record succeeds as a no-op (status
  `applied`, no effects). Deletes are idempotent.

### 3.5 `rename`

```cddl
rename = {
  0: 5,
  1: uuid,             ; id
  2: path,             ; from: the path the caller saw
  3: path,             ; to
  4: bool,             ; update_refs: rewrite links in other records
  ? 5: hash,           ; if_revision
}
```

- **`from` must equal the record's current path** at head. Otherwise the mutation is
  rejected with `conflict`, reason `renamed`. Two renames of one record are ordered,
  and the first valid wins (S).
- **A `to` whose path key equals another record's** is `path_conflict` (S). The same
  path key as the record's own path is a respelling, not a conflict (spec 12).
- **`update_refs`.** Link rewriting (spec 08) produces `put_record` effects for every
  referrer, written with format fidelity (spec 12A). The rename and its reference
  updates are **one atomic entry**, which is the "MAY commit as one atomic batch" of
  spec 12.
- The old path key becomes an alias for the record (`log-entry.md` §2.3, D9).
- Renaming is an `api` operation. External moves arrive as `document` operations with
  a different `new.path`.

### 3.6 Resource writes: `resource_put` and `resource_delete`

```cddl
resource-put = {
  0: 6,
  1: path,             ; path: mdbase.yaml, or a file in the types or contracts folder
  2: text,             ; doc: complete new source
  ? 3: hash,           ; base_revision: CAS on the current resource
  ? 4: true,           ; must_not_exist: the path must hold no resource (S); present only when true
}
resource-delete = {
  0: 7,
  1: path,
  ? 2: hash,           ; base_revision
}
```

Resources are the control files that define semantics: `mdbase.yaml`, type files and
contract files (spec 04/05/05a). They are ordered (S class):
- **CAS.** With `base_revision`, a resource write is CAS checked at head. Without it,
  it replaces blindly. **SDKs SHOULD always send `base_revision`.** Schema edits are
  rare and a lost one is confusing.
- **Create only.** `must_not_exist` makes the write fail when a resource already
  exists at the path: rejected with `conflict`, reason `path_taken`, `details` = the
  current revision. It is S-class, checked at submit when visible locally and
  authoritatively at head. Combining it with `base_revision` is `invalid_request`.
  Use it for every create the caller expects to be new (type-pack `create`, "new
  type"), so a concurrent create of the same path is never overwritten.
- **Validity is a request check.** A write that leaves the configuration or a type
  file invalid is rejected at every level (spec 04, request and safety tier). It is
  checked at submit and again at head, because type files reference each other.
  Multiple resource operations are checked against their complete staged resource
  subset, including in a mixed resource/record mutation. Every original CAS and
  create-only guard still applies. Ordinary operations keep their original order
  and current-step catalog checks; they do not borrow a later configuration.
- **A resource write ends the writer's planning batch.** Later mutations plan under
  the new catalog (`log-entry.md` §3).
- **Paths.** A `resource_put` whose path is not a resource path under the catalog in
  force at head is `invalid_request`. The catalog decides where types live, and a
  `resource_put` of `mdbase.yaml` can move the types folder; the planner resolves
  this deterministically.
- **Saved-view sources are records or files, not resources.** When `base` is in
  `settings.record_extensions`, an eligible `.base` source is a YAML-document
  record, written with ordinary `create`/`document`/`delete` operations and its real
  record UUID. Explicit-path record creation refuses an occupied path. Otherwise
  an eligible `.base` file uses file operations. Classification is unchanged by
  calling it a view; no view-specific operation or pack resource kind is required.

### 3.7 File operations

A collection entry has exactly one class (as in Connect's `docs/files.md`):
- a **record**, recognized by the collection's record policy (spec 02/03);
- a **resource** (§3.6);
- a **file**: an eligible regular file that is neither.

Classification comes before any media selection. A configured record extension stays a
record whatever the file settings say.

**Namespace safety** is mandatory, and the core applies it identically on every
replica. These paths are never files:
- paths with a dot-prefixed component;
- `.mdbase/`, version-control, dependency and cache state;
- configured exclusions and nested collection roots;
- symlinks, reparse points and other non-regular files;
- paths rejected by the portable path policy, or colliding under case folding and NFC.

A file becomes an *attachment* to a record only in the sense that the record links
to it. The chunked attachment **content profile** (§3.9) does not require a backlink
and does not introduce a new entity kind or authorization mechanism.

```cddl
file-put = {
  0: 8,
  1: uuid,             ; id: file ID (UUIDv7); unknown ID = create
  2: path,             ; path (for a create; for a replace it must equal the current path)
  3: blob-ref,         ; content
  ? 4: hash,           ; if_revision: opt-in CAS on the current content digest (api)
  ? 5: hash,           ; base: the content digest this replica last saw on disk (external)
}
file-delete = {
  0: 9,
  1: uuid,             ; id
  ? 2: hash,           ; if_revision: opt-in CAS (api)
  ? 3: hash,           ; base: digest last seen before the deletion was observed (external, and api "delete what I saw")
}
file-move = {
  0: 10,
  1: uuid,             ; id
  2: path,             ; from: the path the caller saw
  3: path,             ; to
  4: bool,             ; update_refs: rewrite links to the file in records (spec 08)
  ? 5: hash,           ; if_revision
}
sync-settings = {
  0: 12,
  1: file-inclusion,
}
file-inclusion = {
  0: [* media-class],  ; include: media classes synchronized (records and resources are always included)
  ? 1: [* path],       ; exclude: additional excluded folders (path keys compared, spec 02)
  ? 2: uint,           ; max_size: files larger than this are not synchronized
}
media-class = &( image: 0, audio: 1, video: 2, pdf: 3, other: 4 )
```

**A file's identity and content.**
- **Identity.** A file has a stable file ID (UUIDv7), never written into the file, as
  for records.
- **Legacy content.** A `file_put` has exactly one immutable `blob-ref` with the
  SHA-256 content digest, size and keyed blob ID under which sealed parts are stored
  (`sealed-envelope.md` §4). Chunked content uses the explicit critical profile
  in §3.9 instead; it is never reinterpreted as a `blob-ref`.
- **Revision.** A file's revision for CAS is its content digest. Moves are guarded by
  `from`, not by the revision.
- **Upload before append.** The writer uploads the parts **before** the mutation is
  appended, and lists them in the entry's `refs` (`log-entry.md` §3.2). Change
  entries never contain file bytes.

**Planning rules (at head).**
- **`file_put` with an unknown ID** creates the file. A path held by another file or
  record:
  - `api`: rejected with `conflict` reason `path_taken`;
  - `external`: the ingested file takes the suffixed path (SC5).
- **`file_put` with a known ID** replaces the content.
  - `if_revision` is opt-in CAS. A mismatch rejects with `conflict` reason
    `revision`.
  - `external` puts carry `base`. If the current digest differs from `base`, another
    writer replaced the file concurrently.
- **Binary content is never merged.** A concurrent replacement of an external put is
  recorded as a conflict of kind `file`:
  - `kept` is the current `blob-ref`;
  - `lost` is this put's `blob-ref`, so its bytes stay referenced and recoverable;
  - the status is `conflicted`;
  - the origin device **holds** its local file.

  The user resolves with take-theirs, replace (a new `file_put` with
  `if_revision` = the kept digest), or **keep both**: the replica writes the held
  bytes as a new file at a distinct path (`name (conflict <device> <date>).ext`) and
  takes theirs at the original path (`replica-client-api.md` §8.1).
- **`file_delete`.**
  - `if_revision` is CAS, rejected on mismatch.
  - With `base`, a delete of content that changed since `base` is **superseded**, as
    `delete` is for records (§3.4): the file stays, a conflict of kind `delete` is
    recorded, and status is `conflicted`.
  - Deleting an unknown or deleted file is a no-op.
  - A deleted file leaves a tombstone holding its last `blob-ref` (`snapshot.md` §3).
- **`file_move`.**
  - A stale `from` is `conflict` reason `renamed` for `api`. For `external`, moves
    arrive as a `file_delete` and `file_put` pair that ingest pairs by digest (spec
    12A move detection), encoded as `file_move`.
  - A `to` path that is taken is `path_taken` (`api`) or suffixed (`external`).
  - `update_refs` rewrites links to the file in every referring record with format
    fidelity, in the same atomic entry, as `rename` does for records (§3.5). Moving a
    file never moves its blob.
- **Excluded content.** A file the current inclusion settings exclude (media class,
  folder, `max_size`) is never ingested. An `api` `file_put` of one is
  `invalid_request`, reason `excluded`. Narrowing the inclusion does not delete files
  from the log; replicas stop materializing them (`replica-client-api.md` §10.3).

**`sync_settings`** sets the collection's **inclusion policy**: which files are
synchronized at all.
- It is collection state, ordered in the log with the file writes it governs, and
  recorded in snapshots (`snapshot.md` §3). It is not stored in any user file.
- It requires `definitions.manage`.
- It is distinct from **device materialization**: which included files a particular
  device keeps on disk. That is a per-device setting, never in the log
  (`replica-client-api.md` §10.3).
- The default for a new collection is to include all media classes, with no `max_size`.

**File-platform boundary:** how a file-backed replica stages, publishes and stashes
non-record files (including multi-gigabyte stashes) is a `FilePlatform` matter
(`open-questions.md` Q26). This contract fixes only the log semantics.

### 3.8 `conflict_dismiss`

```cddl
conflict-dismiss = {
  0: 11,
  1: uuid,             ; mutation: the mutation whose conflict is dismissed
  2: uuid,             ; record
}
```

Removes a recorded conflict from the collection's unresolved-conflicts list
(`snapshot.md` §3). It is synced, so dismissing on one device dismisses everywhere. It
is idempotent and never rejected, except for authorization. Resolving a conflict *by
choosing a value* is an ordinary `update` followed by, or batched with, a
`conflict_dismiss`.

### 3.9 Critical chunked attachment content v1

These discriminants are allocated: Op13, Effect8, ConflictValue5 and snapshot
Sections10/11. **Codec foundation is not runtime activation.** Standalone typed
codecs may read/write the following representations while legacy runtime operation,
effect and section unions continue to reject them as unknown critical variants.
Until complete support is qualified, receiving them must stall/upgrade the **whole**
entry or snapshot, never skip a field/row, void the entry or install partially.
A decoder's unknown-version/profile error must retain this critical classification.

```cddl
; ---- critical attachment descriptors (intent.md §3.9) ----
attachment-ref-v1 = [1, bstr .size 16, epoch, bstr .size 32, 8388608, hash]
; version, collection, key epoch, attachment ID, fixed plaintext chunk bytes,
; SHA-256 of the COMPLETE canonical sealed manifest Item (not its ciphertext field)
attachment-content-v1 = [1, attachment-ref-v1, hash, uint]
; version, descriptor, signed expected WHOLE plaintext SHA-256 and byte length
file-content = blob-ref / attachment-content-v1
file-attach-v1 = {
  0: 13,
  1: uuid,
  2: path,
  3: attachment-content-v1,
  ? 4: hash, ; if_revision
  ? 5: hash, ; external base
}
```

Tuples have exactly six/four elements with the stated types and widths; no optional,
trailing or ignored profile fields. Unknown version or chunk profile requires
upgrade, not legacy fallback. The reference maps exactly to the crypto helper's
`AttachmentContextV1` (fixed v1, collection/epoch/ID/chunk_bytes) and manifest hash;
content adds the REQUIRED signed `ExpectedFileV1` whole hash/size. Collection/epoch
must agree with the verified log/manifest context; signed expected hash/size must
agree with the authenticated manifest. The codec alone cannot verify these facts.

The profile uses explicit authenticated dispatch with the kind18 Item framing in
`sealed-envelope.md`; legacy BlobRef encryption/addresses are unchanged. New objects
use fixed CBOR-text domain D, definite context tuple C and exact header-byte-string H:
KDF `[D,C]`, AAD `[D,C,H]`. An adapter must not guess a profile from bytes or retry
legacy decryption. Standalone crypto/helper/codec support is not emitter permission.

`file_attach` has the same stable File ID, namespace/path/inclusion, create/replace,
CAS, external-base and conflict rules as `file_put`. Its revision is the signed whole
plaintext hash. Move/delete act on that same logical File; state has an explicit
legacy-or-attachment content union, never a fabricated BlobRef. The default file cap
is configurable 1 GiB, plaintext chunks are 8 MiB, sealed complete Items at most 9 MiB,
and the private manifest at most 64 KiB. Admission/object/ref/decoder budgets remain
additional obligations; a content tuple's uint is not permission to exceed them.

Before signing/publishing, the writer must authenticate the complete manifest,
reconcile signed expectations and retain/list **all** chunk and manifest Item hashes,
including conflict-held and tombstoned content. Generic submit must not accept
caller-fabricated verified manifests or bypass typed mediation. Upload precedes append;
recheck held CURRENT write epoch, grants, path, mode, target/provider and app authority
after awaits and before commit. Historical held read keys permit reads, not new writes.

Advertise `attachment-v1` codec support and only individually qualified current-mode,
target/provider directions `attachment-v1.read`, `.write`, `.materialize`. Negotiation
is support, not authorization. Hosted/lightweight paths may stream through qualified
R2/upload providers without a filesystem mirror; no full-array/BLOB fallback or fake
native durability. Private remains routed through an authorized online user device,
never hosted plaintext/keys. Local-only Sync:off does not silently create a log.
Unsupported requests fail upgrade-required **before** upload/emission; standalone
codec support does not enable any direction.

### 3.10 Critical unindexed oversized Markdown v1

Allocated: **Op14/15/16, Effect9/10, ConflictValue6, Sections12/13**.
This is a separate File kind, not a flag inside BlobRef or FileContent. Ordinary
Blob/Attachment representations remain byte-identical. Codec foundation does not
activate emit/apply/install; legacy/default and attachment-only runtime parents
must reject unknown critical members as a WHOLE item/snapshot, never a prefix.

```cddl
; ---- critical unindexed Markdown (intent.md §3.10) ----
unindexed-markdown-payload-v1 = [2, 1, 1, file-content]
; FILE payload discriminator2, profile-version1, FileKind1, unchanged content
; Native eight-tuple slot3 uses this envelope ONLY for this kind; all ordinary
; Blob maps/Attachment four-tuples and the other seven slots are unchanged.
; Slot-3 arrays carry ONE shared tag registry at index 0: attachment-content
; versions (1 today) and file-payload discriminators (2 today) never collide, so
; a legacy attachment decoder whole-rejects this envelope by its leading 2.
unindexed-markdown-put-v1 = {
  0: 14, 1: uuid, 2: path, 3: unindexed-markdown-payload-v1,
  ? 4: unindexed-markdown-payload-v1, ; full expected prior payload; absent=create-only
}
record-to-unindexed-markdown-v1 = {
  0: 15, 1: uuid, 2: path, 3: unindexed-markdown-payload-v1,
  4: hash, ; exact prior record-source revision; mandatory CAS
}
unindexed-markdown-to-record-v1 = {
  0: 16, 1: uuid, 2: path, 3: text, ; complete new UTF8 record source
  4: unindexed-markdown-payload-v1, ; full prior kind/content; mandatory CAS
}
```

FileKind0 is Ordinary (no new envelope); FileKind1 is
`UnindexedOversizedMarkdown`. The version/kind/tag/length are closed. Unknown
versions/kinds require upgrade; never reinterpret a new envelope as content or
fall back to legacy decryption. Plaintext is valid UTF8, **strictly >1,048,576
full-source bytes**, at a captured catalogue record-extension path, never a
resource/excluded path. Blob size/Attachment total_plain_bytes must agree with
verified full plaintext; declared metadata is not authentication proof. Exactly
1MiB remains a record candidate. LocalOnly's source-size exemption is unchanged.

Op14 creates only when ID/path is absent, or replaces an existing SAME kind/path
using exact full-payload CAS. Op15 changes a live record into a File with the SAME
UUID/path, exact prior source revision and holder kind. Op16 reverses using exact
current kind/path/holder/descriptor CAS, with complete UTF8 source <=1MiB passing
bounded frontmatter admission and complete planned-source guards. Full-descriptor
CAS prevents a same-hash concurrent reseal/rekey from being silently overwritten.
CAS failure refuses the WHOLE transition, never a conflict prefix or partial row.

These are explicit trusted import/capture/conversion operations. A new ordinary
record API request remains `record_too_large` on refusal; it must not silently
become Op14/15. No retrospective Head/history/acknowledged-restoration conversion.
Source/disk bytes and failed observations are preserved without acknowledgement.
Structural-budget failure at <=1MiB is typed refusal, not this File kind.
For the initial release, an existing Ordinary File that becomes valid UTF8 above the cap
remains Ordinary (holder/bytes/history preserved). Conversion has a typed
`ordinary_to_unindexed_unsupported` diagnostic and no effects/observation ACK;
Ordinary→unindexed conversion is a backlog item, not an Op14 widening.
The same existing Ordinary holder may continue attachment updates at its
exact record-extension path. This exception uses critical Op18 with REQUIRED
complete FileContent CAS in the planner and receiver (including same-hash
reseal/rekey); unchanged file authority and same ID/exact path are mandatory.
It never permits create-at-record-path or any kind transition. Other Op13 bytes
are unchanged; an older op union whole-refuses critical tag18. Unknown struct
fields are ignored, so an optional Op13 field cannot implement this boundary.

```cddl
ordinary-attachment-continuation-v1 = {
  0: 18, 1: uuid, 2: path, 3: attachment-content-v1,
  4: file-content, ; REQUIRED full prior, not a revision/base surrogate
}
```

RecordToFile/FileToRecord are atomic holder/index transitions, not ordered
RemoveRecord+PutFile prefixes. No simultaneous live record/file or synthetic
opposite-kind tombstone. Move/delete/reseal/rekey retain kind, descriptor and
complete roots; a destination outside record paths requires explicit Ordinary
conversion. File listings/materialization expose typed unindexed status and exact
source; record IDs/index projections/query membership exclude it independent of
extension. Each stored version includes its kind in tomb/conflict/snapshot forms.

**T6b lost-tail recovery.** At verified host-internal
`Stage::Resurrect`, Ops15/16 kind transitions unconditionally no-effect skip with
`unindexed_kind_transition_requires_capture`. Preserve the current holder, exact
bytes and history; only a fresh current-state capture may retry the transition.
Op14 same-kind content writes retry exact prior descriptor CAS; mismatch follows
existing keep-both conflict semantics, never a silent overwrite or retrospective
kind change. Restored same-ID Record: kept=`Text(record.doc)`, lost=Unindexed
Markdown descriptor, Record FM/doc/history untouched. Restored same-ID Ordinary:
kept=`File(content)`, lost=Unindexed descriptor. These descriptors are durable
conflict roots; no new wire value or implicit holder conversion is introduced.
For restored same-ID unindexed Files renamed since capture, recover content at
its CURRENT path when exact prior CAS matches; on mismatch use keep-both at the
current path. Content recovery follows identity; the path follows the latest
rename, which is NEVER undone. Head/capture still requires the exact path.
If no live holder exists but a same-ID Ordinary File or Record tombstone remains,
keep it untouched: kept=`Deleted`, lost=Unindexed descriptor (durable root), for
explicit user restoration. Never resurrect in a different retained kind. A
same-kind unindexed tombstone follows normal recovery.

For signed valid Ops14/15 with COMPLETE authenticated plaintext/full hash/count
but invalid UTF8, receiving records a deterministic typed no-effect rejection
`unindexed_markdown_invalid_utf8` attributed to the writer. Confirmation advances;
holder/content stay unchanged. Never whole-entry stall on this writer error.
Missing keys/objects remain retriable waits; corrupt/incomplete authentication
is NOT this rejection. Even an invalid UTF8 prefix requires authenticating the
remaining source before choosing deterministic rejection.

**T6b authority boundary.** Initial activation is only
healthy keyed editor-device capture, with `on_behalf = None`, for Ops14–16.
Delegated `on_behalf` entries must fail-closed/stall until composite record/file
capability and `file_folders` checks qualify. No generic SDK Submit/capture
activation or new capability is implied. Delegated support is deferred.

Replica proves plaintext/descriptor/source binding and current authority and
rechecks captured catalogue, holder and FULL descriptor across awaits before
publication. File commits record/link/unique/projection removal and file/head/
receipt installation in the SAME transaction. Codec support alone supplies no
provider, runtime, durability, or aggregate32MiB readiness.


### 3.11 Explicit internal attachment runtime v1 decoding

`attachment_runtime_v1` is a separately selected, typed codec family. Its mutation
uses the exact §1 header and fields; each operation delegates an unchanged legacy
operation or decodes critical FileAttach13, unindexed Markdown14–16 or Ordinary
promotion17. Every child is required to decode: unknown future tags, content
versions or chunk profiles reject the whole parent. Default legacy operation and
mutation decoders remain unchanged and reject13–17.
There is no global decoding switch, ignored critical child or parser retry.
Codec selection does not authorize generic submission: verified manifest mediation,
current authority/context checks and provider availability remain Replica duties.

```cddl
attachment-runtime-v1-mutation = mutation
```

**Replica activation (decided 2026-10-07).**
- *Synced reads.* Builds that include this family decode EVERY synced entry,
  snapshot manifest and snapshot chunk with it, always. There is no `hello` gate
  and no local switch. Compatibility is per build. A build that decodes attachment
  content but cannot yet apply or install it stalls the whole entry or install as
  `upgrade_required` with reason `attachment_apply_not_yet`. An older build rejects
  the same bytes as an unknown critical variant and also stalls with
  `upgrade_required`. Neither voids, skips or installs a prefix.
- *Feature.* The app↔replica `hello` grants the bare `attachment-v1` feature
  (`replica-client-api.md` §2) when the build includes this decoder and the app
  asks for it. It means codec support only. The `attachment-v1.read`, `.write` and
  `.materialize` directions (§3.9) are granted only by the work that qualifies each
  one.
- *Submit.* Plain `submit` keeps refusing attachment operations: its operation
  union rejects FileAttach13 as `upgrade_required`, and a caller-built manifest
  is never accepted. Apps add attachments only through the dedicated upload API.
- *Extended family.* Ops14–17/Effects9–11/ConflictValue6/Sections12–13 are
  codec-only until their verified mediation/apply/install slices qualify. A
  decoded extended child stalls the whole entry/snapshot as `upgrade_required`,
  before any void, confirmation, head/holder update or partial install. This
  allocates no new capability or provider direction; future negatives use
  unallocated Op18/Effect12/ConflictValue7/Section14.

### 3.12 Ordinary file → record promotion (Op17)

The `ordinary_file_to_record` operation is Op17, with the
same identity/path/doc/prior field placement as Op16. It is an explicit trusted
setup/capture transition, not a new File kind, view resource, capability name,
or automatic conversion of an ordinary record API request.

```cddl
ordinary-file-to-record-v1 = {
  0: 17,
  1: uuid,         ; existing file ID, kept unchanged
  2: path,         ; exact current path, kept unchanged
  3: text,         ; complete exact UTF8 record source (doc)
  4: file-content, ; full expected Ordinary content (prior), mandatory CAS
}
```

`prior` is the existing closed `FileContent` union (legacy BlobRef map or
AttachmentContentV1 tuple), not just a plaintext revision. There is no unindexed
Markdown envelope: the current holder MUST be a live `Ordinary` File, not a
record, tombstone, absent holder, or `UnindexedOversizedMarkdown` File. Op16
remains the transition for that latter kind. Existing type/path/role/grant and
setup authority checks still apply; possession of a descriptor grants nothing.

At current Source/Head planning and apply, require the same ID, exact path, Ordinary kind, and FULL
current descriptor. A content change, move, holder change, or same-hash reseal/
rekey refuses the WHOLE transition. `SHA-256(UTF8(doc)) == prior.plain_hash()`
and the exact byte length equals `prior.size()`. The Replica reconciles and
verifies source/descriptor binding under the selected content profile and
rechecks the holder, descriptor, captured catalogue and authority across awaits;
metadata equality in Core is not an authentication or provider proof.

The path must be a record path in the prospective setup catalogue, never a
resource/excluded path. Synced full-source bytes MUST be <=1,048,576 and pass the
existing bounded planned-source admission (§5.1); exactly 1MiB is a candidate.
YAML document paths such as `.base` require bounded YAML mapping admission.
Use the exact supplied source for the record: no re-serialization, normalisation,
create-time lifecycle rewrites, generated ID, or changes to tombstones. The
holder/index transition is atomic, never RemoveFile + CreateRecord prefixes.

Setup assessment lists the affected files and binds their expected prior
content. Apply installs configuration, packs and admitted promotions together.
A source that fails UTF8/YAML/size/structural admission remains an ordinary file
with a typed, file-specific receipt diagnostic; it does not abort the other
admitted setup work. A stale CAS is instead an apply refusal, never relabelled as
a parse diagnostic or successful promotion. If a provider cannot use one setup
transaction, it must report explicit per-file outcomes. Removing the extension
does not implicitly reverse the transition.

**Lost-tail resurrection exception.** Op17 is NOT
replayed at `Stage::Resurrect`. It produces no effects and a typed diagnostic,
preserving the current holder, bytes and history unchanged. Do not reject the
recovery batch for Op17's stale CAS, silently overwrite the current holder, or
replay its original Effect11/PutRecord. Setup may be re-applied idempotently with
fresh assessment/current content after recovery. Source/Head CAS remains strict.
The verified recovery stage is host-internal, never a client-selected bypass.

This allocates a critical operation in the extended runtime format, not in the
unchanged legacy Op decoder. Unknown child operations reject the entire mixed
mutation; no parser retry, ignored child, or legacy fallback. Providers implement
the closed codec and verified mediation before emitting/activating Op17. The
wire allocation alone enables no runtime, grant, or provider.

## 4. Generated values: nothing reads a clock or a random source during planning

### 4.1 The captured clock

```cddl
op-clock = {
  0: time-ms,          ; instant: the captured instant
  1: tstr,             ; tz: the IANA time zone used for calendar dates
  2: tstr,             ; local_date: the calendar date of `instant` in `tz`, "YYYY-MM-DD"
}
```

- **`instant`.** Captured once, at submit, by the origin from its injected clock with
  the monotonic clamp (`00-overview.md` §7). Lifecycle `{now: true}` and CEL `now()`
  in lifecycle guards read it.
- **`tz`.** Resolved at submit with the spec's precedence:
  1. the invocation's time zone, which the client API carries per request;
  2. `settings.timezone`;
  3. the runtime default.

  An invalid supplied zone is `invalid_request` (spec 11 `invalid_timezone`).
- **`local_date`.** Computed by the origin from `instant` and `tz`. Lifecycle
  `{today: true}` and CEL `today()` in lifecycle guards read it. **Replay never
  converts time zones for `today`**, so it needs no time-zone database, and an origin
  with a different tzdb release cannot cause a mismatch.
- Other time-zone conversions in replayed expressions, for example a lifecycle guard
  that converts a timestamp field to a date, do need tzdb. They use the release
  pinned by the semantics version (`open-questions.md` Q6).

### 4.2 Re-planning keeps the captured values

A rebase or a lost append race re-plans the mutation unchanged: same `instant`,
`local_date` and `seed`. The confirmed result can therefore differ from the optimistic
one only through other writers' changes, never through time passing or new random
draws.

### 4.3 The seed and the generated-value stream

`seed` is 32 bytes from the CSPRNG (the injected entropy interface), drawn once at
capture. Every value that planning generates (lifecycle `{uuid: true}`,
`{ulid: true}`, and any ID the planner must mint) is taken, in planner evaluation
order, from the stream:

```text
block(i) = MAC(seed, "mdbase/v1/gen", u32be(i))      for i = 0, 1, 2, ...
stream   = block(0) ‖ block(1) ‖ ...
```

- `uuid`: take 16 bytes, set the version nibble to 4 and the variant bits to `10`.
  Lower-case canonical text (spec 09).
- `ulid`: 48-bit `instant` followed by 80 bits (10 bytes) from the stream. Upper-case
  Crockford Base32 (spec 09).

The evaluation order is part of the semantics version. It is: types in the order the
planner matches them, then actions in list order, then `set` keys in mapping order.

The seed is not a cryptographic key or nonce. It only makes generated identifiers
reproducible. Their uniqueness rests on the 256-bit CSPRNG seed. This is not the
prototype's seeded-nonce bug: nonces never come from here (`sealed-envelope.md` §3).

## 5. Opt-in CAS

`if_revision` (on `update`, `document`, `delete`, `rename`), `base_revision` and
`must_not_exist` on resources, and `base` on files are the only compare-and-swap forms.

- **Revision.** The SHA-256 of the record's exact bytes (spec 12 `revision`).
- **Checked at head.** A mismatch rejects the mutation with `conflict`, reason
  `revision`, before anything is appended (first valid wins).
- **Optimistic check too.** The origin checks it against its local view at submit as
  well. A mismatch there is reported immediately.
- **Never on a caller's behalf.** Replicas and SDKs MUST NOT fill in `if_revision`
  (spec 12).

### 5.1 Trusted admission for new synced record writes

New synced record writes have a hard **1 MiB full UTF-8 source** limit (1,048,576
bytes), including frontmatter, on desktop as well as constrained replicas. A typed
`record_too_large` error directs the user to store large content as an attachment;
there is no truncation, record-path reclassification or unmanaged vault fallback.
Replica selects `RecordWriteAdmission::Synced` versus `LocalOnly` from trusted
collection state, not query profile or a user wire option. Check direct document
input before parsing and complete planned PutRecord sources before any effect
application/publication, including generated/lifecycle/backlink results. This is
**new write admission**, not a Stage::Head semantic change: verified historical
replay and acknowledged recovery retain their prior rules. Local-only large files
remain readable. Hosted batch source/effect and ABI limits remain separate.

## 6. Validation tiers

Where each check of spec 04 runs. "Submit" is the origin's optimistic plan against
its local view. "Head" is the writer's plan at the exact log head. Only head is
authoritative for S-class checks.

| Check (spec 04 tier) | At submit (`api`) | At head (`api`) | `external` |
|---|---|---|---|
| Malformed request, mutually exclusive fields, bad offsets (request) | reject `invalid_request` | — (cannot change) | malformed external ops are an ingest bug: never planned |
| Path escapes, unsafe paths (request) | reject `invalid_request` | — | never planned |
| Explicit `path_conflict`, rename `from` mismatch, file path taken (request, **S**) | reject if visible locally | **reject** `conflict` (authoritative) | suffix rule, never rejected |
| `type_conflict`, `type_membership_changed`, lifecycle failure, expression errors (request) | reject | **reject** (state may differ at head) | not run (no lifecycle) |
| `if_revision`, resource `base_revision` (request, **S**) | reject if mismatched locally | **reject** `conflict` reason `revision` | — |
| `unique.enforce: write` (request, **S**) | reject if visible locally | **reject** `conflict` reason `duplicate_value` | never rejected; reported |
| Config / type-file validity of a resource write (request) | reject `invalid_record` | **reject** | resources edited on disk are ingested and reported (collection invalid) |
| Single-record schema, `format_invalid` (single-record) | level `error`: reject `invalid_record`; `warn`: report | **never rejects**; reported on read | reported |
| Cross-record checks (cross-record) | reported | reported | reported |

Two consequences:

- **Single-record validity is decided once, at submit.** A write that was valid there
  and becomes invalid at head because of a concurrent change (for example, two
  individually valid edits violate an `if`/`then` schema) is applied and reported. It
  is not rejected after the fact. That is SC0: merge results are reported, not
  rejected. It also keeps the planner at head independent of the submitter's
  validation level, so verifiers do not need that level.
- **S-class rejections happen only at the writer.** A pending mutation accepted
  optimistically can still be rejected at head. The client sees its receipt move from
  `pending` to `rejected` (`replica-client-api.md` §6). Rejected mutations never enter
  the log (`log-entry.md` §3).

## 7. Room checkpoints

```cddl
room-checkpoint = {
  0: bstr .size 16,    ; stream: the ephemeral stream ID of the room (log-service-api.md §8)
  1: hash,             ; state: digest of the room state the checkpoint captures (profile-defined)
}
```

A live room (future, ADR 0014) writes its body back as an **ordinary** `update`:
- `body_edits` against `body_base`, with `source = api`;
- `room` set;
- issued by one participant after an idle period and when the room closes.

Conditional append's first-valid-wins settles concurrent checkpoints. A second
checkpoint of the same text merges as "both sides made the same change" (spec 12A rule
1) and records nothing new. A participant SHOULD skip its checkpoint when it has
applied a checkpoint for the same `stream` whose `state` covers its own.

`room` is informational for replicas: it never changes planning. Yjs stays an
implementation profile (`markdown-body-yjs-v13`) and never appears in the log.

## 8. Batches

`ops` holds 1 to 1,000 operations, planned in order against the state left by the
previous ones, and applied atomically.

- **Atomic.** If any operation is rejected (at submit or at head), the whole mutation
  is rejected and nothing is applied. This is the spec 12 batch with
  `allow_partial: false`.
- **No repeated paths.** A batch that names one record path or ID more than once
  (through `path`, `from`, `to` or `id`) is `invalid_request` (spec 12
  `duplicate_batch_path`), so its items never depend on each other.
- **Partial batches.** `allow_partial: true` in the client API is not a mutation
  property. The replica splits the request into one mutation per item. The client
  supplies one mutation ID per item, so a retried partial batch stays idempotent; when
  it does not, the replica mints them.
- **Dry runs** plan at the local view and are never captured as mutations.

## 9. Spec operation mapping

| Spec 12 operation | Mutation |
|---|---|
| `create` | `create` |
| `update` with `patch`/`unset`/`add`/`remove`/`body`/`body_edits` | `update` |
| `update` with `document` | `document` (`source = api`) |
| `delete` | `delete` (`base_revision` = the revision the caller read, when it has one) |
| `rename` | `rename` |
| `batch` | one mutation with several `ops`, or one per item when partial |
| `create_view_source`, `update_view_source`, `delete_view_source` | `create`/`document`/`delete` for view records; `file_put`/`file_delete` for adapter-format files |
| type and config writes (`create_type`, `update_type`, type packs) | `resource_put` / `resource_delete`, several in one mutation for a pack |
| file add, replace, delete, move | `file_put`, `file_delete`, `file_move` (with `update_refs`) |
| file sync selection (inclusion) | `sync_settings` |
