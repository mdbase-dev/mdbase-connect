# Log entry: what is appended, and how it is applied

Status: draft for review, 2026-10-04.

The collection log is a sequence of **items** at positions 1, 2, 3, … Each item is
an envelope (`sealed-envelope.md` §2) holding:
- the **header** in clear: kind, collection, `seq`, `prev`, key epoch, writer,
  idempotency token, refs;
- the **body**: a payload, sealed or in clear depending on the kind;
- a **signature**.

| Kind | Payload | Sealed? | Signed by | Defined in |
|---|---|---|---|---|
| 1 `entry` | a mutation and its results | yes | writer device | this document |
| 2 `policy` | grants, devices, members, collection state | no | control plane | `policy.md` |
| 3 `rekey` | a new key epoch, wrapped per device | no (keys wrapped) | device | `sealed-envelope.md` §5 |
| 4 `key_grant` | existing epochs wrapped for a newly enrolled device | no (keys wrapped) | device or escrow | `sealed-envelope.md` §5 |
| 5 `base` | the adopted generation-0 snapshot | yes | device | `snapshot.md` §7 |

"Log entry" in PLAN and FEASIBILITY means an item of kind `entry`. Kinds 2–6
(`policy`, `rekey`, `key_grant`, `base`, `grant_approval`) are **control items**. They are never compacted (`snapshot.md` §5).

## 1. Contents of an entry

An entry is the envelope header plus the sealed payload:

| Part | Where | Notes |
|---|---|---|
| position `seq`, chain link `prev` | header | bound into the AEAD and the signature |
| collection, key epoch | header | |
| writer identity (device ID) | header | the signing identity; checked against policy |
| idempotency token | header | MAC of the mutation ID (§7) |
| object refs | header | blobs and large texts this entry references |
| signature | envelope | Ed25519 over the header and ciphertext (`sealed-envelope.md` §6) |
| format version, semantics version | payload | |
| the mutation (intent, mutation ID, origin, clock, seed) | payload | `intent.md` |
| the result: status, effects, conflicts, aliases | payload | planned by the writer at this exact position |
| text table | payload | delta- and blob-encoded texts (§2.2) |

## 2. Entry payload

```cddl
; ---- entry payload (log-entry.md §2) ----
entry-payload = {
  0: 1,                  ; fmt
  1: sem,                ; semantics version the writer planned under
  2: mutation,           ; the intent (intent.md §1)
  3: status,
  4: [* effect],         ; effects, applied in order
  ? 5: [+ conflict],     ; conflicts (present iff status = conflicted)
  ? 6: [+ alias],        ; aliases created by this entry
  ? 7: [+ text-def],     ; text table
  ? 8: seq,              ; resurrect: the position this mutation was confirmed at before a lost tail (§3.3)
}

status = &(
  applied: 0,        ; applied as asked
  merged: 1,         ; applied with an automatic merge against a concurrent change (C+)
  conflicted: 2,     ; partly applied; a concurrent change kept some values (K)
)
```

There is no `rejected` status. A rejected mutation never enters the log (§3).

### 2.1 Effects

```cddl
; ---- effects (log-entry.md §2.1) ----
effect = put-record / remove-record / put-file / remove-file / put-resource / remove-resource
       / put-settings / put-attachment-file-v1
       / put-unindexed-markdown-v1 / reindex-unindexed-markdown-v1
       / reindex-ordinary-file-v1

put-record      = { 0: 1, 1: uuid, 2: path, 3: text }      ; id, path, doc: exact bytes
remove-record   = { 0: 2, 1: uuid, 2: path }               ; id, path it had
put-file        = { 0: 3, 1: uuid, 2: path, 3: blob-ref }  ; id, path, content
remove-file     = { 0: 4, 1: uuid, 2: path }
put-resource    = { 0: 5, 1: path, 2: text }               ; path, doc
remove-resource = { 0: 6, 1: path }
put-settings    = { 0: 7, 1: file-inclusion }                ; the collection's file inclusion policy (intent.md §3.7)
put-attachment-file-v1 = { 0: 8, 1: uuid, 2: path, 3: attachment-content-v1 }
put-unindexed-markdown-v1 = { 0: 9, 1: uuid, 2: path, 3: unindexed-markdown-payload-v1 }
reindex-unindexed-markdown-v1 = { 0: 10, 1: uuid, 2: path, 3: text }
reindex-ordinary-file-v1 = { 0: 11, 1: uuid, 2: path, 3: text }
```

