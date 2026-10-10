# Snapshot: chunks, manifest, side tables, install and join

Status: draft for review, 2026-10-04.

A snapshot is the confirmed state of a collection at one log position, stored as
sealed, content-addressed objects in the log service's object store. Snapshots exist
for four things:
- **bootstrapping** a new replica;
- **catching up** a replica that fell behind retention;
- **compaction**, which bounds how much log is kept;
- **adoption**, where an existing folder or hosted collection becomes the collection's
  generation-0 state.

The prototype's single 95 MB JSON blob at 100k records (FEASIBILITY §2.10) is replaced
by **bucketed chunks behind a signed manifest**. They can be streamed, fetched on
demand, reused across snapshots, and matched against existing files without
downloading them.

## 1. Structure

```text
put_snapshot(seq, manifest address, refs)          ← pointer registered with the log service
    └─ manifest object (kind manifest, sealed, signed)
         ├─ section: resources   → chunk objects
         ├─ section: index       → one chunk per bucket   (id, kind, path, revision, size, modified_seq)
         ├─ section: records     → one chunk per bucket   (id, path, document or blob-ref)
         ├─ section: files       → one chunk per bucket   (id, path, blob-ref)
         ├─ section: tombstones  → chunks
         ├─ section: aliases     → chunks
         ├─ section: conflicts   → chunks
         └─ section: receipts    → chunks
```

All objects use the envelope and sealing of `sealed-envelope.md`:
- chunks are `chunk` objects;
- the manifest is a `manifest` object, signed by the device that built it;
- large documents and file contents are blobs, referenced by `blob-ref`. They are
  usually the very blobs their entries already uploaded.

## 2. Manifest

```cddl
; ---- snapshot manifest (snapshot.md §2) ----
manifest-payload = {
  0: 1 / 2,                ; fmt: 2 exactly when key 12 is present (§2.1)
  1: seq,                  ; seq: the state after applying every item ≤ seq (0 for a base, §7)
  2: hash,                 ; chain: chain(seq) (32 zero bytes for a base)
  3: hash,                 ; state_digest (§4)
  4: uint,                 ; bucket_bits: 0..16; bucketed sections have 2^bucket_bits buckets
  5: [+ section],          ; sections, in section-kind order
  6: horizon,              ; the receipts and tombstone horizon this snapshot applied (§6)
  7: sem,                  ; the builder's semantics version (informational)
  8: uint,                  ; record_count
  9: uint,                  ; file_count
  ? 10: hash,              ; previous: address of the manifest this one was built from
  11: hash,                ; control_chain: ctl(seq), the control-item accumulator (§8.1)
  ? 12: [+ hash],          ; ref_indices: the ref-index objects among the envelope refs (fmt 2 only)
}

section = {
  0: section-kind,
  1: [* chunk-ref],        ; one per bucket for bucketed sections, in bucket order
}
section-kind = &( resources: 1, index: 2, records: 3, files: 4,
                  tombstones: 5, aliases: 6, conflicts: 7, receipts: 8, settings: 9,
                  attachment-files: 10, attachment-tombstones: 11,
                  unindexed-markdown-files: 12, unindexed-markdown-tombstones: 13 )
attachment-section-kind-v1 = &( attachment-files: 10, attachment-tombstones: 11 )
attachment-section-v1 = { 0: attachment-section-kind-v1, 1: [* chunk-ref] }
unindexed-markdown-section-kind-v1 = &( unindexed-markdown-files: 12, unindexed-markdown-tombstones: 13 )
unindexed-markdown-section-v1 = { 0: unindexed-markdown-section-kind-v1, 1: [* chunk-ref] }

chunk-ref = {
  0: hash,                 ; address: SHA-256 of the sealed chunk object
  1: hash,                 ; plain_hash: H over the chunk payload's canonical bytes (plain SHA-256)
  2: uint,                 ; rows
  3: uint,                 ; bucket (bucketed sections) or ordinal
  4: uint,                 ; plain_size: canonical payload bytes before compression
}

horizon = {
  0: seq,                  ; seq_floor: rows older than this position were pruned...
  1: time-ms,              ; time_floor: ...and older than this log time (§6)
}
```

