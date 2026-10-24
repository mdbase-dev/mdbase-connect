# Sealed envelope: encryption, keys and signatures

Status: draft for review.

One encryption scheme covers all collection data, in every collection state:
- log entries, snapshots and blobs are always sealed with the collection key;
- the hosted replica holds plaintext only in its disposable collection-DO cache;
- a cloud copy means mdbase also holds an escrowed copy of the key (§7).

The relay-to-device channel is a separate, standard session protocol (Noise,
`replica-client-api.md` §12). The custom per-grant envelope of the current system is
not carried over.

## 1. Threat model

| Party | Trusted for | Assumed capable of |
|---|---|---|
| **Log service** | availability, and ordering what it accepts | reading everything it stores and every request; dropping, delaying or reordering responses; withholding items; showing different logs to different replicas (forking); losing a recent tail on failover; replaying old ciphertext |
| **Control plane** | account identity, device enrolment, grants, routing; **not** confidentiality in end-to-end collections | enrolling a device it controls (mitigated by device approval in end-to-end collections, §5.3) |
| **Enrolled member devices** | everything in the collection | — (a malicious member device can write anything its role allows; signatures make it accountable) |
| **Revoked devices** | nothing after revocation | keeping every key and ciphertext they ever received |
| **Thin clients and third-party apps** | what their grant allows | — (never hold keys; the replica enforces the grant) |
| **The network** | nothing | everything (TLS plus the above) |

**Properties.**
- Confidentiality and integrity of content against the log service and the network.
- Per-item authenticity and accountability: every item is signed by an enrolled
  device or the control plane.
- Position binding: the service cannot move, reorder or splice items undetected.
- Rollback and fork *detection*: chain hashes and the conditional append on
  `(seq, prev)`. A replica notices when the service loses or rewrites its tail, and two
  replicas that compare heads detect a fork.
- Forward secrecy towards revoked devices: content sealed after a revocation's rekey.

**Non-goals.**
- Hiding sizes, timing and access patterns beyond padding (§8).
- Forward secrecy for members (an enrolled device can read history it holds keys
  for).
- Availability against a malicious service.

## 2. The item envelope

Every log item, stored object and ephemeral message uses one envelope:

```cddl
; ---- item envelope (sealed-envelope.md §2) ----
item = {
  0: 1,                  ; fmt
  1: item-kind,          ; kind
  2: uuid,               ; collection
  ? 3: seq,              ; seq: log items only
  ? 4: hash,             ; prev: chain hash of item seq-1; 32 zero bytes when seq = 1
  ? 5: epoch,            ; epoch: key epoch; sealed kinds only
  ? 6: bstr .size 16,    ; signer: device ID, or control-plane key ID (policy)
  ? 7: bstr .size 16,    ; salt: sealed kinds only (§3)
  ? 8: bstr .size 16,    ; idem: idempotency token; kind entry only (log-entry.md §7)
  ? 9: [+ hash],         ; refs: object addresses this item references
  ? 10: bstr .size 16,   ; stream: ephemeral stream ID; kind ephemeral only
  11: bstr,              ; body: ciphertext, or the clear payload's canonical bytes
  ? 12: signature,       ; sig
}

item-kind = &(
  entry: 1, policy: 2, rekey: 3, key-grant: 4, base: 5,    ; log items
  grant-approval: 6,                                       ; log item (policy.md §5.1)
  manifest: 16, chunk: 17, blob-part: 18, ref-index: 19,   ; stored objects
  ephemeral: 32,                                           ; ephemeral stream messages
)
```

| Kind | 3 seq, 4 prev | 5 epoch, 7 salt | 6 signer | 8 idem | 9 refs | 10 stream | 12 sig | body |
|---|---|---|---|---|---|---|---|---|
| `entry` | required | required | device | required | when referencing objects | — | required | sealed `entry-payload` |
| `policy` | required | — | CP key ID | — | — | — | required (CP) | clear `policy-payload` |
| `rekey` | required | — | device | — | — | — | required | clear `rekey-payload` |
| `key_grant` | required | — | device | — | — | — | required | clear `key-grant-payload` |
| `base` | required | required | device | — | required (manifest) | — | required | sealed `base-payload` |
| `grant_approval` | required | required | device | — | — | — | required | sealed `grant-approval-payload` (`policy.md` §5.1) |
| `manifest` | — | required | device | — | required (chunks, blobs) | — | required | sealed manifest |
| `chunk` | — | required | — | — | — | — | — | sealed chunk |
| `blob-part` | — | required | — | — | — | — | — | sealed blob part (keyed address, §4.2) |
| `ref-index` | — | — | — | — | — | — | — | clear `ref-index-payload` (§4.3) |
| `ephemeral` | — | required | device | — | — | required | — | sealed message |