`put-attachment-file-v1` and conflict value5 carry the critical chunked content
profile (`intent.md` §3.9). Standalone codec support does not activate effect
application. Legacy runtime unions continue whole-entry upgrade/stall rejection until
complete conversions/state/ref inventory and typed verified mediation are qualified.
Never skip these effects/values or turn them into BlobRef/empty content. Every retained
attachment version contributes its complete manifest/chunk Item hash union to `refs`.

**Critical unindexed Markdown effects9/10.** Effect9 installs the complete typed
File payload, atomically removing a prior live Record/index projection with the
same UUID when this is an Op15 transition. Effect10 installs the complete resolved
Record source and atomically removes the prior unindexed File. Kind/path/source/
full-descriptor CAS was resolved by planning at the exact captured state; apply
must atomically commit holder, link/unique/projection tables, head and receipt.
Neither direction is an observable remove+put prefix or opposite-kind tombstone.
Current replaced versions leave state exactly as ordinary replacements do;
history retention remains unchanged. Subsequent File deletion retains complete
kind/content in a File tombstone, and every live/tomb/conflict attachment version
retains all manifest/chunk roots. No partial root set or compaction after admission
failure. Default/attachment-only codecs reject the whole unknown critical parent;
standalone codec support is not apply/install/authority/heap qualification.

**Critical ordinary-file promotion Effect11 (`reindex_ordinary_file`).**
Keys 1=id, 2=path, 3=complete resolved doc,
mirroring Effect10 but with a distinct Ordinary-holder rule. It is the result of
Op17 (`intent.md` §3.12), never a substitute for Effect10's unindexed-kind rule or
legacy PutRecord. Planning resolves the mandatory current kind/path/full-content
CAS and exact-source binding. Apply requires the prior Ordinary File at the same
ID/path and atomically removes that holder while installing the exact Record
source and its index/link/unique projections, head and receipt. No intermediate
remove+put prefix, generated identity/lifecycle rewrite or tombstone change.
Current authority and the captured/prospective catalogue guards remain required.
At verified lost-tail `Stage::Resurrect`, Op17 is skipped with no effects and a
typed diagnostic: its original Effect11 is not replayed, current holder/bytes/
history stay unchanged, and setup can be re-applied against fresh current state.
Legacy/attachment-only codecs reject unsupported Effect11 as a whole-parent
upgrade/stall; decoded syntax alone does not activate apply or provider support.
Unknown-future negative vectors must use a genuinely unallocated tag after11
and retain mixed-parent refusal coverage.

Effects are the **complete** result:
- every record, file and resource the entry creates, changes, moves or removes;
- for creates and changes, the full new document as exact bytes (format fidelity
  already applied).

Applying them needs no semantics: no YAML, no CEL, no merge.

- **Moves.** A `put-record` whose `path` differs from the record's current path is a
  move.
- **Tombstones.** A `remove-record` leaves a tombstone holding the removed document.
- **Resurrection.** A `put-record` for a tombstoned ID resurrects it.
- **Files.** A `put-file` for an existing file ID with a new path is a move. A new
  `blob-ref` is a content replacement. A `remove-file` leaves a file tombstone holding
  the last `blob-ref`. Effects never contain file bytes.
- **`refs`.** The envelope header's `refs` list the object addresses of every blob
  part the entry newly references (new file content, blob-backed texts, lost blobs
  kept by a conflict). The log service requires them to exist and counts them for
  garbage collection (`log-service-api.md` §6.2).

### 2.2 Text table and delta encoding

Entries carry whole documents (FEASIBILITY §2.8). Small edits to large bodies would
make entries large, and the prototype flagged that (FEASIBILITY §4.7). The text table
fixes it **without giving up self-contained results**.

```cddl
; ---- text table (log-entry.md §2.2) ----
text-def = tstr                                        ; literal
         / { 0: 1, 1: text-source, 2: [+ delta-op] }   ; delta against a source
         / { 0: 2, 1: blob-ref }                       ; stored in the blob store

text-source = [0, uuid]   ; prev-record: the record's document just before this entry
                          ;   (its tombstone document if it is deleted)
            / [1, uint]   ; earlier: texts[i] of this entry, i < this index
            / [2, path]   ; prev-resource: the resource document just before this entry

delta-op = [0, uint, uint]   ; copy: source byte offset, length
         / [1, bstr]         ; insert: these bytes
```

Rules:

- **Indexes.** A `text-index` (`intent.md` §2) anywhere in the payload refers to
  `texts[i]`. Several fields may refer to the same index. That is how the intent's new
  document and the result's `put-record` share one copy.