- **Bucketed sections:** `index`, `records`, `files`. A record or file with ID `x`
  belongs to bucket `first bucket_bits bits of SHA-256(x)` (a plain digest of the 16
  ID bytes). UUIDv7 IDs are time-ordered, so hashing is what spreads them evenly.
- **Bucket count.** The builder picks `bucket_bits` so that a records chunk is about
  512 KiB of plaintext: `bucket_bits = 8` at 100k records of about 1 KB each. It
  changes `bucket_bits` only when chunks drift outside 128 KiB–2 MiB, because a change
  rewrites every bucketed chunk.
- **Unbucketed sections** are split into chunks of at most 4 MiB of plaintext, in key
  order.
- **The manifest is sealed and signed** (`sealed-envelope.md` §2, kind `manifest`).
  Its `refs` list every chunk address and every blob address the state references, so
  the log service can collect garbage without reading it (`log-service-api.md` §6.2).

### 2.1 Ref-index objects

The manifest's envelope `refs` and the `put_snapshot` refs must fit one log-service
request (4,096 CBOR values). A builder whose complete refs inventory (chunks, blob
parts, attachment manifests and chunks, §3) would not fit lists it in `ref-index`
objects (`sealed-envelope.md` §4.3) and names only those:
- every inventory address is listed by exactly the indices, split into as few
  objects as possible (at most 32 of 8,192 addresses);
- the envelope `refs` and `put_snapshot` refs are the index addresses;
- the manifest is encoded with `fmt = 2` and lists them, sorted, in key 12.

A small inventory keeps `fmt = 1`, no key 12 and the direct refs, byte for byte as
before. A larger one than 262,144 addresses is refused, typed, and never truncated.

**Install.** The complete refs set of a fmt-2 manifest is its envelope refs minus
`ref_indices`, plus every address the indices list. The installer fetches each index,
checks that it hashes to its address and is well formed, and refuses the install
otherwise. `ref_indices` must be a subset of the envelope refs.

**Older peers.** A decoder that predates fmt 2 refuses the manifest as an unknown
format: the install stalls with `UpgradeRequired` before any row is installed, and
the snapshot is not endorsed. An older log service refuses kind 19 at `put_object`
(`invalid`), so the build fails and nothing is registered.

## 3. Chunks and side tables

```cddl
; ---- snapshot chunks (snapshot.md §3) ----
chunk-payload = {
  0: 1,                    ; fmt
  1: section-kind,
  2: uint,                 ; bucket or ordinal
  3: [* snapshot-row],     ; rows, sorted by the section's key
}

snapshot-row = resource-row / index-row / record-row / file-row
             / tombstone-row / alias-row / conflict-row / receipt-row / settings-row
             / attachment-file-row-v1 / attachment-tombstone-row-v1
             / unindexed-markdown-file-row-v1 / unindexed-markdown-tombstone-row-v1

snapshot-text = tstr / blob-ref

resource-row  = [path, snapshot-text]                         ; key: path (bytewise)
index-row     = {                                              ; key: id
  0: uuid,                 ; id
  1: &( record: 0, file: 1 ),
  2: path,
  3: hash,                 ; revision: SHA-256 of the exact bytes
  4: uint,                 ; size in bytes
  5: seq,                  ; modified_seq: position of the last change (0 = adopted, unchanged)
}
record-row    = [uuid, path, snapshot-text]                   ; key: id
file-row      = [uuid, path, blob-ref, media-class]           ; key: id. The file manifest: ID, path, size, digest
                                                              ;   (= revision) and keyed blob ID, all in blob-ref
tombstone-row = [uuid, &( record: 0, file: 1 ), path, snapshot-text, seq, time-ms]
                                                              ; id, kind, last path, last document or file blob-ref,
                                                              ;   deleted at, deleted when; key: id
attachment-file-row-v1 = [uuid, path, attachment-content-v1, media-class]
attachment-tombstone-row-v1 = [uuid, 1, path, attachment-content-v1, seq, time-ms]
unindexed-markdown-file-row-v1 = [uuid, path, unindexed-markdown-payload-v1, media-class]
unindexed-markdown-tombstone-row-v1 = [uuid, 1, path, unindexed-markdown-payload-v1, seq, time-ms]
; Native TombstoneLast Doc0/Blob1/Attachment2 unchanged; new typed FilePayload arm:
native-unindexed-markdown-tombstone-last-v1 = [3, unindexed-markdown-payload-v1]
settings-row  = file-inclusion                                ; exactly one row (intent.md §3.7)
alias-row     = [path, uuid]                                  ; key: path (bytewise)
conflict-row  = [uuid, seq, conflict]                         ; mutation, position, the conflict (log-entry.md §2.4); key: (mutation, record)
receipt-row   = [uuid, seq, time-ms]                          ; mutation ID, position, its clock instant; key: mutation ID
```