Fields not listed for a kind MUST be absent. A clear body is the `mdb-cbor/1`
encoding of the payload, wrapped in a byte string. The signature then covers exact
bytes, and the payload can be validated on its own.

### 2.1 Associated data

The AEAD's associated data is the canonical encoding of the item **without keys 11
(body) and 12 (sig)**. It binds:
- the kind;
- the collection;
- for log items, the position `seq` and the predecessor `prev`;
- the epoch, the signer, the salt;
- the idempotency token and the refs.

So the service cannot:
- move a sealed body to another position or collection;
- splice it after another predecessor;
- relabel its kind or epoch;
- attach another entry's refs.

### 2.2 Signature

```text
sig = Ed25519.sign(sk_signer, H("mdbase/v1/item-sig", canonical(item without key 12)))
```

It covers the header and the ciphertext. Given the epoch key, the ciphertext determines
the plaintext: the payload key is derived from the salt, and ChaCha20 is a stream
cipher under one key. So the signature commits to the content. Verification rules are
in §6.

### 2.3 Chain hash

```text
chain(0) = 32 zero bytes
chain(p) = H("mdbase/v1/chain", canonical bytes of the complete item at p, including sig)
```

The item at `p + 1` carries `prev = chain(p)`. The log service accepts an append only
when `prev` equals its head's chain hash (`log-service-api.md` §4). That makes the
conditional append a compare-and-swap on content, not just a count. A service that
lost its last few items in a failover, then accepted a different item at the same
position, is caught by any replica that applied the lost item: its `prev` no longer
matches. A forked log is caught by any two replicas that compare `(seq, chain)` for
a common `seq` (`open-questions.md` Q13).

## 3. Sealing a payload

```text
1. frame   = u8(alg) ‖ u32be(len(data)) ‖ u32be(raw_len) ‖ data
             where data = DEFLATE-raw(plain) if alg = 1, or plain if alg = 0,
             and raw_len = len(plain) ≤ 16 MiB
2. padded  = frame ‖ zero bytes up to padme(len(frame))
3. salt    = 16 bytes from the CSPRNG
4. k       = HKDF-SHA256(ikm = K_epoch, salt = salt, info = "mdbase/v1/payload")   ; 32 bytes
5. split padded into segments of 65,536 bytes; the last is shorter or equal, never empty
6. for segment i of n:
     nonce_i = u88be(i) ‖ u8(1 if i = n - 1 else 0)                ; 12 bytes
     c_i     = ChaCha20-Poly1305.seal(k, nonce_i, segment_i, aad)   ; RFC 8439
7. body    = c_0 ‖ c_1 ‖ … ‖ c_{n-1}
```

`aad` is §2.1's associated data. Opening reverses the steps:
1. Split the body into 65,552-byte ciphertext segments; the last may be shorter.
2. Require the final flag on exactly the last segment.
3. Verify each tag.
4. Parse the frame. Require the padding bytes to be zero and `len(data)` to fit.
5. Decompress to exactly `raw_len` bytes; any other length fails.

Any failure is an AEAD failure (`log-entry.md` V3).

**Why this construction.**
- Steps 3–7 are the payload construction of age v1 (C2SP age specification): a
  per-object HKDF key and STREAM segments with a counter and final-flag nonce. It is
  published and reviewed, and it streams, which large blobs and snapshot chunks need.
  Using it for every object, small or large, means one construction to implement,
  test and review.
- **The only randomness is the 16-byte salt.** It comes from the CSPRNG through the
  injected entropy interface; nonces never come from a seeded generator. Each object
  gets a fresh key, so counter nonces never repeat under a key. A salt collision is a
  2^-128 event per pair, and stays negligible up to about 2^48 objects per epoch key.