- **Resolving a delta.**
  - Ops run in order over the source's bytes.
  - The result must be valid UTF-8, and every copy must be in bounds.
  - A source that does not exist (no such record or resource before the entry), or an
    `earlier` index that is not smaller, makes the entry malformed (§4.3).
- **Choosing an encoding.** The writer is free to pick, because verification compares
  resolved texts, never encodings. Recommended:
  - a delta when a source exists, the text is ≥ 1 KiB, and the delta is at most half
    the literal;
  - **a blob** when the encoded definition would still exceed 64 KiB.

  Blob-backed texts are uploaded before the append, like file blobs, and listed in the
  header's `refs`.
- **Unbounded records, bounded entries.** Records of any size are representable, while
  every entry stays bounded (§10).
- **Base texts must travel.** A writer that used a retained base body for a merge puts
  it in `body_base_text` (`intent.md` §3.2), normally as a cheap delta against
  `prev-record`. External edits carry `base` and `new` the same way (`intent.md`
  §3.3).

### 2.3 Aliases

```cddl
alias = [path, uuid]     ; old path, record ID
```

An alias says that the record's old path now refers to it (D9, renames and moves). The
path is stored as written. The path key is computed when the alias is looked up,
because path-key folding is semantics-versioned.

### 2.4 Conflicts

```cddl
; ---- conflicts (log-entry.md §2.4) ----
conflict = {
  0: conflict-kind,
  1: uuid,                 ; record or file ID
  ? 2: tstr,               ; field: the top-level key (kind = field)
  ? 3: conflict-value,     ; base
  4: conflict-value,       ; kept: what the record now holds
  5: conflict-value,       ; lost: what this entry's mutation wanted and did not get
}
conflict-kind = &( field: 1, frontmatter: 2, body: 3, path: 4, delete: 5, file: 6 )
conflict-value = [0]                 ; missing key
               / [1, value]          ; a frontmatter value
               / [2, text]           ; a text (frontmatter source, body, path)
               / [3, blob-ref]       ; file content
               / [4]                 ; deleted
               / attachment-conflict-value-v1 / unindexed-markdown-conflict-value-v1
attachment-conflict-value-v1 = [5, attachment-content-v1]
unindexed-markdown-conflict-value-v1 = [6, unindexed-markdown-payload-v1]
```

A conflict records both sides, so the losing value is never discarded silently
(spec 12A):
- The record holds `kept`, the earlier-ordered value.
- `lost` is preserved in the log and in the unresolved-conflicts side table
  (`snapshot.md` §3) until a `conflict_dismiss`.

The mutation the conflict belongs to is the entry's own mutation.

Body conflicts never appear here for `api` updates: they reject (`intent.md` §3.2).
They do appear for `external` `document` operations, whose bodies are never
rejected.

### 2.5 Explicit internal attachment runtime v1 decoding

The separate `attachment_runtime_v1` entry codec mirrors every existing fmt1
header field. Its mutation is the explicit runtime mutation; effects delegate
legacy effects or decode critical attachment8, unindexed Markdown9–10 or Ordinary
promotion11. Conflict sides delegate legacy values or decode attachment5 or
unindexed Markdown6 with the full kind/content payload. Unknown future children fail the
whole entry, including mixed legacy-prefix/critical-child/legacy-suffix arrays.
Default legacy entry/effect/conflict codecs and their rejection behavior stay
unchanged. Decoding alone is not apply, authentication or retention authority.

```cddl
attachment-runtime-v1-entry-payload = entry-payload
```

## 3. First valid wins: the conditional append protocol

The log service appends a batch only if the writer's expected head matches the
service's head exactly: **both the position and the chain hash**. The writer plans at
that exact head, so every S-class check (CAS, enforced uniqueness, explicit paths,
renames, resource writes, policy) is decided at the position where the entry lands.
A writer that loses the race re-plans. **No invalid entry ever enters the log**
(FEASIBILITY §3.2).

### 3.1 Writer loop

A replica runs one append loop per collection. Its state is:
- the applied head `(H, h)`: position and chain hash of the last item applied;
- the pending queue, in capture order.

1. **Catch up.** The writer must have applied every item ≤ `H`, and the head it plans
   at is exactly `(H, h)`.
2. **Control work first.** If policy at `H` requires a rekey (a revocation with no
   rekey after it, `sealed-envelope.md` §5) and this device is a member device, the
   writer appends the `rekey` item alone and goes back to step 1.
