# Log service API

Status: draft for review. The implementation is undecided between Postgres on Render
and one Durable Object per collection plus R2 object storage; both must satisfy this contract and its
conformance suite (§13).

The log service is the only server component every synced collection needs. It is
**blind**: it orders, stores and relays sealed items and objects, and it enforces
policy at its transport. It never holds a collection key. What it can observe is listed
in `sealed-envelope.md` §8.

Each collection is **one serialized actor**:
- conditional append;
- reads of ranges;
- push to subscribers;
- snapshot pointers;
- ephemeral streams.

Objects (snapshot chunks, manifests, blob parts) live in an object store beside it.
No operation spans two collections, so the service needs no global lock.

## 1. Invariants

These are normative. The conformance suite (§13) tests each one on every
implementation.

| # | Invariant |
|---|---|
| I1 | **Linearizable per collection.** Appends to one collection take effect in a single total order. An acknowledged item is durable, and is returned by every later read. The head never regresses. |
| I2 | **Conditional on content.** An append succeeds only if `expect_seq = head + 1` and `expect_prev = chain(head)`. |
| I3 | **All or nothing.** A batch is appended entirely or not at all. |
| I4 | **Idempotent replay.** A request whose items are byte-identical to items already stored at those positions returns the original success. |
| I5 | **Token uniqueness.** No two stored `entry` items share an idempotency token within the token retention (≥ 180 days). |
| I6 | **Policy is atomic with the ACL.** A policy item's transport effects (ACL, revocations, frozen flag) apply in the same atomic step as its append. |
| I7 | **Exact bytes.** Reads return the bytes exactly as appended. Objects return exactly the bytes put. |
| I8 | **Immutable objects.** An object never changes once committed. A put of an existing address is idempotent. Snapshot objects are addressed by the SHA-256 of their bytes; blob parts by a keyed address that the service treats as opaque. |
| I9 | **Retention.** No `entry` item above the compaction point (`snapshot.md` §5) is deleted. Control items are never deleted while the collection exists. |
| I10 | **Safe GC.** No object is deleted while a retained item or a retained snapshot references it, or within 24 hours of its upload. |
| I11 | **Ephemeral is ephemeral.** Ephemeral messages are never persisted beyond in-memory buffers and never returned by `read`. |
| I12 | **Blind.** The service holds no collection keys, and never needs plaintext for any operation. |
| I13 | **Bounded transfers.** No object exceeds 9 MiB. Files of any size are sequences of parts, each uploaded, downloaded and resumed independently. |

## 2. Transport and encoding

- **One authenticated WebSocket per replica connection.** It carries requests,
  responses, pushes and ephemeral streams. Plain HTTPS `POST` is accepted for the same
  unary requests, for clients that cannot hold a socket.
- **Bodies** are `mdb-cbor/1` (`00-overview.md` §3), content type
  `application/vnd.mdbase.v1+cbor`.
- **URL prefix** `/v1/`. N-2 minor support (`00-overview.md` §6.4).
- **Large object bodies** (> 1 MiB) are transferred through short-lived pre-signed
  object-store URLs returned by `put_object` / `get_object` (§6). The service still
  verifies them before it makes them visible.

```cddl
; ---- log service frames (log-service-api.md §2) ----
ls-frame = ls-request / ls-response / ls-push

ls-request = {
  0: 0,
  1: uint,               ; request ID, unique per connection
  2: tstr,               ; method
  3: any,                ; params (per method below)
}
ls-response = {
  0: 1,
  1: uint,               ; request ID
  ? 2: any,              ; result (exactly one of 2 or 3)
  ? 3: ls-error,
}
ls-push = {
  0: 2,
  1: tstr,               ; push type
  2: any,                ; payload
}
ls-error = {
  0: tstr,               ; code (§10)
  ? 1: tstr,             ; reason: a finer machine-readable reason
  ? 2: tstr,             ; message: for logs, never shown to end users verbatim
  ? 3: uint,             ; retry_after_ms
  ? 4: any,              ; details
}
```

The first frame on a WebSocket is `hello` (§3).

## 3. Principals and authentication