- A single ChaCha20-Poly1305 key with random 96-bit nonces would hit its birthday
  bound around 2^32 messages. XChaCha20-Poly1305 with random 192-bit nonces (the
  prototype's choice) is safe, but still needs a separate streaming scheme for large
  objects.
- age's own header binds nothing about position. Here the AAD binds the item header
  into every segment.

**Compression algorithm IDs:** `0` none, `1` raw DEFLATE (RFC 1951). The writer uses
DEFLATE when it saves at least 5%, otherwise none: attachments that are already
compressed stay as they are.

**Why DEFLATE.**
- `miniz_oxide` is pure Rust (S5: no C in shared crates), small in WASM, mature, and
  supports both directions.
- Browsers decode it natively (`DecompressionStream("deflate-raw")`).
- On Markdown its ratio is close to zstd's.

zstd with a trained dictionary would compress small entries much better, but no
mature pure-Rust encoder exists today. The algorithm byte leaves room for it
(`open-questions.md` Q16).

**Padmé** (Nikitin et al., "Reducing Metadata Leakage from Encrypted Files and
Communication with PURBs", 2019) for `L ≥ 2`:

```text
E = floor(log2 L);  S = floor(log2 E) + 1;  z = E − S;  m = 2^z − 1
padme(L) = (L + m) & ~m
```

The overhead is at most about 12%, and it leaks O(log log L) bits of length instead
of the exact length.

## 4. Stored objects and blobs

### 4.1 Object addresses

There are two kinds of stored object, addressed differently:

| Object | Address | Who can verify it |
|---|---|---|
| `manifest`, `chunk`, `ref-index` | `SHA-256(object bytes)`: the canonical encoding of the whole envelope | anyone, including the log service at upload |
| `blob-part` | a **keyed** address derived from the content (§4.2) | key holders only, after decryption. The service checks a transport checksum (`log-service-api.md` §6) |

- **Snapshot objects.** Manifests and chunks get fresh salts, so equal plaintexts give
  different objects, and their plain addresses reveal nothing. Reuse across snapshots
  is by reference (`snapshot.md` §5.3).
- **Blobs** are keyed by content, so that two devices adding the same file deduplicate
  without coordinating, while the blind service cannot tell which files are identical
  to anything it knows.
- **Integrity always comes from a signed reference.** Every address is in a signed
  item or manifest, so `chunk` and `blob-part` objects need no signature of their own.
  A `manifest` is signed because it is fetched through a pointer that is not itself
  signed (`log-service-api.md` §7).

### 4.2 Blobs: keyed content addressing

A blob is the immutable content of a file, or a large text (`log-entry.md` §2.2). For
a plaintext `B` of `size` bytes, sealed under epoch `e`:

```text
K_cid(e)   = HKDF-SHA256(ikm = K_e, salt = collection_id, info = "mdbase/v1/content-id")
blob_id    = MAC(K_cid(e), "mdbase/v1/blob-id", SHA-256(B) ‖ u64be(size))
part i     = B[i·part_size … min((i+1)·part_size, size)]        for i = 0 … max(1, ceil(size/part_size)) − 1
address_i  = MAC(K_cid(e), "mdbase/v1/blob-part", blob_id ‖ u32be(i))
object_i   = envelope { kind: blob-part, epoch: e, salt: fresh, body: seal(part i) }
```

The `blob-ref` (`intent.md` §3) records `plain_hash = SHA-256(B)`, `size`, `blob_id`,
`id_epoch = e` and `part_size`. Part addresses are derived from these, so a reference
stays small however large the file is. An empty file has one empty part.

**Why keyed.**
- A plain content hash as the address would let the log service confirm that a
  collection contains a known file (a confirmation-of-file attack), and link identical
  files across collections and accounts.
- A keyed address reveals only that one collection, under one epoch, stores the same
  content twice: inherent to deduplication, and visible only as two references to one
  blob.
- One pass over the file computes both the digest and the address input. Large files
  are hashed once, not twice.

**Deduplication.** Before uploading, a writer derives the part addresses under the
current epoch and asks `has_objects`. Parts already present are skipped. So
deduplication works across devices within a collection with no prior knowledge.
Uploads are idempotent, and resumable part by part. A writer that already knows a
`blob-ref` with the same `plain_hash` and `size` (from the log or the snapshot) MAY
reuse it as is, even from an older epoch.

**Key epochs.** `K_cid` is derived per epoch, so the same content gets a new
`blob_id` after a rekey. Consequences:
- **No new information for revoked devices.** A revoked device can no longer compute
  addresses, so it cannot probe the store for content written after its revocation.
- **Old blobs keep their old addresses** and their `id_epoch` and part epochs.
  Readers obtain old epoch keys through the key history (§5.2), so they read them
  normally.
- **Deduplication across epochs** happens through the reference rule above, not
  through addresses. The first new upload of a file after a rekey is a full upload.
- **Re-seal** (§7.3) rewrites live blobs under the current epoch with new
  `blob-ref`s. That takes a `file_put` per file, carrying `if_revision`, with the
  same content digest.

**What a reader checks.** After decrypting and concatenating the parts, the reader
verifies `SHA-256 = plain_hash` and the length. A blob that fails this is
*unavailable*, not applied:
- the record or file is marked `blob_unavailable` in status, and its other data is
  unaffected;
- the reader re-fetches once, then records an incident.

Only a malicious member device could upload different bytes under a valid address
first ("squatting"). Members are trusted for content, and this makes the misbehaviour
visible.

**Parts.** The default `part_size` is 8 MiB of plaintext. That is a single PUT to
object storage, comfortably above R2's 5 MiB multipart minimum, so no multipart
upload API is needed. It is also small enough to bound memory and resume cheaply. A
part is sealed with the §3 construction (64 KiB segments inside it), so a reader can
stream-decrypt a part without buffering it whole. Compression applies per part,
when it helps (§3).

**Epochs of other objects.** An object's epoch is in its header, and objects keep the
epoch they were sealed under until rewritten. New snapshots reseal changed chunks
under the current epoch, and re-seal may rewrite old blobs.

### 4.3 Ref-index objects

A snapshot whose refs inventory is too large for one log-service request lists its
refs in `ref-index` objects and names those in its `refs` instead (`snapshot.md`
§2.1, `log-service-api.md` §7).

```cddl
; ---- ref-index object (sealed-envelope.md §4.3) ----
ref-index-payload = {
  0: 1,                  ; fmt
  1: bstr,               ; addresses: 32 bytes each, strictly ascending, 1 to 8,192 of them
}
```

- **Clear, unsigned.** The log service must read the addresses to retain them, and
  they are exactly what a snapshot's clear `refs` already reveal (§8). Integrity
  comes from the content address, named in the signed manifest's `refs` and its
  `ref_indices` (`snapshot.md` §2). The envelope carries only `fmt`, `kind`,
  `collection` and `body`.
- **Depth one.** Every listed address is a `chunk` or `blob-part`, never another
  `ref-index` or a manifest.
- **Bounds.** At most 8,192 addresses (256 KiB) per index and 32 indices per
  snapshot: 262,144 indexed refs, about 131,000 small attachments. The payload is a
  handful of CBOR values whatever its size, so the service's decode budget is
  unchanged.
- **Deterministic.** No salt: the same address list gives the same object, so an
  unchanged index is not uploaded twice.

## 5. Collection keys, epochs and rotation

### 5.1 Keys

| Key | Holder | Use |
|---|---|---|
| `K_e`, collection key of epoch `e` (32 random bytes) | keyed member devices, escrow and the hosted replica in cloud-copy collections | sealing everything of epoch `e`; deriving `K_idem` from `K_1` |
| Device signing key (Ed25519) | one device | signing items and manifests |
| Device KEM key (X25519) | one device | receiving wrapped epoch keys (HPKE) |
| Device Noise key (X25519) | one device's replica | responder static key for client sessions (`replica-client-api.md` §12) |
| Client static key (X25519) | one app installation | initiator static key for client sessions; registered in its grant |
| Control-plane root and policy keys (Ed25519) | the control plane | signing policy (`policy.md` §3) |

- **Separate keys for separate uses.** The signing, KEM and Noise keys are separate
  keys, never converted into each other. That avoids cross-protocol key reuse.
- **Generation and storage.** Device keys are generated on the device from the CSPRNG
  and enrolled with their public halves (`policy.md` §4). Private keys are kept in
  the platform's key store where one exists. Platform-specific key storage remains
  pending in the Obsidian runtime design; this contract fixes only the key types.

### 5.2 Rekey: a new epoch

```cddl
; ---- key items (sealed-envelope.md §5) ----
rekey-payload = {
  0: 1,                  ; fmt
  1: epoch,              ; epoch: the new epoch, from + 1
  2: epoch,              ; from: the current epoch at this position (0 for the first)
  3: hash,               ; commit: MAC(K_kc, "mdbase/v1/key-commit", collection ‖ u32be(epoch)),
                         ;   K_kc = HKDF-SHA256(ikm = K_new, salt = collection, info = "mdbase/v1/key-commit")
  4: [+ key-wrap],       ; wraps: exactly one per recipient (see validity)
  5: sealed-box,         ; history: [[epoch, key], …] for epochs 1..from, sealed with K_new
  6: rekey-reason,
}
rekey-reason = &( initial: 0, device-revoked: 1, member-removed: 2,
                  cloud-copy-off: 3, scheduled: 4, recovery: 5 )

key-wrap = {
  0: uuid,               ; recipient device ID
  1: bstr .size 32,      ; enc: HPKE encapsulated key
  2: bstr .size 48,      ; ct: HPKE ciphertext of the 32-byte epoch key
}

sealed-box = {
  0: bstr .size 16,      ; salt
  1: bstr,               ; ct: §3 steps 1–7 with the given key and AAD
}
```

- **The wrap.** `key-wrap` is HPKE (RFC 9180), base mode, with:
  - KEM DHKEM(X25519, HKDF-SHA256) (`0x0020`);
  - KDF HKDF-SHA256 (`0x0001`);
  - AEAD ChaCha20Poly1305 (`0x0003`);
  - `info = "mdbase/v1/key-wrap" ‖ collection ‖ u32be(epoch) ‖ recipient`;
  - empty AAD.
- **The history box** is sealed with the §3 construction under `K_new`, with
  `aad = "mdbase/v1/key-history" ‖ collection ‖ u32be(epoch)`. A device that holds any
  current epoch key can therefore recover every older one. A device enrolled late can
  read the retained tail, old snapshot chunks and blobs. A revoked device gets
  nothing new.

**Validity** of a `rekey` at `p` (otherwise void, `log-entry.md` §4.3):
- the signer is a keyed, non-revoked device at `p − 1`;
- `from` is the current epoch at `p − 1`, and `epoch = from + 1`;
- the recipients are **exactly** the devices that are enrolled, not revoked and keyed
  at `p − 1` (§5.3), including the escrow and hosted devices when present.

Every replica checks the recipient set deterministically, so no rekey can silently
leave a device out or include a revoked one.

**The `initial` rekey** (`from = 0`) is the one exception, because nobody is keyed yet.
In `e2e`, its signer must be an active device of an owner or editor; no hosted or
escrow device is enrolled or admitted. In a service-created `cloud-copy` collection,
the active hosted device may be the first keyed replica: it generates the epoch key
and signs the initial rekey without any user device. Recipients must be active and
include the signer, hosted and escrow in cloud-copy bootstrap. Devices it leaves
out are keyed later by `key_grant`. The first valid `initial` rekey wins.

**Trusting the first key in `e2e` (local acceptance rule).** Validity says only that the
`initial` rekey was signed by *some* active device of an owner or editor. The control
plane enrols devices, so in an `e2e` collection that is not enough. A device **uses**
an epoch key only if the chain of `rekey` and `key_grant` signers that delivered it
starts at a device it trusts locally:
- itself;
- a device it approved, or that approved it, through the SAS of §5.3;
- the recovery device whose keys it derived itself (§5.4).

The device that turns sync on for a private collection therefore requires that the
`initial` rekey is its own. If another valid `initial` rekey wins the race, it does not
use the key, records a `key_untrusted` incident, stops appending, and reports it to the
user. A device joining later is keyed by the device it compared codes with, so its
trust follows. This rule is local and changes no verdict at replay. Every replica still
applies the same items. It only decides which keys a device seals with and accepts.
In `cloud-copy`, the escrow is trusted by the user's choice, and this rule does not
apply.

**Commitment.** Each recipient, after unwrapping, checks `commit`. A mismatch means
the rekeying device sent it a different key from the others. The recipient records a
`key_inconsistent` incident and asks another device for a `key_grant`. Only a
malicious or broken member device can cause this.

The same check applies to every **`key_grant`**, and to every key recovered from a
history box. The unwrapped key must match the `commit` of the `rekey` that created that
epoch. Otherwise it is not used. ChaCha20-Poly1305 does not commit to its key, so a
member that hands one device a different key could otherwise craft ciphertexts that
open differently on different replicas.

**When to rekey:**
- **`initial`:** once, right after genesis.
- **Required**, after any of these at `p` (`policy.md`):
  - a device revocation;
  - a member removal;
  - turning the cloud copy off (escrow and hosted devices revoked).

  From the first such policy item until a valid `rekey`, the log is in
  **rekey-required** state. `entry` and `base` items appended in that state are void
  (`log-entry.md` V2). So no content is ever sealed under a key a revoked device holds,
  once its revocation is in the log. Writers do the rekey first (`log-entry.md` §3.1
  step 2). Concurrent rekeys race, and the first valid one wins.
- **Optional:** on a schedule (`scheduled`). It limits how much one leaked epoch key
  exposes.

Cloud-copy service bootstrap, account-approved device joins and hosted rekeys use
§7.1. This authority is scoped to the collection's verified cloud-copy policy state;
it does not apply to private collections or replace existing recipient-set,
revocation, signature, epoch and commitment checks.

### 5.3 Enrolment and key grants

```cddl
key-grant-payload = {
  0: 1,                  ; fmt
  1: uuid,               ; recipient device ID
  2: epoch,              ; the current epoch at this position
  3: key-wrap,           ; the current epoch key, wrapped for the recipient
}
```

A device goes through three states, all derived from the log:
1. **Enrolled.** A control-plane `device_enrol` policy item (`policy.md` §4) gives it a
   transport identity and makes its signatures recognisable. It cannot read yet.
2. **Keyed.** It is keyed from the first valid `key_grant` naming it, or the first
   `rekey` that wraps for it. With the current key it opens the history box of the
   `rekey` that created the current epoch, and so obtains every older epoch.
3. **Revoked.** A `device_revoke` policy item.

**Validity** of a `key_grant` at `p`:
- the signer is a keyed, non-revoked device at `p − 1` authorized by collection mode;
- the recipient is enrolled and not revoked;
- `epoch` is the current epoch;
- hosted/escrow delivery is valid only in cloud-copy mode, to a device approved
  through the authenticated account and control-signed membership/enrolment bound
  to this collection, recipient account and device identity;
- in private mode, no hosted/escrow signer or recipient is admitted; user-device
  approval and the existing local trust chain remain mandatory.

**Who may key a new device, by collection state.** This is where the control plane's
trust stops:

| Collection state | Who appends the `key_grant` | User involvement |
|---|---|---|
| Synced end-to-end (Private) | the keyed device of an owner or editor on which the user approved it | **Required.** The user compares a six-digit code on both devices, computed by the commit-then-reveal protocol below. |
| Synced with cloud copy (Standard) | hosted, or escrow if hosted is unavailable; keyed user devices retain their existing authority | Authenticated-account approval and control-signed membership/enrolment; no other user device must be online (§7.1). |

Service-created hosted replicas bootstrap their own epoch in cloud-copy mode.
Converting an existing private collection still requires an owner device to key
hosted (§7.1).
Device approval is a client concern, so the approval UI lives in the replica client
API (`replica-client-api.md` §8.3).

**The approval code (SAS), commit then reveal.** A code computed only from public keys
can be ground. Whoever enrols the device (the control plane) learns the real device's
keys, then generates keypairs until its own device's code matches, which takes about
10^6 tries. The code therefore mixes in a random value from each side, and the new
device commits to its value before it can see the approver's. This is the SAS-MCA
pattern of Vaudenay (2005), as used by ZRTP and Bluetooth numeric comparison.

1. **Commit.** The new device `N` draws `r_N` (32 bytes, CSPRNG) and enrols with
   ```text
   sas_commit = H("mdbase/v1/sas-commit", collection ‖ N ‖ sign_pk_N ‖ kem_pk_N ‖ noise_pk_N ‖ r_N)
   ```
   in its `device-enrol` (`policy.md` §4.2, key 7). `N` checks that its own enrol item
   in the log carries exactly its keys and this commitment.
2. **Challenge.** The approving device `A` sees the enrol item in its own view, and only
   then draws `r_A` (32 bytes) and sends it to `N`. The two devices exchange `r_A`,
   `r_N` and their IDs over any channel (the relay or a notification). The channel needs
   no integrity: tampering only produces mismatching codes.
3. **Reveal.** `N` sends `r_N`. `A` checks it against `sas_commit`, and aborts on a
   mismatch. **`N` reveals a given `r_N` at most once**, in answer to the first
   challenge it accepts. After that it refuses every further challenge until it has
   committed to a fresh `r_N` (`approval-request`, below). Once `r_N` is public, an
   attacker relaying a later challenge could pick its `r_A` by grinding (about 10^6
   tries) so that `N`'s code equals the one `A` shows for the attacker's own device.
   An attacker can always send the first challenge itself. That only costs a retry,
   because the code it causes `N` to show is unrelated to any code an honest approver
   shows.
4. **Display.** Both devices show
   ```text
   sas = u32be(first 4 bytes of H("mdbase/v1/sas", collection ‖ A ‖ N ‖ sign_pk_A ‖ sign_pk_N
                                   ‖ kem_pk_N ‖ noise_pk_N ‖ r_A ‖ r_N)) mod 1,000,000
   ```
   as six digits. Each device takes the keys from the enrol items in its own view of
   the log.
5. **Approve.** The user confirms on `A` that the codes match. `A` appends the
   `key_grant` for `N`.
6. **Accept.** `N` uses the key from its first `key_grant` only if `A` signed it (the
   §5.2 local acceptance rule). That stops a forked log from keying `N` from an
   attacker's device.

The commitment is fixed before `r_A` exists, so an attacker that substitutes a device
matches the code with probability 10^-6 per attempt. `A` allows at most 3 failed
attempts per commitment. **A fresh commitment** (after a revealed `r_N`, a failed or
abandoned approval, or a restart that lost `r_N`) is appended as a policy op
`approval-request {device, sas_commit}` (`policy.md` §1). The new device asks for it
through the control plane, and it replaces the device's current commitment. Device
IDs are never reused, so this is the only way to retry. `N` checks its own
`approval-request` in the log as in step 1. `A` uses the latest commitment in its view,
and draws `r_A` only after seeing it. A control plane that appends a commitment of its
own makes `N`'s check fail, so `N` shows no code, and the approval fails. Where both devices have a
camera, `A` may instead scan a QR code holding `N`'s full key fingerprint
`H("mdbase/v1/sas", …)` (all 32 bytes), with no digits to compare.

### 5.4 The recovery device

A recovery key is offered when a private collection is set up; it is recommended but
skippable. It is modelled as a device of kind `recovery` (`policy.md` §4.2), held on
paper by the user.

- **The secret.** `R` is 32 bytes from the CSPRNG, shown once as `MDB1-` followed by
  Crockford base32 of `R ‖ check` in groups of five. `check` is the first 2 bytes of
  `H("mdbase/v1/recovery-key-check", R)`. It only catches typos, and adds no security.
  Setup asks the user to type the last group back. It is never sent anywhere in
  the clear. In the default private mode it is the **account key** (AK1): one `R` per account, which
  the control plane stores only sealed under the user's encryption password
  (Argon2id, XChaCha20-Poly1305, bound to the account). In strict mode no sealed
  copy exists.
- **Its keys:**
  ```text
  seed_sign = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-sign")   ; Ed25519 seed
  seed_kem  = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-kem")    ; X25519 secret
  device ID = first 16 bytes of H("mdbase/v1/recovery-id", collection ‖ sign_pk)
  ```
  `noise_pk` is 32 zero bytes. Routing never lists the recovery device, and Noise
  rejects an all-zero static key.
- **Enrolment.** The setting-up device asks the control plane to enrol it. Before it
  keys the recovery device with a `key_grant`, and before any `rekey` it signs includes
  it, the device checks that the `device-enrol` carries exactly the derived keys. A
  control plane that substitutes its own `kem_pk` is therefore never keyed. Devices
  trust the recovery device under the §5.2 rule because a trusted device keyed it.
- **Use.** On a new device, the user types `R`. The device:
  1. derives the keys;
  2. unwraps the current epoch from the recovery device's wrap;
  3. checks `commit`;
  4. signs a `key_grant` for itself *as the recovery device*.

  The user then revokes the lost devices and the used recovery device. The resulting
  rekey (reason `recovery`) excludes them. Setup offers a new recovery key.
- **Revocation alert.** A `device-revoke` of the recovery device that no device of the
  user requested is shown as an alert on every device. Otherwise the control plane
  could remove recovery silently.

## 6. Signatures

- **Algorithm.** Ed25519 (RFC 8032), signing the 32-byte domain-separated digest of
  §2.2 or `policy.md` §3.
- **Verification is strict and deterministic**, because replicas evaluate it at replay
  and must all agree. It uses cofactorless verification `[S]B = R + [k]A`. A
  signature is rejected when:
  - `S ≥ L`;
  - `A` or `R` is a non-canonical point encoding;
  - `A` or `R` is a small-order point.

  This is the `verify_strict` behaviour of `ed25519-dalek` 2.x, which both native and
  WASM builds use. Implementations in other languages MUST match it on the
  `conformance/wire/ed25519/` edge-case vectors.
- **Who signs what:**

  | Signer | Signs | Key known to verifiers from |
  |---|---|---|
  | device | `entry`, `rekey`, `key_grant`, `grant_approval`, `base`, `manifest`, head witnesses (`log-entry.md` §11) | its `device_enrol` policy item |
  | recovery device | `rekey`, `key_grant` | its `device_enrol` (kind `recovery`) |
  | control plane | `policy` | the policy key certificate embedded in the item, chained to the root key (`policy.md` §3) |
  | escrow | `rekey`, `key_grant` | its `device_enrol` (kind `escrow`) |
  | ephemeral message sender | nothing (§9) | — |

- **What the log service checks.** It verifies signatures before accepting a log item
  (`log-service-api.md` §4), as defence in depth and to stop garbage from a stolen
  transport token. **Replicas verify again.** Their verdict, at replay, is the
  authoritative one.

## 7. Escrow and the cloud copy

A **cloud copy** means mdbase holds the collection key through an
**escrow** device, and may run a hosted replica.

- **The escrow device** is enrolled by policy with kind `escrow`.
  - Its KEM and signing private keys live in the escrow service, encrypted under a
    KMS key, and are used only inside that service.
  - It receives a wrap in the service-created initial epoch and subsequent rekeys.
  - In cloud-copy mode, if hosted is unavailable, it can wrap the current epoch key
    to an authenticated-account-approved device. No existing user device must be
    online. This does not create any escrow authority in private mode.
- **The hosted replica** is an ordinary replica with an ordinary device identity.
  Its plaintext collection-DO cache is disposable and rebuildable from snapshot
  and log. In cloud-copy mode it may generate the first epoch, key approved
  account devices and perform rekeys. KMS custody alone does not authorize these
  operations: collection mode, policy, identity and key-delivery checks do.

### 7.1 Cloud-copy creation, device joins and rekeys

**Service-created cloud-copy workflow.** This supersedes the earlier owner-desktop-only
workflow. Cloud copy already trusts mdbase with plaintext hosting and an escrowed key;
it must work without a desktop.

1. **Service-created collection.** The control plane creates cloud-copy policy for
   the account and enrols hosted (kind 4) and escrow (kind 5), without a user device.
   Hosted is the first keyed replica: it generates the collection/epoch key and
   signs the initial rekey with wraps for hosted and escrow. The control plane
   authors policy, not the collection key. Apps may use hosted after the valid
   bootstrap and existing grant/admission checks.
2. **Account-approved device join.** A daemon, Obsidian, browser or mobile replica
   is approved through the authenticated account, with control-signed membership
   and device enrolment bound to its account and collection. Hosted, or escrow if
   hosted is unavailable, delivers the current epoch key to that device. No other
   user device must be online. Enrolment alone, a transport token, or a request's
   claimed mode is not sufficient authority to receive a key.
3. **Cloud-copy rekeys.** Hosted may perform rekeys as well as owner desktops,
   subject to ordinary active/keyed signer, recipient, revocation and epoch checks.
   A replacement device still needs valid key delivery and policy admission;
   no unkeyed identity can append a valid ordinary rekey.
4. **Hosted migration.** Existing hosted collections use this same cloud-copy
   bootstrap/key-delivery mechanism. There is no separate one-time owner-wrap
   exception. Migration source, base, fencing and acknowledged-write preservation
   checks remain required.

**Private (`e2e`) is structurally separate and unchanged.** No active hosted or
escrow identity exists in committed private policy, and neither can send or
receive its epoch keys. Revoked/inactive service rows from an earlier cloud-copy
state remain as replay history, not service authority; conversion does not purge
them. Private key delivery remains between the user's devices
under the existing approval and trust rules. Cloud-copy service authority must
never be inferred for a private collection from a token, device kind or caller flag.

- **Cloud copy → private:** revoke/exclude hosted and escrow, then a user device
  rekeys without either service recipient. Existing service-held old keys do not
  become secret again; §7.3 describes re-sealing retained content.
- **Private → cloud copy:** the owner initiates the transition and a keyed owner
  device keys hosted. Service-created bootstrap does not replace this existing-key
  handover or let a service generate a replacement for private epoch history.

Recovery of the same device's KMS-wrapped private keys is identity custody, not
collection-mode authorization or evidence that it holds the current epoch.

### 7.2 Turning the cloud copy off

1. The control plane appends policy that sets the state to end-to-end and revokes the
   escrow and hosted devices. That puts the log into rekey-required.
2. A keyed user device rekeys without any hosted or escrow recipient. A service
   cannot perform this private-mode rekey.
3. The hosted replica's disposable plaintext cache is deleted, and the escrow service deletes its
   private keys.

**What this protects.** Content sealed after the rekey. Ciphertext under older epochs
that the service still retains stays decryptable with keys mdbase held. §7.3 removes
that.

### 7.3 Re-seal

An optional maintenance job, run by a keyed device, re-uploads:
- every live blob;
- a fresh snapshot under the current epoch.

The log service's garbage collection then deletes the unreferenced old objects
(`log-service-api.md` §6.2), and compaction drops the old tail. It is offered after
cloud copy off and after a suspected key leak.

## 8. What the log service necessarily sees

| The service sees | Because | Mitigation |
|---|---|---|
| Collection ID, and which devices and accounts belong to it | routing, ACL, quotas | IDs are UUIDs; device labels never enter the log |
| Policy items in full: device public keys, roles, grants, app installation IDs, collection state | it enforces them (`policy.md` §6); the control plane authors them | holds no collection content |
| Each item's kind, position, append time, epoch, signer device | ordering, conditional append, signature check | — |
| Item and object sizes, padded | storage | Padmé (§3); compression contexts never span unrelated records outside snapshot chunks |
| Idempotency tokens | duplicate detection | MAC of the mutation ID: equality only |
| Object addresses, sizes and upload times, and which items and snapshots reference them (`refs`) | integrity, GC | snapshot objects: hashes of ciphertext with fresh salts. Blob parts: keyed addresses (§4.2), so identical files are linkable only within one collection and epoch, as two references to one blob, never to outside content |
| A file's size, to within a part (8 MiB) plus Padmé padding of the last part | storage | — |
| Snapshot positions and frequency | compaction | — |
| Connections, IP addresses, online times, subscription activity | transport | — |
| Ephemeral stream IDs, participants, message sizes and rates | relaying presence | stream IDs are per-record pseudonyms under the epoch key (`log-service-api.md` §8) |
| **Never:** record content, paths, field names, types, record IDs, link structure, which record an entry touches | — | sealed |

**The compression oracle.** Compress-then-encrypt can leak content through size when
an attacker can inject chosen text next to a secret in one compression context and
observe sizes (CRIME/BREACH). Here:
- each `entry` is compressed on its own. Its texts belong to the mutation's records,
  and the size observer is the log service operator, not an app;
- a snapshot chunk compresses many records together. A create-only app colluding with
  the operator could inject text and watch chunk sizes, but each observation costs a
  snapshot, and snapshots are written every few thousand entries. That makes an
  adaptive attack impractical.

Collections that want certainty can turn compression off in their collection policy
(`policy.md` §4.5, `compress: false`), and writers then use algorithm 0. This is
accepted as a residual risk (`open-questions.md` Q17).

## 9. Ephemeral messages

Ephemeral stream messages (presence, future room updates) use the envelope with kind
`ephemeral`:
- sealed under the current epoch key;
- AAD binding the stream ID;
- `signer` set to the sending device, which the service authenticates at transport.

They carry no signature. Inside a collection, members trust each other's devices, and
a forged presence message by a member is low-stakes. Thin clients' presence is sent by
their replica, which tags it with the client's grant ID inside the sealed body
(`replica-client-api.md` §11).