3. **Plan a batch.** Take pending mutations in order, up to 64 items and 4 MiB of
   envelopes. Plan each against the state at `H` plus the effects of the earlier
   items in this batch, under the catalog in force there.
   - **Rejected at head** (an S-class or request check fails): leave the mutation out
     of the batch. Resolve its receipt as `rejected` with the reason, drop it from
     pending, and continue with the next mutation, which plans without it.
   - **A resource write** is included and **ends the batch**: later mutations must plan
     under the new catalog.
   - **A mutation over its grant** (the grant was revoked at `H`) is rejected with
     `forbidden`.
4. **Seal.**
   - Item `i` of the batch gets `seq = H + 1 + i`.
   - Its `prev` is the chain hash of item `i − 1`; for the first item it is `h`.
   - It is sealed under the current key epoch at `H` and signed.

   Sealing happens after planning, so the AEAD and signature bind the exact position
   and predecessor.
5. **Append.** `append(collection, expect = (H + 1, h), items)` (`log-service-api.md`
   §4). The outcomes:
   - **`appended`.** The items are durably at `H + 1 …`. The writer applies them
     exactly as it would apply anyone's items (§4), commits, and then reports
     confirmation. Then it rebases the remaining pending work and reconciles files.
   - **`head_moved {head, head_hash}`.** Another writer appended first. Read and apply
     `(H, head]`. Any of this replica's own mutations found there are confirmed
     (receipts, §7). Go to step 1 and re-plan the rest **unchanged**: same mutation,
     clock and seed.
   - **`duplicate {index, seq}`.** The service says item `index` repeats a mutation
     already in the log at `seq` (§7). **Don't trust it on its own word.** Read and
     apply through `seq`, then check that the item at `seq` is an applied (non-void)
     `entry` whose payload carries this mutation ID.
     - If it does, mark the mutation confirmed at `seq`, drop it, and go to step 1.
     - If it doesn't, the service lied or is broken. Record an `integrity` incident and
       keep the mutation pending. Retry once after a fresh read. If the service says
       `duplicate` again for the same item, stop appending and report `sync_stalled`.
       A mutation is never confirmed without its entry in this replica's own view.
   - **`rejected {code}`** (`forbidden`, `too_large`, `quota_exceeded`, `invalid`,
     `gone`): handled per `log-service-api.md` §10. Nothing was appended.
   - **No response** (timeout, connection lost): the outcome is unknown. **Retry the
     same bytes.** The service treats byte-identical items already at those positions
     as success (`log-service-api.md` §4.2), so a retry returns either `appended` or
     `head_moved`, handled as above.
6. **Confirmed means durably appended.** A mutation is confirmed when the service has
   acknowledged its item, or when the replica has applied an item carrying it. Nothing
   is confirmed offline.

**Contention.** After three consecutive `head_moved` results, the writer waits a
random 0–50 ms (from the injected entropy and clock) before re-planning. Reads are
cheap, and hot records are rare (K was 0.23% in the hot scenario, FEASIBILITY §2.1),
so backoff stays small.

### 3.2 What the writer owes the log

- Every item it appends is valid at its position by the rules in §4.3. Under
  correct code, voids happen only when the service misbehaves or a revocation races
  the service's ACL update (`policy.md` §6).
- Blobs and blob-backed texts referenced by an item are durably stored before the
  append (`log-service-api.md` §6). The service refuses an append whose `refs` are
  missing.
- Pending mutations are appended in capture order. A rejected mutation does not
  block the ones after it.

### 3.3 Lost tail: self-repair

An acknowledged item is durable (I1), so the log service must not lose one. If it
does anyway (for example a failover to a lagging node), devices repair the log
themselves. The service is assumed to order honestly and not fork or withhold. A
service head below this replica's applied head is therefore a **lost tail**, not a
fork.

1. **Detect.** The service head `S` is below the applied head `H`, or the service's
   chain differs at a position this replica applied, or the item at `H + 1` has
   `prev ≠ chain(H)`. Then find `L`, the highest position where the service's chain
   equals this replica's. Every detection raises a non-blocking `log_regressed`
   incident (`replica-client-api.md` §7), and the host reports it to ops.
2. **Repair (`L = S`).** Re-append this replica's retained items `(S, H]` as their
   exact bytes, with the ordinary conditional append, before appending any new work.
   - Seq, prev, signatures and tokens are unchanged, so receipts stand.
   - Any holder may repair. Concurrent repairers converge through I4.
   - Missing blob parts are re-uploaded from the local cache first.
3. **Fallback (`L < S`, the gap was overwritten).**
   - Roll confirmed state back to the service's history, reachable only through the
     repair module after the probe, never from a `behind` answer. Use the fully
     verified install path (manifest signature, recomputed control chain, chunk
     checks and row validation), with policy re-evaluated from position 1.
   - Re-queue this replica's own lost mutations with `resurrect = old seq`.
   - Re-create its own lost control items (`rekey`, `key_grant`, `grant_approval`).
   - The control plane re-issues lost `policy` items.
   - Revocations this replica had applied are latched locally (step 5) until they
     reappear in the log.
   - Other authors' lost entries return when their authors run this step. If they
     don't, the holder reports them in a `lost_entries` incident.