| Principal | Credential | May |
|---|---|---|
| **Device** (desktop, mobile, app-runtime, cli; also `hosted` and `escrow` as devices) | a short-lived access token from the control plane (15 minutes; audience: the log service; subject: the device ID), **bound to the device signing key** by proof of possession | append its kinds (below), read, subscribe, put and get objects, snapshots, ephemeral streams; all only for collections whose ACL lists it as active |
| **Control plane** | a service credential (mTLS) | create logs, append `policy` items, administrative operations (§12) |

```cddl
ls-hello-params = {
  0: version,            ; api version
  1: tstr,               ; token
  ? 2: uuid,             ; device ID (omitted for the control plane)
  3: signature,          ; Ed25519 over H("mdbase/v1/ls-hello", server_nonce ‖ token)
}
ls-hello-result = { 0: version, 1: bstr .size 32 }   ; negotiated version, server_nonce for the next hello
```

- **Proof of possession.** The server sends a nonce in the WebSocket upgrade response.
  The device signs it with its enrolled signing key, so a stolen token without the
  device key is useless. For plain HTTPS, each request carries a fresh signature over
  `H("mdbase/v1/ls-http", method ‖ 0x00 ‖ path ‖ 0x00 ‖ collection ‖ SHA-256(token) ‖ SHA-256(body) ‖ nonce)`.
  The nonce is server-issued and single-use (the service remembers used nonces until
  they expire).
- **Per-collection authorization uses the ACL**, which the service derives from the
  collection's policy items (§4.3), not from token claims. Revoking a device in the log
  revokes its access to that collection immediately.
- **Item kinds per principal:**
  - devices may append `entry`, `rekey`, `key_grant` and `base`;
  - hosted and escrow identities are admitted only for cloud-copy collections;
    neither is enrolled or authorized for a private (`e2e`) collection;
  - `escrow` may append only `rekey` and `key_grant`, subject to cloud-copy
    key-delivery policy; approved account-device delivery may be performed by
    hosted, or escrow when hosted is unavailable (`sealed-envelope.md` §7.1);
  - the control plane may append only `policy`; service-created cloud-copy epoch
    keys are generated and wrapped by hosted, not by the control plane.

  The envelope `signer` must equal the authenticated device, or, for policy, a key
  certified by the collection's root.
- **Repair appends** (`log-entry.md` §3.3) are the one exception. An active,
  non-revoked device may append items signed by another principal: another device,
  or the control plane for `policy`. The conditions:
  - the uploader must be an active, non-revoked device with a valid token and
    proof of possession at admission. Its own role does not matter (a viewer may
    restore another signer's bytes). Restored policy effects must invalidate its
    authorization if they revoke it;
  - the **signer's** authorization (kind, ACL, epoch, certificate chain,
    `cp-key-revoke`) is evaluated at the item's position, with I6 effects, as the
    restored items are applied in order;
  - such appends are rate-limited like any other and logged.

  This is safe because `seq`, `prev`, collection and epoch are bound into the
  signature and the AEAD, and the service enforces `(expect_seq, expect_prev)`. A
  third party can therefore only put an item back exactly where its signer placed
  it.

## 4. Append

```cddl
; ---- append (log-service-api.md §4) ----
append-params = {
  0: uuid,               ; collection
  1: seq,                ; expect_seq: must be head + 1
  2: hash,               ; expect_prev: must be chain(head)
  3: [+ bstr],           ; items: canonical item envelopes, seq expect_seq, expect_seq + 1, ...
}
append-result = appended / head-moved / duplicate

appended   = { 0: 0, 1: seq, 2: seq, 3: hash, 4: time-ms }   ; first, last, chain(last), appended_at
head-moved = { 0: 1, 1: seq, 2: hash }                        ; head, chain(head)
duplicate  = { 0: 2, 1: uint, 2: seq }                        ; index in the batch, seq of the existing item
```

`head-moved` and `duplicate` are **results, not errors**. They are the normal outcomes
of the first-valid-wins race (`log-entry.md` §3).

### 4.1 Processing order

Inside the collection's actor, for one request:

1. **Authenticate and authorize** the principal for the collection (§3). Failure:
   `unauthenticated` or `forbidden`.
2. **Collection state.** If the collection is unknown: `not_found`. If deleted or moved:
   `gone`. If over its storage quota: `quota_exceeded`.
3. **Shape.**
   - 1–64 items, ≤ 4 MiB in total, each ≤ 1 MiB;
   - each item is a valid `mdb-cbor/1` item envelope of this collection, of a kind this
     principal may append, with consecutive `seq` from `expect_seq`.

   Failure: `invalid` or `too_large`.
4. **Idempotent replay (I4).** If `expect_seq ≤ head`, and every item is byte-identical
   to the stored item at its position, return the stored `appended` for that range.
5. **Head check (I2).** If `expect_seq ≠ head + 1` or `expect_prev ≠ chain(head)`,
   return `head-moved`.
6. **Chain within the batch.** Each item's `prev` must equal the chain hash of the item
   before it. Failure: `invalid`, reason `chain`.
7. **Signatures.** The service verifies each signature (`sealed-envelope.md` §6):
   - device items against the signer's enrolled signing key in the ACL;
   - policy items against the certificate chain (`policy.md` §3).

   Failure: `invalid`, reason `signature`.
8. **Policy gate.** The checks the service can make from clear data, all `frozen` or
   `invalid` with a reason:
   - **content items** (`entry`, `base`) are refused while the collection is frozen or
     rekey-required, and when their `epoch` is not the current epoch;
   - **`rekey`** must have `from` equal to the current epoch;
   - **`policy`** items must be validly signed.

   These mirror the replica rules (`policy.md` §6). Replicas remain authoritative.
9. **Tokens (I5).** If any item's idempotency token is in the token index, return
   `duplicate` for the first such item. Writers verify the claim by reading the item
   at that `seq` (`log-entry.md` §3.1). A `duplicate` is never taken on trust.
10. **Refs.** Every address in any item's `refs` must exist in the object store.
    Failure: `refs_missing` with the missing addresses. An item may not reference
    a `ref-index` object (`invalid`, reason `kind`): only snapshots are expanded (§7).
11. **Commit atomically:**
    - store the items, and advance the head and its chain hash;
    - add the tokens to the index;
    - record the references for GC;
    - apply the policy transport effects (§4.3);
    - update the epoch and rekey-required state from `rekey` and `policy` items.

    Only after the commit is durable, respond `appended`.
12. **Push** a `head` notification to subscribers (§9).

### 4.2 Retries

A client that sees no response retries **the same bytes** (`log-entry.md` §3.1).
Step 4 makes that safe: it returns `appended` if the first attempt committed, and
otherwise the request proceeds normally. A client must not re-seal and resend at the
same positions after an unknown outcome without first reading the head.

### 4.3 Policy transport effects

For each validly signed policy item, applied in the same commit:

| Op | Transport effect |
|---|---|
| `genesis` | sets the root key, owner, state |
| `device-enrol` | adds the device and its signing key to the ACL as active |
| `device-revoke` | marks the device revoked, closes its connections for this collection, sets rekey-required |
| `member-set` | records the account's role: viewer devices may read, but their content appends are refused |
| `member-remove` | revokes the account's devices as above |
| `grant`, `grant-revoke` | none: the service never sees thin clients (their replicas do) |
| `collection-state` | records the state. Switching to `e2e` with active `hosted`/`escrow` devices is refused (`invalid`) |
| `cp-key-revoke` | adds the key to the collection's revoked control-plane keys |
| `migration-cutover` | none |
| `freeze` | sets or clears the frozen flag |

## 5. Read

```cddl
; ---- read (log-service-api.md §5) ----
read-params = {
  0: uuid,               ; collection
  1: seq,                ; after: return items with seq > after
  2: uint,               ; limit: ≤ 1,000 items
  ? 3: &( all: 0, control: 1 ),   ; kinds: default all
  ? 4: uint,             ; max_bytes: soft canonical item-byte budget; default 8 MiB
}
read-result = {
  0: [* [seq, bstr]],    ; items, in order
  1: seq,                ; head
  2: hash,               ; chain(head)
  3: seq,                ; retained_from: the lowest entry position still retained
  4: bool,               ; behind: after + 1 < retained_from (kinds = all); no items are returned then
  ? 5: snapshot-pointer, ; latest snapshot (always when behind)
  6: bool,               ; more: further items exist beyond this page
}
head-params = { 0: uuid }
head-result = { 0: seq, 1: hash, 2: seq, ? 3: snapshot-pointer }   ; head, chain, retained_from, snapshot
```