**Critical attachment sections10/11.** Section10 holds only
`attachment-file-row-v1`; section11 holds only `attachment-tombstone-row-v1`.
Keys/buckets are file ID, as for the legacy sections. Legacy Files4/Tombstones5
row schemas are unchanged. The index's File kind1 and `file_count` cover both
content profiles; IDs are disjoint across live sections4/10 and retained file
sections5/11, and replacement never leaves two live rows for one ID.
Manifest fmt1 and sealed object kinds16/17 remain unchanged.

**Critical unindexed Markdown sections12/13.** Section12 accepts ONLY typed live
unindexed rows; section13 ONLY typed File1 tombstones. Existing sections4/5/10/11
and their row encodings are unchanged. IDs are disjoint across ALL live kind
sections and ALL tombstone sections; the index reports File1/file_count, never a
Record/indexed projection because its extension is `.md`. ConflictValue6 retains
the separate closed kind/content payload. Unknown profile/kind/row/critical
section requires whole-parent rejection before partial install. Installation
validates captured path/size/kind/verified plaintext invariants and commits both
directions' holder/index transition atomically; currentness/descriptor fences
and complete Blob or authenticated manifest+all-chunk root inventory are
mandatory. Neither tuples nor declared size prove authentication or permit
omitting roots. Cumulative work/resident/indexed byte limits gain no exemption.

Standalone codecs for these sections do not activate install. Legacy runtime
section unions must whole-snapshot upgrade/stall reject unknown10/11 **before**
partial installation, not decode a new content tuple as a legacy BlobRef or skip it.
Snapshot `refs` includes every complete sealed manifest/chunk Item hash referenced
by live files, retained file tombstones and conflict-held content. Verify the
expanded union from authenticated manifests; inventory/admission failure retains
prior roots and blocks compaction, never truncates the inventory. Existing object,
aggregate refs, source/apply and decoder limits remain separate. Creation grace is
not an active-transfer lease or resume guarantee (`intent.md` §3.9).

**What travels with a snapshot, and why.** Everything planning or idempotency can read
at the snapshot's position, which is exactly what the prototype learned it was missing
(FEASIBILITY §2.2, cursor expiry):