4. **Resurrection.** An entry with `resurrect` is planned and verified under
   `Stage::Resurrect`. Semantic (S-class) checks resolve instead of rejecting:
   - a taken path → the collision rule's suffixed path;
   - a CAS or base mismatch → `merged` or `conflicted`;
   - an update of a deleted record → recreate it, `conflicted`;
   - a `unique.enforce` clash → `conflicted`.

   **Authorization is never relaxed.** V1–V7 apply unchanged. A resurrected
   on-behalf mutation whose grant is revoked at head is not appended. The marker only
   selects semantics, and nothing is accepted because of it that would be refused
   without it.
5. **Revocation latch.** A device-local record of the devices, members, grants,
   control-plane keys and freezes this replica saw revoked in the lost window. It
   is persisted and survives restart. It never affects apply or void verdicts,
   which stay deterministic. While missing control restoration is outstanding,
   the replica stays read-only for its hosting app and plans and seals no new
   content; sessions for latched grants are closed and refused.
   - The latch clears when the log shows the revocation again.
   - For a grant, it also clears on a superseding grant that is effective at head
     (`policy.md` §5.1), including valid device approval wherever required.
   - The replica must not leave `resyncing` until all latched revocations reappear
     (or a superseding grant satisfies the rule above) and every own lost control
     item is re-created. If control never re-issues a lost revocation, the latch
     continues to restrict access; after the orphan grace, raise `lost_entries`.
     Missing non-revocation items from other authors fail closed and become orphans.
6. **Receipts.** A mutation confirmed at `p` and resurrected at `q` stays `confirmed`.
   Its submitter gets a receipt push with `seq = q` and `relocated_from = p`. A
   resurrected mutation refused for revocation gets `rejected` (`forbidden`, reason
   `revoked_after_loss`) with `relocated_from = p`, and is listed in `lost_entries`.

## 4. Applying an item

Every replica applies every item in log order, including its own. For the item at
position `p`, checks run in this order.

### 4.1 Integrity: the service gave us a broken log

If any of these fails, the problem is the service, not the item:
- the envelope does not decode as `mdb-cbor/1`;
- `seq ≠ p`, or `prev ≠ chain(p − 1)`;
- `collection` is not this collection.

A `prev` mismatch at `p = H + 1` is handled as a lost tail (§3.3), not here.
Otherwise the replica **stops** at `p − 1`, records an `integrity` incident (the service may be
corrupt or forking the log), and retries from a fresh read. These are not voids:
other replicas may have received different bytes.

### 4.2 Stall: we can't interpret it yet

Each of these stops the replica at `p − 1` until it can proceed, with status
`upgrade_required` or `waiting_for_key` (`replica-client-api.md` §7):
- an unknown envelope `fmt` or `kind`;
- for sealed kinds, no key for the item's epoch. The replica waits for a `key_grant`
  or for its key history. A device keyed after content was written (the normal join)
  has its `key_grant` later in the log than the item it is stopped at, so while
  waiting it reads **control items only** ahead (bounded pages, up to the known head)
  and evaluates them on a copy of `P`, with every check apply makes, so each grant is
  judged under the policy at its own position. From a valid grant to itself it
  installs only epoch keys checked against the commitment of a `rekey` it has
  already applied: the grant's own key if its epoch is current at `p − 1`, or older
  keys from the history box of the `rekey` that created a later grant's epoch
  (`sealed-envelope.md` §5.2). Nothing else read ahead is kept; content is applied
  in order only, and apply re-evaluates every item, grants included. The read-ahead
  starts at the stall and is extended only by the bounded key-wait probe, never by a
  head hint;
- an unknown payload `fmt`, or an unknown variant anywhere in the payload
  (`00-overview.md` §6.2).

Reads keep serving at `p − 1`. Local writes stay pending.

### 4.3 Void: deterministic no-op

An item that fails any of these checks is **void**. It has no effects, and every
replica reaches the same verdict, because each check depends only on the bytes and on
state at `p − 1`.
- **V1.** The signature is invalid, or the signer is not authorized at `p − 1`
  (`policy.md` §6). For an `entry`, the writer device must be enrolled and not
  revoked, and its account must hold a writing role.