- **`max_bytes`** must be positive (`invalid`, reason `max_bytes`, for zero).
  Omission preserves the 8 MiB budget; larger values are clamped to 8 MiB.
  The service returns an ordered prefix of eligible items whose sum of canonical
  item byte lengths is at most the budget (inclusive), subject also to `limit`.
  **Progress exception:** if the first eligible item exceeds the budget, it is
  returned alone. An individual legal item may be up to 1 MiB.
  This is a **soft item-byte budget**, not a hard response or decoded-apply limit:
  CBOR framing and metadata are additional, and older servers ignore key 4.
  Consumers must independently bound/admit the response and any decrypted/apply
  batch; requesting 512 KiB does not guarantee a 512 KiB response.
  Byte or item truncation sets `more`; continue after the last returned sequence.
  For control-only pages, `more` may conservatively require one empty follow-up.
- **`kinds = control`** returns only control items. It is never `behind`, because
  control items are never compacted. Bootstrapping replicas use it (`snapshot.md` §8),
  and check what it returns against the manifest's control-chain accumulator
  (`snapshot.md` §8.1). The service is not trusted to return all of them.
- **Behind retention is a result, not an error.** The replica installs the snapshot
  (`snapshot.md` §8). That is the old system's `generation_expired` and
  `fresh_request_required`, handled inside the replica.

## 6. Objects and blobs

Objects are sealed manifests, chunks and blob parts (`sealed-envelope.md` §4). A file
of any size is a sequence of blob parts of at most 8 MiB plaintext. So **chunked,
resumable transfer is simply per-part transfer**: each part is one object, uploaded
and downloaded independently, and a transfer resumes by skipping the parts that
already exist.

```cddl
; ---- objects (log-service-api.md §6) ----
put-object-params = {
  0: uuid,               ; collection
  1: bstr .size 32,      ; address
  2: &( manifest: 16, chunk: 17, blob-part: 18, ref-index: 19 ),   ; kind
  3: uint,               ; size: exact byte length of the object
  4: hash,               ; checksum: SHA-256 of the object bytes
  ? 5: bstr,             ; bytes: inline when size ≤ 1 MiB; omit to request a direct upload
}
put-object-result = {
  0: &( stored: 0, upload: 1, exists: 2 ),
  ? 1: direct-transfer,  ; when upload: where to PUT the bytes
}
direct-transfer = {
  0: tstr,               ; url: pre-signed, single use, expires in 15 minutes
  1: { * tstr => tstr }, ; headers the client must send (e.g. the SHA-256 checksum header)
  2: time-ms,            ; expires_at
}
commit-object-params = { 0: uuid, 1: bstr .size 32 }     ; after a direct upload
commit-object-result = { 0: bool }                       ; stored and verified

get-object-params = {
  0: uuid,
  1: bstr .size 32,
  ? 2: [uint, uint],     ; range: byte offset, length (for streaming large parts)
}
get-object-result = {
  ? 0: bstr,             ; bytes, inline when ≤ 1 MiB (or the requested range)
  ? 1: direct-transfer,  ; else where to GET them (supports HTTP Range)
  2: uint,               ; size
  3: hash,               ; checksum
}
has-objects-params = { 0: uuid, 1: [+ bstr .size 32] }  ; up to 1,024 addresses
has-objects-result = { 0: [+ bool] }
```

**Upload.**
1. `put_object` with the address, kind, size and checksum.
   - If the object already exists, the result is `exists`. Uploads are idempotent,
     and the result is the deduplication answer.
   - Small objects go inline.
   - Otherwise the service returns a **direct transfer**: a pre-signed single PUT to
     the object store, carrying the checksum as an integrity header (R2 and S3 both
     verify `x-amz-checksum-sha256` on PUT). The bytes then never pass through the
     collection actor.