| Side table | Why it must travel |
|---|---|
| **resources** | the catalog: types, config, contracts. Needed before anything else can be interpreted. |
| **index** | lets a replica list paths, plan creates (path collisions) and match local files before any content arrives |
| **records** | the content |
| **files** (the file manifest) | ID, path, size, content digest (= revision), keyed blob ID, media class. File bytes are never inlined: rows reference blobs, so a snapshot of a collection with many gigabytes of media is still small |
| **settings** | the file inclusion policy, which every replica must apply identically when ingesting |
| **tombstones** | D8 resurrection: a late update to a deleted record re-plans identically only if the tombstone is there. Without them, verification mismatched in the prototype. File tombstones keep the deleted file's `blob-ref`, so its blob stays live until the horizon (§6). |
| **aliases** | link resolution for renamed paths (D9) |
| **conflicts** | the unresolved-conflicts list. It is derived from entries, so without this table it would vanish at compaction. |
| **receipts** | a replica that installs the snapshot drops pending mutations already appended, instead of appending them twice (FEASIBILITY §2.2 bug 2) |

**What does not travel:**
- **Holds.** A hold is one device's local fact: its file holds the user's bytes. Other
  replicas have nothing to hold. The conflict that caused a hold travels in the
  conflicts table.
- **Pending queues and receipts of rejected mutations.** Replica-local.
- **Disk state and derived query indexes.** Store-local and rebuildable (Store,
  IndexStorage: pending S4).
- **Policy and keys.** Control items are never compacted. A replica reads them from
  the log itself (§5).

### 3.1 Explicit internal attachment runtime v1 decoding

The separate `attachment_runtime_v1` manifest/chunk codecs keep the exact fmt1
metadata/header fields. Section kinds delegate legacy1..9 or explicitly decode
attachment10/11 or unindexed Markdown12/13. Default legacy parent and section
decoders remain unchanged.
The runtime chunk decoder validates **every** row against its declared section
before returning a parent: attachments cannot hide in legacy files4/tombstones5,
and conflict7 uses the runtime conflict value union. Unknown future kind/profile
fails the whole parent; malformed rows are schema errors, never skipped. These
codecs do not enable install, inventory/compaction, provider support or Hello.

```cddl
attachment-runtime-v1-manifest-payload = manifest-payload
attachment-runtime-v1-chunk-payload =
    { 0: 1, 1: 1, 2: uint, 3: [* resource-row] }
  / { 0: 1, 1: 2, 2: uint, 3: [* index-row] }
  / { 0: 1, 1: 3, 2: uint, 3: [* record-row] }
  / { 0: 1, 1: 4, 2: uint, 3: [* file-row] }
  / { 0: 1, 1: 5, 2: uint, 3: [* tombstone-row] }
  / { 0: 1, 1: 6, 2: uint, 3: [* alias-row] }
  / { 0: 1, 1: 7, 2: uint, 3: [* conflict-row] }
  / { 0: 1, 1: 8, 2: uint, 3: [* receipt-row] }
  / { 0: 1, 1: 9, 2: uint, 3: [* settings-row] }
  / { 0: 1, 1: 10, 2: uint, 3: [* attachment-file-row-v1] }
  / { 0: 1, 1: 11, 2: uint, 3: [* attachment-tombstone-row-v1] }
  / { 0: 1, 1: 12, 2: uint, 3: [* unindexed-markdown-file-row-v1] }
  / { 0: 1, 1: 13, 2: uint, 3: [* unindexed-markdown-tombstone-row-v1] }
```

## 4. State digest

Every replica can compute a digest of its confirmed state at any position. A snapshot
records the builder's:

```text
state_digest = H("mdbase/v1/state-digest", canonical([
    [resources:  [[path, revision] …]],                 sorted by path
    [records:    [[id, path, revision] …]],              sorted by id
    [files:      [[id, path, plain_hash] …]],            sorted by id
    [tombstones: [[id, kind, path, revision, seq] …]],   sorted by id
    [settings:   file-inclusion],
    [aliases:    [[path, id] …]],                        sorted by path
    [conflicts:  [[mutation, record, kind] …]],          sorted by (mutation, record)
]))
```

For snapshots with no authoritative unindexed Markdown live rows, retained native
tombstones or ConflictValue6 sides, these seven components remain BYTE-IDENTICAL.
For native state ONLY, append an eighth component:

```text
[native_live_rows, native_tombstone_rows, native_conflict_rows]
```

`native_live_rows` are the COMPLETE canonical section12 rows sorted by ID;
`native_tombstone_rows` are COMPLETE canonical section13 rows sorted by ID.
`native_conflict_rows` are complete runtime conflict rows containing at least one
CV6 side (kept/lost/base), sorted by `(mutation, record, kind)`. They bind position,
all side payloads and their placement, not merely a native plaintext hash. Include
all three arrays, even empty ones, whenever the extra component is present; omit
the extra component entirely when all three arrays are empty. The native typed
payload includes exact kind/profile/complete FileContent descriptor, including
Blob epoch/keyed-ID/part shape or Attachment context/manifest/whole hash/count.
A same-hash epoch/reseal change therefore CHANGES a native digest. Device-local
byte-proof caches and inventory metadata are not included.

The original seven components cover state, not encodings: Ordinary Blob addresses
and text forms differ between builders, so they remain left out. Receipts are left
out too: they are idempotency bookkeeping, not state. Native descriptor identity
is intentionally an exception because its authoritative kind and full CAS cannot
be replaced by plaintext-hash equality.

Executable ordinary/native goldens are pinned in
`crates/replica/src/replica/snapshot/native_digest_tests.rs`:
- Ordinary-only File fixture: `ca00a5b12dd0bd1fd28826747e30e7b2acd9032ac16f17cdceadb3e84f32fb1f`.
- Native live/tomb/CV6 fixture: `ecc85f0f1c336d1180147a7bcdaee46a34fbf1df6d57fce407a4b4a20ff27707`.
Both use synthetic descriptors; the first additionally compares the exact original
seven-component canonical preimage, not just its digest. The native test binds
same-hash epoch/reseal, tombstone time and conflict position changes, and the
staged install index agrees with the confirmed-store computation.

The digest is what makes a snapshot checkable:
- an installing replica compares it with the digest it computes after install;
- a replica that has applied through `seq` compares it with its own (§5.2,
  endorsement).

## 5. Compaction, retention and endorsement

### 5.1 What the log service keeps

- **Control items** (`policy`, `rekey`, `key_grant`, `base`, `grant_approval`): kept for the life of
  the collection. They are small and rare. Every replica needs all of them to evaluate
  authorization and to obtain keys, and a bootstrapping replica reads them from the
  start of the log.
- **`entry` items** with `seq > C`, where `C` is the **compaction point**:

  ```text
  C = min( S_e − 10,000,  last position appended more than 7 days ago )
  ```

  `S_e` is the latest *endorsed* snapshot (§5.2). The grace region lets a replica
  that is slightly behind catch up from the log instead of reinstalling.
- **The two latest snapshots** and the objects they reference, plus every object
  referenced by a retained item.

So the retained tail is bounded: entries since the latest endorsed snapshot, plus the
grace region.

### 5.2 Endorsement

The log service cannot check a snapshot it cannot read, and compacting on the strength
of a bogus snapshot would lose data. So a snapshot only becomes a compaction point
once it is **endorsed**.

A replica endorses a snapshot when it has itself applied the log through `seq`, its
own state digest and `ctl(seq)` equal the manifest's, and the manifest's signature and
chain check out. It also fetches every chunk the manifest references that the previous
endorsed manifest did not. It checks that each one opens, matches its `plain_hash`, and
holds rows equal to its own state. A digest alone does not prove that the chunks are
installable. It then calls `endorse_snapshot` (`log-service-api.md` §7). The
endorsement must come from a **device other than the builder**.

A collection with a single keyed device can never get one. Its latest snapshot older
than 30 days counts as endorsed instead.

A replica whose digest differs reports an incident and does not endorse. The hosted
replica endorses routinely.

### 5.3 When snapshots are written

Any keyed replica may build one when all of these hold:
- at least 10,000 entries or 64 MiB of items have been appended since the latest
  snapshot;