- **V2.** An `entry` or `base` item's key epoch is not the current epoch at `p − 1`,
  or the log is in rekey-required state at `p − 1` (a revocation with no rekey after it,
  `sealed-envelope.md` §5.2).
- **V3.** The AEAD fails to open under the known epoch key.
- **V4.** The payload is not valid `mdb-cbor/1`, or does not match the schema of a
  known `fmt`.
- **V5.** `sem.major` is lower than the log's semantics ratchet at `p − 1`
  (`00-overview.md` §6.3).
- **V6.** `on_behalf` names a grant that is not active at `p − 1`, or does not cover
  every operation, including its `file_folders` scope for file operations
  (`policy.md` §5). In `e2e`, the grant's coverage is its effective set: the op
  intersected with its first valid `grant_approval` (`policy.md` §5.1). A grant with no
  approval covers nothing. The signer must also be an active device of the grant's
  account, or an active `hosted` device while the collection is in `cloud-copy`.
  A different member's device, an `escrow` device, an unknown or revoked device,
  and a hosted device in `e2e` do not satisfy this predicate. Without `on_behalf`,
  V6 does not apply; all other validity checks still apply.
- **V7.** The results are structurally invalid:
  - a text fails to resolve (§2.2);
  - `remove-record` or `remove-file` names an ID that does not exist;
  - after all effects, two live records or files share a path key;
  - a path is not a valid collection-relative path (absolute, contains `..`, or under
    `.mdbase/`);
  - `status` is inconsistent with `conflicts`;
  - an operation breaks a request rule of `intent.md` (for example `source = external`
    on a `create`);
  - a size limit of §10 is exceeded.

V7 is a **format-level** check. It is versioned by `fmt`, never by `sem`, and must not
change within a format version. A void item still occupies its position and its
chain hash. Replicas count voids, report them in status, and log the reason.

### 4.4 Apply

For a valid `entry`, the replica applies the effects atomically with the position
update. It also:
- records tombstones and aliases;
- adds the mutation ID to receipts (§7);
- adds its conflicts to the unresolved-conflicts table;
- updates derived indexes.

Control items update policy and keyring state (`policy.md` §6, `sealed-envelope.md`
§5). A `base` item installs the adopted state (`snapshot.md` §7).

After applying a run of items, the replica:
1. resolves receipts of its own confirmed mutations;
2. rebases its pending queue: re-plans each pending mutation, unchanged, on the new
   confirmed state, to give the optimistic local view;
3. reconciles files with the local view (`FilePlatform`; details remain unresolved);
4. pushes changes to subscribed clients.

**Holds.** When an applied entry carries a conflict whose mutation has this replica as
`origin` and `source = external`, the replica holds that record or file: the file keeps
the user's bytes, later saves are collected into the hold, and nothing propagates until
the user resolves it (DESIGN §3). The confirmed state is whatever the entry recorded.
The hold is device-local and never enters the log (`snapshot.md` §3). For `api`
mutations the conflict reaches the submitting client through its receipt
(`replica-client-api.md` §8).

## 5. Applying results versus re-executing to verify

**Replicas apply recorded results.** They never need to plan a foreign entry to
converge. This makes determinism bugs and version skew survivable (FEASIBILITY §2.8, §3).

**Verification mode re-executes.** A verifying replica plans every entry it did not
write, at its position, whose `sem` equals its own. It compares these, as resolved
values, never encodings:
- `status`;
- effects, with texts resolved to bytes;
- conflicts;
- aliases.

- **Match:** counted as verified.
- **Mismatch:**
  - the entry is still **applied as recorded**. Convergence comes from the log, not
    from agreement;
  - the replica increments `verify_mismatch`;
  - it records a diagnostic: `seq`, writer, `sem`, digests of both outcomes, and the
    first differing effect's record ID. The diagnostic holds no content unless the
    user exports it;
  - it continues.
- **Other `sem`:** counted as `unverified`. Planners exist only for their own semantics
  version.

**Who verifies.**
- The hosted replica verifies every entry.
- Device replicas verify when idle, with a CPU budget.
- CI verifies every PR by replaying recorded logs natively and in WASM, and comparing
  digests.

**Telemetry.** A mismatch is a determinism bug, or a buggy or malicious writer. Opt-in
telemetry sends only digests, `sem` and the writer's runtime version. A sustained
mismatch rate on one writer is surfaced to the collection owner.

## 6. Conflicts and holds, end to end