2. After a direct upload, `commit_object`. The service checks size and checksum, and
   for `manifest`/`chunk` also `address = checksum`. The object becomes visible only
   then.
3. Uncommitted uploads expire after 24 hours.

Resumption needs no transfer state: after a crash the writer asks `has_objects` for
the blob's derived part addresses, and uploads the rest.

**Download.**
- `get_object` returns small objects inline. For larger ones, omit its RPC `range`
  to obtain a signed direct GET for the complete encoded object. HTTP ciphertext
  ranges are a transport-resume mechanism, not permission to emit partial plaintext.
- Direct full GET returns 200 and exact `Content-Length`; a supported single closed
  `Range: bytes=start-end` returns 206 with exact `Content-Length` and
  `Content-Range: bytes start-end/full-size`. Both endpoints must be inside the
  full object: no clamping, open/suffix/multi ranges or silent whole-object fallback.
  An authorized invalid range returns 416 and `Content-Range: bytes */full-size`.
- The signed capability binds collection, address, full encoded size/checksum and
  expiry. Hosts correlate stored/returned metadata to that tuple and recheck expiry
  after storage awaits, before returning the body. The response header
  `x-amz-checksum-sha256` is base64 SHA-256 of the **whole encoded object**, including
  on a partial response; it is not a partial-range or plaintext-file checksum.
- Readers verify the reconstructed complete object's checksum and authenticate
  its permissible AEAD release unit before emitting plaintext. Plaintext ranges
  fetch complete intersecting authenticated chunks. Verify the complete plaintext
  file digest after decryption (`sealed-envelope.md` §3 and §4.2).
- The same RPC request with `range` returns encoded byte-string data and may buffer
  up to 9 MiB; it is not the large-chunk direct streaming path. Native direct GET
  currently buffers at most one sealed object; DO direct GET preserves R2's stream.
  Capability expiry is not immediate mid-stream revocation or a GC retention lease;
  consumer current-permission/generation fences and transfer lifetime admission are
  additional obligations.

**Validation.**
- Every object must be an `mdb-cbor/1` item envelope of this collection, of the
  stated kind, at most 9 MiB (an 8 MiB plaintext part plus framing and padding).
- The service verifies `address = SHA-256(bytes)` for `manifest`, `chunk` and
  `ref-index`. A `ref-index` must also satisfy `sealed-envelope.md` §4.3 (clear
  payload, 1 to 8,192 strictly ascending addresses).
- It cannot verify a blob part's keyed address, which needs the collection key. It
  verifies the checksum and envelope only. Readers verify the content
  (`sealed-envelope.md` §4.2).
- Objects are immutable. The first committed object at an address wins.

**Both D2 candidates** implement this the same way: objects in R2 (or another
S3-compatible store) under `c/<collection>/<hex address>`, pre-signed URLs minted by
the service. With Postgres, object metadata lives in a table. With Durable Objects, it
lives in the collection's SQLite storage. Neither stores object bytes in the database.

### 6.2 Garbage collection

An object is **live** if any of these reference it:
- a retained item's `refs`;
- a retained snapshot's `refs` (§7), which include the blobs of file tombstones and
  unresolved conflicts until the horizon (`snapshot.md` §6), and every address listed
  by a `ref-index` object among them;
- an upload, committed or not, less than 24 hours old.

The service deletes non-live objects in the background (I10), after copying each
committed one to the collection's archive prefix (`archive/<tier>/<collection>/objects/`,
kept for the collection's retention window: 30 days by default, 365 for the paid tier,
expired by storage lifecycle rules, never read by the service). Snapshot refs carry
tombstoned blobs until the deterministic horizon, and items stay until the compaction
point. So a blob is deleted only after every replica within the horizon has applied
the delete or replacement. No per-replica tracking is needed, and none would survive
dead devices.

Writers upload objects **before** appending the items that reference them
(`log-entry.md` §3.2). An object that is uploaded but never referenced is collected
after 24 hours.

## 7. Snapshots