- at least one hour has passed since the latest snapshot;
- a random delay of up to ten minutes has passed, so replicas rarely build at the same
  moment.

The hosted replica, where present, uses no delay and so usually builds first. The log
service accepts the first `put_snapshot` for a newer position and refuses older ones.
A replica that loses wastes one build.

**Incremental build.**
- A bucket whose rows are unchanged since the previous manifest has the same
  `plain_hash`, so its `chunk-ref` (address included) is reused without re-upload.
- At 100k records with a few hundred records changed, a new snapshot uploads a few
  hundred KiB of chunks plus the index buckets that changed.
- Reused chunks may be sealed under an older epoch. That is fine: their plaintext was
  readable to whoever held that epoch, and a revoked device learns nothing new from
  them. Re-seal (`sealed-envelope.md` §7.3) rewrites them when wanted.

## 6. The receipts and tombstone horizon

Receipts and tombstones are pruned **deterministically, as part of applying the log**,
so every replica at the same position has the same rows and plans the same way.

```text
log_time(p)  = max(log_time(p − 1), clock.instant of the entry at p)     (entries only; log_time(0) = 0)

a receipt or tombstone created at position q with instant t is pruned at p when
    p − q > 10,000   AND   log_time(p) − t > 180 days
```

**Why both conditions.**
- **Count alone** would expire receipts in a busy collection within hours, while
  devices can be offline for weeks.
- **Time alone** would let one device with a clock set years ahead prune everything
  with a single entry. Requiring 10,000 entries as well bounds that damage.

The two values together are the **receipts horizon**. The log service keeps
idempotency tokens for at least 180 days (`log-entry.md` §7). A manifest records the
horizon it applied.

**Blob retention follows the horizon.** A snapshot's `refs` include every blob that
its rows reference:
- live files;
- blob-backed texts;
- file tombstones;
- the `lost` and `kept` blobs of unresolved conflicts.

The log service keeps an object while a retained item or snapshot references it
(`log-service-api.md` §6.2). The blob of a deleted or replaced file therefore stays
fetchable until:
- its tombstone, and any conflict that holds it, are pruned at the horizon; and
- the entries that referenced it fall below the compaction point.

Every replica that is within the horizon has by then applied the delete. A replica
beyond it reinstalls from a snapshot, where the file no longer exists. Any local copy
it still has is held, never deleted (§9). Blob deletion is thus coordinated through
the same deterministic horizon as receipts, with no per-replica tracking at the
service.

**Consequences:**
- **A replica that was offline longer than the horizon** may have pending mutations
  whose fate it cannot learn.
  - If it never sent them, it simply appends them.
  - If it sent them and lost the acknowledgement, the service's token index answers
    `duplicate` for at least 180 days.
  - Beyond that the outcome is unknown: external edits re-ingest harmlessly, and `api`
    mutations resolve as `outcome_unknown` (`log-entry.md` §7).
- **A late update to a record whose tombstone was pruned:**
  - an `api` update gets `not_found`;
  - an `external` document change becomes a creation under the same ID, so the user's
    bytes are kept (`intent.md` §3.3).

## 7. Adoption: the `base` item and generation 0

When sync is turned on for an existing folder (or a hosted collection is migrated), its
current files become the collection's starting state **without one entry per file and
without rewriting any file** (FEASIBILITY §2.7):

1. The adopting replica builds a snapshot of the folder with `seq = 0` and
   `chain = 0…0`, uploads its chunks and manifest, and appends a `base` item.
2. The state after the `base` item is the manifest's state.

```cddl
; ---- base item (snapshot.md §7) ----
base-payload = {
  0: 1,                    ; fmt
  1: hash,                 ; manifest: address of the generation-0 manifest (also in refs)
  2: hash,                 ; state_digest of that manifest
  3: uuid,                 ; adopter: replica ID that adopted
  4: &( folder: 0, hosted-import: 1 ),
  ? 5: uuid,               ; legacy_collection: the Connect collection imported (migration)
  ? 6: [1*64 blob-ref],   ; prehistory: ordered sealed segments of the legacy version-history archive (migration; interfaces entry 2026-10-06-migration-prehistory-archive.md)
}
```