| Origin of the losing write | In the log | On the origin device | Shown to apps |
|---|---|---|---|
| `api`, `conflict_mode = record`, field conflict | `conflicted` entry, conflict recorded | — | receipt `confirmed` with `status: conflicted` and the conflicts; the unresolved-conflicts list |
| `api`, `conflict_mode = reject`, or a body conflict | nothing (rejected at head) | — | receipt `rejected`, code `conflict` |
| `external` (a file edit) | `conflicted` entry, conflict recorded | **hold** on that file until resolved | holds list on that replica; the unresolved-conflicts list everywhere |
| `api` S-class failure (CAS, uniqueness, path, rename race) | nothing | — | receipt `rejected`, code `conflict` with a reason |

## 7. Idempotency by mutation ID

The mutation ID is the idempotency key. Three mechanisms make a mutation land at most
once, even across lost acknowledgements, crashes and long offline periods:

1. **Byte-identical retry.** Retrying the same append bytes succeeds idempotently
   (§3.1 step 5).
2. **Receipts at the writer.** Before planning a pending mutation, the writer checks
   its receipts: mutation IDs it has applied, kept for the receipts horizon. A hit
   confirms the mutation without appending.
   - **Within the horizon.** Snapshots carry receipts (`snapshot.md` §6), so a
     replica that installed a snapshot past its own lost append still finds it.
   - **Beyond the horizon** (a pending mutation that was possibly sent more than
     180 days ago): its outcome is unknown. External edits re-ingest harmlessly,
     because a `document` operation that equals the current state is a no-op. An
     `api` mutation resolves as `outcome_unknown`.
3. **Idempotency tokens at the service.** Each `entry` header carries a token:

   ```text
   K_idem = HKDF-SHA256(ikm = K_epoch1, salt = collection_id, info = "mdbase/v1/idem")
   token  = first 16 bytes of MAC(K_idem, "mdbase/v1/idem", mutation_id)
   ```

   - `K_epoch1` is the collection's first epoch key, which every member can obtain
     through the key history (`sealed-envelope.md` §5). Tokens are therefore stable
     across rekeys.
   - The service indexes tokens for at least the receipts horizon (180 days). It
     answers `duplicate {index, seq}` to an append that repeats one.
   - The service learns nothing from tokens except equality. Using the raw UUIDv7
     would expose capture time, and with it how long a device was offline.

**No deduplication at apply time.** The log is the truth: an item in the log is
applied. Apply-time deduplication would need every replica to hold the same receipts
window, and replicas that installed different snapshots don't. A duplicate could only
enter the log if its writer signed it twice and the service ignored the token. Even
then it would be planned at its own position, so most operations replay as no-ops:
- a `patch` to the same value is unchanged;
- `add`/`remove` are set-like;
- a repeated `create` is rejected at head.

**Clients.** A client that resubmits a mutation ID gets the existing receipt
(`replica-client-api.md` §6). A replica remembers rejected and confirmed receipts it
served for at least 24 hours, and confirmed ones for the receipts horizon.

## 8. Policy and other control items in the log

Policy items are positioned by the same conditional append. The control plane signs
each one at an exact `(seq, prev)` and re-signs it if it loses the race. They take
effect **from the next position**: authorization of the item at `p` uses policy at
`p − 1`.

The log service also parses policy items (they are in clear) and updates its
transport ACL **in the same atomic step** as the append, so there is no window in which
the ACL and the log disagree (`policy.md` §6). Payloads: `policy.md`. Key items:
`sealed-envelope.md` §5. `base`: `snapshot.md` §7.

## 9. Checkpoint entries for live rooms

A room checkpoint is an ordinary `entry` whose mutation carries `room`
(`intent.md` §7): a body-edit update, planned and appended like any other. Nothing
about it is special in the log. That is deliberate: ADR 0014's "materialize through
the ordinary write path", and PLAN's "room checkpoints are ordinary body intents".

- Concurrent checkpoints of identical text merge to a no-op.
- A checkpoint that races an ordinary body write merges by the spec 12A body rules.
  A body conflict rejects the checkpoint, and the room re-bases on the confirmed body
  and checkpoints again.

Ephemeral room traffic never enters the log (`log-service-api.md` §8).

## 10. Size limits

| Limit | Value | Enforced by |
|---|---|---|
| Sealed item (envelope bytes) | 1 MiB | writer, log service (`too_large`), replicas (V7) |
| Decompressed payload of one item | 16 MiB | replicas (decompression-bomb guard; V7) |
| Batch per append | 64 items and 4 MiB | writer, log service |
| Operations per mutation | 1,000 | submit (`too_large`), V7 |
| One literal or delta text definition | 64 KiB encoded; larger texts go to blobs | writer (recommended), V7 at 1 MiB |
| Record document or file | unbounded by the log; bounded by quota | blob store |
| Path | 1,024 bytes UTF-8 | submit (`invalid_request`), V7 |
| Frontmatter nesting depth | 64 | submit, V7 |
| `refs` per item | 1,024 | log service |