```cddl
; ---- snapshots (log-service-api.md §7) ----
snapshot-pointer = {
  0: seq,                ; seq
  1: hash,               ; manifest address
  2: uuid,               ; author device
  3: time-ms,            ; created_at (service clock)
  4: bool,               ; endorsed
}
put-snapshot-params = {
  0: uuid,               ; collection
  1: seq,                ; seq the manifest describes
  2: hash,               ; manifest address
  3: [+ bstr .size 32],  ; refs: every chunk address and every blob part address the snapshot's rows reference,
                         ;   directly or through ref-index objects (at most 32 of them)
}
put-snapshot-result = { 0: bool }        ; accepted (false: a snapshot at a position ≥ seq already exists)
get-snapshot-params = { 0: uuid }
get-snapshot-result = { 0: [* snapshot-pointer] }   ; the retained snapshots, newest first (at most 2)
endorse-snapshot-params = { 0: uuid, 1: seq, 2: hash }   ; collection, seq, manifest
endorse-snapshot-result = { 0: bool }    ; endorsed
```

- **`put_snapshot`** requires all of:
  - `seq ≤ head`, and `seq` above the latest snapshot's;
  - the manifest and every ref exist;
  - the principal is an active device.

  The service cannot read the manifest. It records the pointer and the refs.
- **Ref-index expansion.** Each ref of kind `ref-index` (`sealed-envelope.md` §4.3)
  is read and expanded in the same request, and the stored refs are the direct refs
  plus every address the indices list. GC (§6.2) and storage accounting therefore
  see the complete set, and no backend follows indices itself. Fail closed, nothing
  registered:
  - more than 32 index refs: `too_large`, reason `ref_indices`;
  - an index whose stored bytes are gone or no longer hash to its address: an
    integrity incident (`internal`);
  - a listed address that is absent: `refs_missing`, with at most 1,024 of the
    missing addresses;
  - a listed address that is not a `chunk` or `blob-part` (depth exactly one: an
    index never lists an index or a manifest): `invalid`, reason `kind`.
- **`endorse_snapshot`** is accepted from an active device **other than the author**
  (`snapshot.md` §5.2). The service then marks the snapshot endorsed, and compaction
  may advance to it.
- **Compaction** (`snapshot.md` §5.1) runs in the background, and deletes `entry`
  items at or below the compaction point, after writing them in order to the archive
  prefix as sealed-bytes segments (`archive/<tier>/<collection>/segments/<from>-<to>`,
  format 1: `{0: 1, 1: collection, 2: from, 3: to, 4: chain(to), 5: [[seq, item]…]}`,
  at most 8 MiB of item bytes each; the deletion commits only once every segment is
  stored). Archived bytes do not count toward storage. Their tokens stay in the index
  until they expire.

## 8. Ephemeral per-record streams

Presence, and future live rooms, ride on **ephemeral streams**. They are separate from
the canonical log and never replayed.

### 8.1 Stream identifiers

A stream's ID is a per-record pseudonym under the current epoch key. Replicas compute
it, and the service never learns which record a stream belongs to:

```text
K_stream = HKDF-SHA256(ikm = K_epoch, salt = collection_id, info = "mdbase/v1/stream-id")
stream   = first 16 bytes of MAC(K_stream, "mdbase/v1/stream-id", u8(purpose) ‖ record_id)
purpose: 1 = presence, 2 = room, 3 = head witnesses (record_id all zero; log-entry.md §11)
```

The ID changes when the epoch does. Participants rejoin under the new ID after a rekey.

### 8.2 Operations

```cddl
; ---- ephemeral streams (log-service-api.md §8) ----
stream-join-params  = { 0: uuid, 1: bstr .size 16 }           ; collection, stream
stream-join-result  = { 0: [* uuid] }                         ; devices currently joined
stream-leave-params = { 0: uuid, 1: bstr .size 16 }
stream-send-params  = { 0: uuid, 1: bstr .size 16, 2: bstr }  ; collection, stream, message (ephemeral item envelope)
stream-send-result  = { 0: uint }                             ; delivered: number of sessions it was queued for
; pushes
stream-msg   = { 0: uuid, 1: bstr .size 16, 2: uuid, 3: bstr }      ; collection, stream, from device, message
stream-event = { 0: uuid, 1: bstr .size 16, 2: uuid, 3: &( joined: 0, left: 1 ) }
```