The pre-history segments (field 6; absent = none) are ordinary sealed blobs that the
replica never reads: they are opaque to replay, apply, policy and indexing, and every
segment's part addresses are listed in the item's `refs`, so the service retains them
like the manifest.

**Validity** of a `base` at `p`:
- the signer is a keyed device;
- **no `entry` or `base` item precedes it** (a log may hold rekey and policy items
  before it);
- the manifest is in `refs`.

At import and install time the replica also checks the pre-history field (field 6)
and refuses the base otherwise: `refs` holds every part address of every segment,
and there are at most 64 segments.

**Concurrent adoption resolves itself.** Two devices that turn sync on for copies of
the same folder race to append `base`, and the first valid one wins. The loser's
`base` would be void, so its writer, which plans at head, sees the winner's and
**joins** instead (§9).

A collection created empty (on the web, or a new folder) has no `base`. Its initial
state is empty, and its first entries create records.

Connect's existing record IDs are kept at adoption. The hosted import
uses them as record IDs, and the local takeover reads them from the old index, so
links by ID and apps' cached IDs stay valid.

## 8. Progressive install

A replica that bootstraps, or falls behind the compaction point, proceeds in this
order. Each step streams chunks one at a time; memory stays bounded by one chunk plus
the index.

1. **Control items.** Read the control items from position 1 (`read` with
   `kinds = control`, `log-service-api.md` §5). They give the policy state and the
   keyring:
   - this device's `key_grant` or `rekey` wrap;
   - then every older epoch, through the key history.
2. **The pointer.** `get_snapshot`, then fetch and open the manifest. Check:
   - the signature, and that the signer was keyed and not revoked at `seq`, using the
     policy from step 1;
   - that `chain` equals the `prev` of the item at `seq + 1`, or the head's chain hash
     if no item follows yet.

   - that `control_chain` equals the accumulator recomputed over the control items read
     in step 1 with `seq ≤` the manifest's `seq` (§8.1).

   A failed check falls back to the older retained snapshot, or reports an incident.
   An accumulator mismatch is an `integrity` incident: the service withheld or altered
   control items.
3. **Resources.** The catalog is now known.
4. **Index.** All buckets, in order. The replica can now:
   - list every path;
   - resolve path lookups and links;
   - accept local creates (path collisions are known);
   - report `installing {index_complete: true, records: n/m}`.
5. **Records and files**, by priority:
   1. the buckets touched by the replica's pending mutations;
   2. buckets a client asks for: a point read of an ID maps to exactly one bucket;
   3. the rest in bucket order.

   Records become readable bucket by bucket. Queries run over what is installed, and
   their results say `complete: false` until install ends
   (`replica-client-api.md` §4).
6. **Tombstones, aliases, conflicts, receipts.**
7. **Finish.** Compare the computed state digest with the manifest's. On a mismatch,
   discard the install and fall back as in step 2. Then drop pending mutations found in
   receipts (now confirmed), apply the tail `(seq, head]`, rebase pending work, and
   start appending.

Until step 7 finishes, the replica serves reads only and does not append: a writer must
have applied every item up to the head it plans at.

**File-platform boundary.** How a file-backed replica materializes files during step 5
(batching, publish bookkeeping; 72 s at 100k in the prototype) is a `FilePlatform` and
`IndexStorage` concern. This contract only guarantees that chunks arrive in an order
and size that allow it to stream.

### 8.1 The control-chain accumulator

A read with `kinds = control` cannot be checked against the chain, because the entries
between control items are missing. A service could omit a `device-revoke`, a
`grant-revoke` or a `rekey`, and a bootstrapping replica could not tell. So replicas keep
an accumulator over control items:

```text
ctl(0) = 32 zero bytes
ctl(p) = H("mdbase/v1/ctl-chain", ctl(p') ‖ u64be(p) ‖ chain(p))   if the item at p is a control item,
         where p' is the previous control position (0 if none)
ctl(p) = ctl(p − 1)                                               otherwise
```

- Every replica maintains it while applying, so `ctl(seq)` is known at any position it
  applied.
- The builder records `ctl(seq)` in the signed manifest. The service cannot forge it.
- A bootstrapping replica recomputes it from the control items it read. It uses each
  item's `chain(p)` (hashing the item bytes) and its `seq` from the envelope. It
  requires the result at the manifest's `seq` to match.
- Control items in the tail `(seq, head]` are covered by the ordinary chain check
  during step 7.
- Endorsers check `control_chain` against their own value too (§5.2).

Withholding from a `kinds = control` read is then detected at install, provided at
least one honest keyed device built or endorsed the snapshot.

## 9. Join from existing files

A replica that starts on a folder that already holds the collection's files (a copied
vault, a second device that had Syncthing, an old Connect mirror folder after
migration) installs the snapshot by **matching** instead of downloading and rewriting
It runs steps 1–4 of §8, then scans the folder. For each local file it
computes the path key and the SHA-256 of its bytes, and compares them with the index
and tombstones:

| Local file vs snapshot | Action | Downloads |
|---|---|---|
| Same path key, same revision | record installed **from the local bytes**; disk state recorded as published and confirmed | none |
| Same path key, different revision, record unchanged since the folder's sync point (`modified_seq ≤ sync_point`) | install the snapshot version as confirmed, then ingest the local file as an external edit on it | that record's bucket |
| Same path key, different revision, record changed since the sync point | **hold**: unknown provenance, mine = local bytes, theirs = snapshot version | that bucket |
| Same revision as a record at another path, unchanged since the sync point | a move: ingested as an external `document` with the new path | none |
| Matches a tombstone (path key and revision) | **hold**, reason "deleted elsewhere". The user chooses delete or keep. User bytes are never deleted silently. | none |
| Not in the snapshot | ingested as a creation | none |
| In the snapshot, missing locally | materialized (written to the folder). Files are materialized only if the device's materialization policy includes them, otherwise recorded as remote | that bucket, or the file's blob |

- **The sync point** is the position up to which the folder is known to match the log.
  - For a takeover of a folder this runtime already managed, it is the replica's last
    applied position.
  - For an old Connect mirror folder at migration, it is the `migration_cutover`
    position (`policy.md` §8). The old mirror's un-uploaded edits are then ingested as
    ordinary external edits on unchanged records: delayed, not lost.
  - For any other folder it is 0, so every difference on a record changed since
    adoption is held.
- **Files (binaries)** are matched the same way: path key plus the SHA-256 of the
  local bytes against the file manifest's `plain_hash`. A match installs the file
  from the local bytes, and no blob is downloaded. A file with the same digest at
  another path is a move.
  - **Excluded files.** Files outside the inclusion policy (`settings`) are ignored
    entirely: never ingested, never deleted.
  - **Remote files.** Files the device's materialization policy leaves remote are
    not "missing locally". They are recorded as remote, with no download
    (`replica-client-api.md` §10.3).
  - **Large files.** Hashing multi-gigabyte local files is the dominant cost of a
    join. The replica may first compare size and modification time against the
    manifest, and defer the hash of large files to a background pass. Until hashed, a
    file is matched provisionally and never uploaded (`open-questions.md`
    Q26).
- **Binary differences are never merged.** A local file that differs from a file
  changed since the sync point is held, and the user can keep both.
- **Content of unknown provenance is always held, never overwritten** (non-negotiable
  2). After a join, the replica appends the resulting creations, edits and moves
  through the normal append loop.