**Why 1 MiB.** It bounds the log service actor's memory per request. Typical entries
are a few KiB. A large rename with reference updates touching hundreds of records
still fits after compression and deltas. A mutation that cannot fit even with blob
texts (thousands of reference updates) is rejected with `too_large` at submit. The
client API's partial batch, or a split rename-plus-updates sequence, is the way out.
That is rare enough not to complicate the format.

## 11. Head witnesses: fork and withholding detection

**Deferred.** Fork detection is not implemented for the current release. The service
is assumed to order honestly and not fork or withhold. A head below a replica's own
is treated as a lost tail (§3.3). The design below remains a possible future direction.

The chain hash makes forks and lost tails *detectable*. They are actually detected
only when replicas compare heads. A malicious log service would otherwise keep a
replica on a fork indefinitely. For example, it can hide a `device-revoke` and its
`rekey` from honest devices, so that they keep sealing under a key the revoked device
holds. So devices of a collection exchange **signed head witnesses**:

```cddl
; ---- head witness (log-entry.md §11) ----
head-witness = {
  0: 1,                  ; fmt
  1: uuid,               ; collection
  2: uuid,               ; device: the signer
  3: seq,                ; its applied head
  4: hash,               ; chain(head)
  5: epoch,              ; its current epoch
  6: time-ms,            ; when it signed (its clock; informational)
  7: signature,          ; Ed25519 by the device over H("mdbase/v1/head-witness", canonical(witness without key 7))
  ? 8: hash,             ; policyGeneration = ctl(seq); signed extension
  ? 9: hash,             ; neutral confirmed resource+SEM catalogGeneration; signed extension
}
```

For hosted→local handover, **both** signed generation extensions are required;
legacy witnesses without them are not fences. Hello's status key11 captures the
same confirmed tuple. Preserve opaque bytes: dropping unknown signed keys changes
the digest. Decoding is not verification or session/collection/readiness authority.
See [the handover interface](../ship/interfaces/2026-10-07-hosted-handover-witness.md).
Witness stream/fork exchange below remains the later plan, not implemented by this
hello/status producer.

- **Exchange.** Every replica of a device kind (not thin clients) does all of these:
  - publishes a witness on the collection's witness stream, an ephemeral stream with
    `purpose = 3` and `record_id` all zero (`log-service-api.md` §8.1). It does so on
    each new epoch, and at least every 10 minutes while online.
  - attaches its latest witness to every remote client session's `hello-result`
    (`replica-client-api.md` §2). The SDK passes on witnesses between the replicas it
    talks to.
  - exchanges witnesses during device approval (`sealed-envelope.md` §5.3), over the
    same channel as `r_A`/`r_N`.
- **Checking a witness** from an active device `D` of the collection, with a valid
  signature:
  - if its `seq ≤` own head: the stored `chain(seq)` must equal its `chain`. Replicas
    keep the chain hash of every position they applied (32 bytes per item). A witness
    for a position below what this replica applied itself (it installed a later
    snapshot) is checked only against the snapshot's `chain` when the positions are equal,
    and otherwise skipped;
  - if its `seq >` own head: read up to `seq`. If the service returns a head below
    `seq`, or a chain that differs at `seq`, that is a fork or withheld tail.
  - A mismatch is an **`integrity` incident with reason `fork`**. The replica stops
    appending, keeps serving reads, and tells the user: "this device and *D* see
    different histories of the collection". It never resolves this automatically.
- **Revocation completion.** The device whose user requested a revocation shows
  "revocation pending" until a `rekey` excluding the revoked device appears in its
  view, and until a witness from each of the user's other active devices reports an
  epoch at least that new. A peer that keeps reporting the old epoch is surfaced by
  name.
- **Freshness.** Status reports, per peer device, the time of the last witness that
  agreed with this replica (`replica-client-api.md` §7, `peers`). A peer that has
  given no agreeing witness for 24 hours while the control plane lists it as online
  is flagged as "not confirmed in sync".

**Residual.** In private sync, every channel between devices passes through mdbase
(log service, relay, push). A service that partitions devices *consistently and
completely* can keep them apart. But then each device stops seeing the other's
writes, and freshness flags them by name. What it cannot do is show two devices
conflicting histories while both believe they are in sync. An out-of-band check is
available in the device list: a QR code or 6-digit code of
`H("mdbase/v1/head-witness-code", collection ‖ u64be(seq) ‖ chain)` at a common position.