**Semantics:**
- **Fan-out.** A message goes to every other session joined to the stream, never back
  to its sender.
- **Delivery.** At most once. FIFO per sender. No order across senders.
- **No persistence, no history, no replay.** A session that joins late sees only later
  messages, plus `stream-event`s. It asks peers for current state through the stream
  itself, as Yjs awareness does.
- **Leaving.** A session leaves when it says so, when its connection closes, or after
  60 s without a message. Each departure pushes `left`.
- **Enforcement.** The service enforces membership (active devices only) and the
  limits below. It never reads messages, which are sealed (`sealed-envelope.md` §9).

**Limits** (initial values; the service may lower them under load and returns
`rate_limited`):

| Limit | Value |
|---|---|
| Message size | 16 KiB (a future room profile may negotiate 64 KiB) |
| Send rate per session per stream | 30 messages/s and 256 KiB/s |
| Sessions per stream | 64 |
| Streams joined per connection | 512 |
| Active streams per collection | 4,096 |
| Idle timeout | 60 s |
| Server buffer per receiving session | 256 KiB; beyond it, the oldest queued messages are dropped |

## 9. Subscribe and push

```cddl
; ---- subscriptions (log-service-api.md §9) ----
subscribe-params = {
  0: uuid,               ; collection
  1: seq,                ; after: the subscriber's applied head
  ? 2: uint,             ; inline_bytes: push items inline up to this many bytes per push (default 65,536; 0 = heads only)
}
subscribe-result = { 0: seq, 1: hash }                        ; current head, chain
unsubscribe-params = { 0: uuid }
; pushes
head-push   = { 0: uuid, 1: seq, 2: hash }                    ; collection, head, chain(head)
items-push  = { 0: uuid, 1: [+ [seq, bstr]], 2: seq, 3: hash }   ; collection, items, head, chain(head)
closed-push = { 0: uuid, 1: tstr }                            ; collection, reason (an error code)
```

- **Push, not polling.** After each commit the service pushes to every subscriber of
  the collection:
  - `items-push` when the new items fit in the subscriber's `inline_bytes`, saving the
    read round trip that dominates confirmation latency on the other replicas;
  - otherwise `head-push`, and the replica reads (§5).

  The old system's one-second `changes` polling is gone.
- **Coalescing and backpressure.** A connection's push queue is bounded (1 MiB).
  When it fills, the service drops queued `items-push` frames for that collection and
  keeps one `head-push` with the latest head. A head notification is idempotent state,
  so nothing is lost: the replica reads what it missed.
- **Revocation.** On revocation, or on collection deletion or move, the service sends
  `closed-push` and drops the subscription.

## 10. Errors

Replicas see these codes. **Apps never see them**: the replica maps them to the client
error model (`replica-client-api.md` §9).

| Code | Meaning | Replica's recovery |
|---|---|---|
| `unauthenticated` | missing, expired or unbound token | refresh the token from the control plane, then retry |
| `forbidden` | the principal is not allowed: device revoked, viewer appending, wrong kind | stop appending; re-read policy. If this device is revoked, report `access revoked` and stop syncing |
| `not_found` | no such collection or object | re-resolve routing with the control plane; a missing object is an integrity incident |
| `gone` | the collection was deleted or moved | stop; surface to the user |
| `invalid` | malformed request or items: reasons `shape`, `chain`, `signature`, `epoch`, `kind`, `policy` | a bug or a stale replica. Re-read the head and policy, re-plan once, then stop and report |
| `too_large` | item, batch or object over its limit | split the batch; a single item over the limit is a writer bug |
| `refs_missing` | referenced objects are absent | upload them and retry |
| `frozen` | the collection is frozen or rekey-required | rekey-required: perform the rekey (`log-entry.md` §3.1). Frozen: wait for a push |
| `rate_limited` | over a rate limit | wait `retry_after_ms` |
| `quota_exceeded` | over the storage quota | stop appending content; surface to the user. Reads continue |
| `unavailable` | the actor is restarting, moving or overloaded | wait `retry_after_ms`, with jitter |
| `upgrade_required` | the API version is no longer supported | surface `upgrade_required` |

## 11. Quotas and backpressure

Quotas are per collection, set by the control plane per plan (§12). Initial values:

| Quota | Default |
|---|---|
| Storage (retained items + live objects) | per plan, e.g. 1 GiB free tier. Compression and compaction count in the user's favour; the prototype's 4× storage amplification was a hosted-row artifact |
| Sustained append rate | 50 items/s and 4 MiB/s per collection, burst 500 items |
| Read bandwidth | 32 MiB/s per connection |
| Object upload bandwidth | 32 MiB/s per connection |
| Connections | 8 per device per collection |
| Subscriptions | 1 per connection per collection |

Throttling returns `rate_limited` with `retry_after_ms`. The service never queues
unbounded work for a collection. Pushes coalesce (§9). Ephemeral messages are dropped
before log traffic is delayed.

## 12. Control-plane administrative API

Over the control plane's credential only:

| Method | Effect |
|---|---|
| `create_log {collection, genesis item}` | creates the actor with the genesis policy item at `seq` 1 |
| `set_quota {collection, quotas}` | |
| `delete_log {collection}` | marks it `gone`; data is deleted after a grace period, per the retention policy |
| `move_log {collection, target}` | for migrations between backends. The log is `unavailable` during the copy, which is verified by chain hash |
| `export {collection}` | streams every retained item, snapshot pointer and object, for backups and restore drills |
| `revoke_device_credentials {device}` | refuses the device on every collection at the transport, ahead of the policy items |

## 13. Implementation mapping

Both candidates implement the same contract.

**Postgres (+ an object store).**
- **Tables:**
  - `collections`: head seq, head chain, epoch, rekey_required, frozen, root, state,
    quotas;
  - `items (collection, seq) primary key`: kind, bytes, appended_at;
  - `tokens (collection, token)`: seq, expires_at;
  - `acl (collection, device)`: sign_pk, kind, account, active;
  - `snapshots`;
  - `object_refs (collection, address, holder)`;
  - `objects`: metadata. Object bytes are in S3 or R2.
- **Append.** One transaction:
  1. `SELECT … FROM collections WHERE id = $1 FOR UPDATE`. The row lock *is* the
     per-collection actor.
  2. The checks of §4.1.
  3. The inserts, and the head update.
  4. `COMMIT`, which is the durability point.

  The primary key on `(collection, seq)` is a second guard for I1/I2. Real Postgres
  only in tests (non-negotiable 7).
- **Push.** `NOTIFY` on a per-collection channel. WebSocket gateways `LISTEN` for the
  collections their connections subscribe to.
- **Ephemeral streams.** In memory at the gateways, with connections routed by
  collection: a consistent hash on the collection ID sends all of a collection's
  sockets to one gateway.

**Durable Objects + R2.**
- **Actor.** One Durable Object per collection, named by the collection UUID, with
  SQLite-backed storage holding the head, ACL, tokens, snapshot pointers and retained
  items.
- **Append.** Runs inside the object, single-threaded. Output gates hold the response
  until the storage write is durable, which gives I1 and the ack-after-durable rule.
- **WebSockets** terminate at the object (hibernation API), so push and ephemeral
  streams are local to the actor.
- **Objects** live in R2 under `c/<collection>/<address>`, with pre-signed URLs for
  large transfers.
- **Size.** Item storage per object is bounded by compaction. The 10,000-entry grace
  plus the tail since the last endorsed snapshot is far below the per-object storage
  limit.

**Conformance suite** (`conformance/log-service/`, a Phase 0 deliverable that may start
empty). One test group per invariant I1–I13, plus:
- a race test: N writers in a tight loop, checking that the final log is one chain
  with every acknowledged item present exactly once;
- crash and restart during append;
- failover with a lost tail, checking that `expect_prev` catches it;
- GC under concurrent uploads;
- the ephemeral limits.

It runs against both candidates in CI.
