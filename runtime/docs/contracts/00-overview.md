# Phase 0 contracts: overview

Status: draft for review, 2026-10-04.

These documents fix the wire formats, the log service API and the replica client API
that the rest of mdbase-next is built against. They are normative: the `wire` crate,
the replica service, the log service on either D2 candidate and the TS SDK implement
them, and the golden fixtures in `conformance/wire/` are checked against them.

| Document | What it fixes |
|---|---|
| `00-overview.md` (this file) | Principles, canonical encoding, hashing, identifiers, time, versioning and compatibility |
| `intent.md` | The mutation and every operation it can carry |
| `log-entry.md` | What is appended: payload, results, apply and verify, conditional append, idempotency, limits, text deltas |
| `sealed-envelope.md` | The item envelope, sealing, compression and padding, key epochs and rotation, signatures, escrow, metadata leakage |
| `snapshot.md` | Manifest, chunks, side tables, progressive install, compaction, receipts horizon, join from existing files |
| `policy.md` | Control-plane-signed policy: devices, members, grants, revocation, deterministic evaluation, migration cutover |
| `log-service-api.md` | The blind log service: append, read, push, objects, snapshots, ephemeral streams, auth, quotas, errors |
| `replica-client-api.md` | What apps and plugins call on a replica: queries, subscriptions, submit, status, holds, conflicts, presence, errors, transports |
| `timer-service-api.md` | The control plane's opaque timer service for app notifications (JSON over HTTPS; no wire types) |
| `open-questions.md` | Choices made provisionally, with the answer these documents assume |

**Out of scope here.** The `Store`, `FilePlatform` and `IndexStorage` interfaces are
Phase 0 deliverables too, but they are not in these documents. `FilePlatform` and
`IndexStorage` depend on platform work for Windows publishing, macOS publishing, and
webview indexing. Where a contract here touches them, it fixes only the parts those
implementations cannot change. The editor fence appears in the replica client API only
as a callback a plugin client offers.

## 1. Principles

1. **One encoding, one hash, one AEAD construction, one signature scheme.** Everything
   that is hashed, signed, sealed or exchanged uses the canonical CBOR profile in §3,
   SHA-256, the payload construction in `sealed-envelope.md` §3, and Ed25519. Fewer
   choices mean fewer cross-implementation mismatches. That matters doubly because
   replicas re-execute entries and compare results.
2. **Bytes are kept, never re-encoded.** A signed or sealed object is stored, forwarded
   and verified as the bytes its author produced. No intermediary decodes and
   re-encodes it. That is what lets unknown fields survive and keeps signatures valid
   across versions.
3. **Nothing in a replayed computation reads a clock or a random source.** Planning
   reads time and entropy only from the mutation (`intent.md` §4). Entropy and time
   reach the core and the replica only through injected interfaces.
4. **The log decides order; results decide state.** An entry's position comes from the
   conditional append. Its effects come from the writer's planning at that exact
   position. Replicas apply recorded results and may re-execute them to check
   (`log-entry.md` §5). Determinism is checked continuously, and convergence does not
   depend on it.
5. **The log service is blind.** It sees routing metadata, sizes and timing, listed in
   `sealed-envelope.md` §8. It never sees collection content. Policy entries are in
   clear because the control plane authors them and the log service must enforce
   them; they hold no collection content.
6. **Third-party apps never hold collection keys.** They talk to a replica, which
   enforces their grant (`policy.md` §5, `replica-client-api.md`).
7. **Errors are few and actionable.** Apps see 15 error codes, each with one recovery
   action (`replica-client-api.md` §9). Transient internal states are handled by the
   replica, or reported as status and stream events, not as errors.
8. **Well-known primitives and constructions only.** SHA-256, HMAC, HKDF (RFC 5869),
   ChaCha20-Poly1305 (RFC 8439) in the age v1 STREAM payload construction, HPKE
   (RFC 9180), Ed25519 (RFC 8032), X25519, Noise IK, raw DEFLATE (RFC 1951) and Padmé
   padding. No custom cryptographic constructions.

## 2. The formats and who handles them

| Format | Produced by | Consumed by | Hashed or signed? | Defined in |
|---|---|---|---|---|
| Mutation (intent) | client SDK, replica (API and ingest) | replica planner | inside a signed entry | `intent.md` |
| Entry payload (kind `entry`) | writer replica | every replica | sealed, then signed | `log-entry.md` |
| Policy payload (kind `policy`) | control plane | log service, every replica | signed, in clear | `policy.md` |
| Key items (kinds `rekey`, `key_grant`) | device replica, escrow | every replica | signed, in clear (key material wrapped) | `sealed-envelope.md` §5 |
| Base item (kind `base`) | the adopting replica | every replica | sealed, signed | `snapshot.md` §7 |
| Item envelope | all the above | log service, replicas | signature covers it | `sealed-envelope.md` §2 |
| Snapshot manifest, chunks, blob parts | replicas | replicas (log service stores them) | sealed; the manifest is also signed | `snapshot.md`, `sealed-envelope.md` |
| Ephemeral stream message | replicas | replicas (log service relays) | sealed | `log-service-api.md` §8 |
| Log service requests and responses | replica, control plane | log service | not hashed | `log-service-api.md` |
| Client API messages | apps, plugins, replicas | replicas, apps | not hashed; Noise-encrypted when remote | `replica-client-api.md` |

## 3. Canonical encoding: the `mdb-cbor/1` profile

### 3.1 Decision

Every format in these contracts is encoded as **CBOR (RFC 8949) restricted to the
deterministic profile below**. That includes client API and log service messages, not
just the hashed formats. Encoders always produce canonical bytes. Decoders reject
non-canonical bytes everywhere. One codec is used for everything.

**Why CBOR rather than JCS JSON (RFC 8785).** The comparison that decided it:

| Concern | Deterministic CBOR profile | JCS JSON |
|---|---|---|
| **Determinism** | Integers and lengths in shortest form, floats always 64-bit, struct maps sorted by small integer keys. Any RFC 8949 deterministic encoder agrees, because RFC 7049 length-first and RFC 8949 bytewise key orders coincide for unsigned integer keys. | Numbers must be printed with the ECMAScript `Number.toString` algorithm. Implementations get this wrong at the edges, and Rust needs a dedicated serializer. Keys are sorted by UTF-16 code units, which differs from Rust's natural byte order for non-BMP keys. |
| **Integers vs floats** | Distinct major types. `1` and `1.0` survive the round trip, and so do integers above 2^53. | One number type. Integers above 2^53 lose precision in JS, and `1.0` becomes `1`. YAML frontmatter distinguishes these, and the planner's output bytes depend on them. |
| **Key order of user data** | User maps keep their order (rule 6 below). Frontmatter key order is semantic: new keys are appended in patch order (spec 12A, format fidelity rule 4). | JCS sorts every object, which destroys frontmatter order. Every user map would need an array-of-pairs encoding. |
| **Binary fields** | Native byte strings for hashes, signatures, salts, ciphertext and keys. | Base64, a third more bytes plus a choice of alphabet and padding to pin down. |
| **Size** | Markdown is carried as raw UTF-8. Struct keys are one byte. | Markdown is escaped (`\n`, `\"`), and every key name is repeated in every object. |
| **TS and WASM** | In WASM, the codec is a few hundred lines of Rust (no serde_json in the hot path). In TS, a small strict decoder plus a `Map`-based value model; thin clients need only that and Noise. | JSON is native in JS, but canonicalization is not, and `JSON.parse` loses large integers and key order for integer-like keys. |
| **Debuggability** | Needs a tool. Every message can be dumped as CBOR diagnostic notation (RFC 8949 §8) with field names, via `mdb-wire dump`, a deliverable of the wire crate. Golden fixtures are checked in with their annotated diagnostic form beside the bytes. | Readable as is. |

Debuggability was the only point in JSON's favour, and a schema-aware dump tool covers
it.

### 3.2 Profile rules

A byte string is valid `mdb-cbor/1` if and only if every data item in it obeys these
rules. A generic validator can check all of them without knowing the schema.

1. **Definite lengths only.** No indefinite-length strings, arrays or maps.
2. **Shortest-form heads.** Every integer, length and tag argument uses the shortest
   encoding (RFC 8949 §4.2.1 "preferred serialization").
3. **Integers** are major types 0 and 1, within −2^63 … 2^64−1. Bignums (tags 2 and
   3) are not allowed.
4. **Floats** are always encoded as IEEE 754 binary64 (`0xfb`), never shortened. NaN
   and ±infinity are invalid. Negative zero is kept as is. Always using 64-bit makes
   float encoding trivial and identical in every implementation, and floats are rare
   in frontmatter.
5. **Simple values** are `false`, `true` and `null` only. `undefined` is invalid.
6. **Maps come in two kinds, told apart by their key types.**
   - **Struct maps**: every key is an unsigned integer. Keys must be strictly
     ascending.
   - **Data maps**: every key is a text string. Keys must be distinct (by exact
     bytes). Order is the order of the data and is significant: it is part of the
     value. Encoders keep insertion order.

   A map with keys of mixed or other types is invalid. The empty map is valid as
   either kind.
7. **Text strings** must be valid UTF-8. No Unicode normalization is applied anywhere
   in the encoding. Paths and documents keep their exact bytes.
8. **No tags.** Tag numbers are not used in `mdb-cbor/1`. A future version may allow
   specific tags; until then any tag is invalid.
9. **One top-level item.** No trailing bytes.

Canonical form means: given a value of the schema, there is exactly one encoding. The
schemas below never offer two encodings for one meaning. For example, an absent
optional field is always encoded by omitting the key, never as `null`, unless `null` is
itself a meaningful value of that field.

**Decoder obligations.**
- Reject input that breaks the profile (`invalid` / `invalid_request`).
- Decode data maps into an order-preserving map. In TS this means `Map`, never a plain
  object: object property order puts integer-like keys first.
- Decode integers outside ±2^53 as `bigint` in TS.
- Ignore unknown keys in struct maps (§6.2), but never re-encode an object that was
  received. Forward or store the original bytes.

### 3.3 Schema notation

Schemas are given in CDDL (RFC 8610). Struct maps use integer keys with the field name
in a comment:

```cddl
example = {
  0: uint,          ; fmt
  ? 1: tstr,        ; name (optional)
}
```

`wire.cddl` (generated from the `cddl` blocks of these documents by
`scripts/extract-cddl.sh`) is the single machine-readable schema. The wire crate's tests
validate every golden fixture against it.

### 3.4 Common types

```cddl
; ---- common types (00-overview.md §3.4) ----
uuid = bstr .size 16            ; RFC 9562 UUID, network byte order
hash = bstr .size 32            ; SHA-256 digest
signature = bstr .size 64       ; Ed25519 signature
seq = uint                      ; log position, 1-based; 0 means "before the first item"
epoch = uint                    ; collection key epoch, 1-based
time-ms = int                   ; milliseconds since 1970-01-01T00:00:00Z, UTC, no leap seconds
sem = [major: uint, minor: uint]   ; semantics version (§6.3)
version = [major: uint, minor: uint]
path = tstr                     ; collection-relative path, "/" separated, exact bytes
int64 = -9223372036854775808..9223372036854775807

; A frontmatter or app value: the JSON data model plus an int/float distinction.
; Data maps keep their order (profile rule 6).
value = null / bool / int64 / float64 / tstr / [* value] / { * tstr => value }
```

`value` is the data model of frontmatter (spec Chapter 03) as the core parses it from
YAML: integers fit in 64 bits, floats are finite binary64, and everything else is a
string. A YAML integer outside the int64 range is not representable as a `value`. How
the core parses one is an open question (`open-questions.md` Q4).

## 4. Hashing and domain separation

- **Hash function:** SHA-256 everywhere. It is what spec revisions and `body_base`
  already use (spec Chapter 12, `sha256:` tokens), it is in WebCrypto, and it is fast
  enough. BLAKE3 would be faster but adds a second hash for no needed gain.
- **Text form:** `sha256:` followed by 64 lowercase hex digits, as in the spec. On the
  wire a hash is the 32 raw bytes (`hash`).
- **Revision of a document or file:** `SHA-256(exact bytes)`, with no domain tag, so
  it equals the spec's revision token and `body_base`.
- **Every other hash and MAC is domain-separated:**

  ```text
  H(tag, m)        = SHA-256( u8(len(tag)) ‖ tag ‖ m )
  MAC(k, tag, m)   = HMAC-SHA256( k, u8(len(tag)) ‖ tag ‖ m )
  ```

  `tag` is an ASCII string from the registry below. `‖` is concatenation, `u8` and
  `u32be` are fixed-width big-endian integers. A new use gets a new tag; tags are never
  reused with a different meaning.

| Tag | Used for | Defined in |
|---|---|---|
| `mdbase/v1/item-sig` | message signed by a log item's signature | `sealed-envelope.md` §6 |
| `mdbase/v1/native-backup-completion` | independently authorized native archive capture completion; canonical map without signature key 12, not live permission | `crates/backup-verify/src/completion.rs`, `crates/backup-verify/tests/vectors/completion-v1.txt` |
| `mdbase/v1/chain` | chain hash of a log item | `sealed-envelope.md` §2.3 |
| `mdbase/v1/payload` | HKDF info for the per-object payload key | `sealed-envelope.md` §3 |
| `mdbase/v1/key-wrap` | HPKE `info` for wrapping an epoch key | `sealed-envelope.md` §5 |
| `mdbase/v1/key-commit` | key commitment in `rekey` | `sealed-envelope.md` §5 |
| `mdbase/v1/key-history` | AAD of the key history box | `sealed-envelope.md` §5 |
| `mdbase/v1/sas` | short authentication string for device approval | `sealed-envelope.md` §5.3 |
| `mdbase/v1/idem` | idempotency token key and token | `log-entry.md` §7 |
| `mdbase/v1/content-id` | HKDF info for the per-epoch content-addressing key | `sealed-envelope.md` §4.2 |
| `mdbase/v1/blob-id` | keyed blob ID | `sealed-envelope.md` §4.2 |
| `mdbase/v1/blob-part` | keyed blob part address | `sealed-envelope.md` §4.2 |
| `mdbase/v1/gen` | generated-value stream from the mutation seed | `intent.md` §4.3 |
| `mdbase/v1/stream-id` | ephemeral stream identifiers | `log-service-api.md` §8 |
| `mdbase/v1/state-digest` | snapshot state digest | `snapshot.md` §4 |
| `mdbase/v1/cp-cert` | control-plane key certificate | `policy.md` §3 |
| `mdbase/v1/client` | Noise prologue for client sessions | `replica-client-api.md` §12 |
| `mdbase/v1/sas-commit` | new device's SAS commitment | `sealed-envelope.md` §5.3 |
| `mdbase/v1/recovery-sign`, `mdbase/v1/recovery-kem`, `mdbase/v1/recovery-id`, `mdbase/v1/recovery-key-check` | recovery key derivation and typo check | `sealed-envelope.md` §5.4 |
| `mdbase/v1/account-key-id`, `mdbase/v1/account-key-bundle`, `mdbase/v1/account-key-proof`, `mdbase/v1/account-key-rewrap` | account key id; password-sealed bundle AAD; proof-key derivation (HKDF info) and the bundle-replacement proof | `ship/interfaces/2026-10-06-private-account-key.md` §2 |
| `mdbase/v1/account-key-fetch`, `mdbase/v1/account-key-put`, `mdbase/v1/account-key-strict`, `mdbase/v1/account-key-device`, `mdbase/v1/account-key-enrol` | control-plane device proofs for account-key storage and recovery-device enrolment (proof of possession) | `ship/interfaces/2026-10-06-private-account-key.md` §5 |
| `mdbase/v1/client-fp` | client key fingerprint shown at grant approval | `policy.md` §5.1 |
| `mdbase/v1/head-witness` | signed head witness | `log-entry.md` §11 |
| `mdbase/v1/head-witness-code` | out-of-band comparison code for a common position | `log-entry.md` §11 |
| `mdbase/v1/ctl-chain` | control-item accumulator | `snapshot.md` §8.1 |
| `mdbase/v1/ls-hello`, `mdbase/v1/ls-http` | log-service proof of possession (hello, HTTPS request) | `log-service-api.md` §3 |
| `mdbase/v1/cp-key-revoke` | root signature revoking a policy key | `policy.md` §1 |
| `mdbase/v1/root-handover` | owner device's consent to a root handover | `policy.md` §2.1 |
| `mdbase-next/desktop-manifest/v1` | exact-byte desktop manifest signature message | `crates/daemon/src/update`, packaging updater-policy interface |
| `mdbase-next/desktop-keyset/v1` | exact-byte recovery key-set signature message | `crates/daemon/src/update`, packaging updater-policy interface |

## 5. Identifiers

All identifiers that name an entity are 128-bit UUIDs (RFC 9562): 16 bytes on the wire,
canonical lowercase hyphenated text (`8-4-4-4-12`) in text APIs.

| Identifier | Version when minted | Minted by | Notes |
|---|---|---|---|
| Collection ID | any (existing Connect collections keep theirs) | control plane, or the device that turns sync on | Also in the v2 role marker (`collection`). |
| Record ID | v7 | the replica that creates or first ingests the record, or the client SDK for a create | **Never written into files** (spec 12A). Connect's existing record IDs are UUIDs and are kept at migration without reminting them. |
| File ID | v7 | as record IDs | Identity of a non-record file (attachment), same rules. |
| Mutation ID | v7 | the client SDK or the replica, once per logical write | Idempotency key, scoped to the collection. Its timestamp also drives the receipts horizon (`snapshot.md` §6). |
| Device ID | v4 | the device, at enrolment | The signing identity of a writer. One per installation, shared by the device's replicas of all its collections. |
| Replica ID | v4 | the replica, when its state is created | Identifies one replica's state for one collection on one device. A reset or rejoin mints a new one. Recorded as a mutation's `origin`, and in the v2 role marker (`replica_id`). |
| Grant ID, app installation ID, account ID | any | control plane | Opaque to replicas. |
| Control-plane key ID | derived | — | First 16 bytes of `SHA-256(public key)`. |

**Why UUIDv7.** It is the standard time-ordered 128-bit identifier. It has the same
layout as a ULID (48-bit millisecond time, then random bits) with a version field. It
is the same width and text form as Connect's existing UUID record IDs, so legacy and
new IDs coexist with no union type. New records and mutations sort by creation time,
which suits B-tree indexes.

The 74 random bits of a v7 ID come from the CSPRNG through the injected entropy
interface. Its time comes from the injected clock. Record IDs minted *during*
planning come from the mutation's generated-value stream instead, so re-planning mints
the same IDs (`intent.md` §4.3).

Lifecycle `{ ulid: true }` and `{ uuid: true }` values are user data written into
frontmatter. They are not identifiers in this sense and keep the spec's text formats.

**Other names.**
- Log positions are `seq`, starting at 1.
- Key epochs start at 1.
- Object addresses are 32 bytes: the SHA-256 of a snapshot object's bytes, or a keyed
  content address for blob parts (`sealed-envelope.md` §4).
- A **path key** (spec Chapter 02: NFC, then case-fold) is derived, never stored as
  identity.

## 6. Versioning and compatibility

Four independent version axes. Each has its own rule.

| Axis | Where | Changes when | Compatibility rule |
|---|---|---|---|
| **Format version** `fmt` | key 0 of every item envelope and every payload | the encoding of a format changes incompatibly | Readers support every `fmt` that can still be in a retained log, snapshot or policy history (§6.4) |
| **Semantics version** `sem` | every entry payload | the planner's output for some input could change | Results of any `sem` are applied. Re-execution checks only entries of equal `sem`. Major versions ratchet (§6.3). |
| **Client API version** `api` | `hello` handshake | messages or behaviour of the client API change | Negotiated. A replica serves the current minor and the two previous minors of its major (N-2). |
| **Log service API version** | URL prefix `/v1/` and `hello` | service requests change | Same N-2 rule. The service is deployed centrally, so the window only covers replica update lag. |

### 6.1 Format versions

`fmt` is a single unsigned integer, the format's major version. Additive changes don't
change it (§6.2). A reader that meets an unknown `fmt`:

- for a **log item**: stops applying at that position. This is a **stall**, surfaced as
  status `upgrade_required` (`replica-client-api.md` §7). It is not a void: a newer
  writer may have appended a perfectly valid item. The replica keeps serving reads at
  its last applied position, and its local writes stay pending.
- for a **snapshot**: does not install it, and falls back to an older retained snapshot
  if one exists, or stalls.
- for a **message** (client API, log service): rejects it with `upgrade_required`.

### 6.2 Unknown fields and unknown variants

1. **Unknown struct keys are ignored.** A new optional field is an additive change and
   needs no version bump. Because objects are never re-encoded (principle 2), unknown
   fields survive storage and forwarding, and signatures over them stay valid.
2. **Unknown variants are critical.** Every tagged union in these schemas (operation
   kinds, effect kinds, policy kinds, item kinds, text forms) has a discriminator at
   key 0. A reader that meets an unknown discriminator value cannot know what the
   object does. For a log item that is a stall at that position (as §6.1), never a
   skip. For a message it is `upgrade_required`.
3. **A new field that old readers must not ignore is therefore introduced as a new
   variant**, or with a `fmt` bump. This rule replaces JOSE-style `crit` lists: the
   discriminator already marks what is critical.
4. **Unknown data-map keys are data.** Frontmatter keys are never "unknown".
5. **Enumerated integers** (status, source, levels) are critical in the same way.
   Unknown values are treated as unknown variants.
6. Writers must not emit a field or variant that a reader of the same `fmt` and the
   oldest supported `sem` cannot interpret, unless that reader is meant to stall. The
   release process enforces this by running the previous two releases' decoders
   against new fixtures.

### 6.3 The semantics version

`sem = [major, minor]` names the behaviour of the planner: intent planning, merge,
lifecycle, path rules, link rewriting and the CEL and regex profiles, as far as they
affect what an entry records. It is not the crate version. A registry in the core
crate (`core::SEMANTICS`) records, for each `sem`:
- the spec version it implements (rc.5 is `sem [1, 0]`);
- the tzdb release it embeds, if any (`open-questions.md` Q6).

- **Minor:** fixes and refinements whose old and new behaviour may safely interleave
  in one log. Writers of different minors may append side by side. A verifier
  re-executes only entries whose `sem` equals its own and counts the rest as
  "unverified" (`log-entry.md` §5).
- **Major:** a change that must not interleave with the old behaviour, for example a
  new merge strategy that old planners would silently ignore. **Majors ratchet:** the
  log's semantics major is the highest `sem.major` of any applied entry. A replica
  whose `sem.major` is lower:
  - must not append. An entry with a lower major than the ratchet at its position is
    void (`log-entry.md` §4.3), so old writers can't sneak in.
  - still applies new entries, because results are format-level.
  - **Version-skew rule:** an older runtime in a shared runtime
    attaches as a client to a newer host instead of hosting
    (`replica-client-api.md` §13).
- A collection can also declare features it requires in its catalog. That is a spec
  concern, not covered here; a planner that meets an unknown required feature refuses
  to plan, which acts like a ratchet for that collection.

### 6.4 Support windows (N-2)

- **Client API:** a replica serves its current minor and the two previous minors of its
  major. A major change ships with one release that serves both majors.
- **Log service API:** the same rule, from the service's side.
- **Log items and snapshots:** a reader must decode every `fmt` that can still be in a
  retained log tail or in a retained snapshot. Policy and key items are never compacted
  (`snapshot.md` §5), so **their decoders are kept forever**; their formats must stay
  small and change rarely. A release may drop an old *entry* `fmt` only after:
  - the release two versions back started writing snapshots in the newer format; and
  - the retention window has rolled over (`snapshot.md` §5), so no retained tail still
    holds the old format.
- **Semantics:** results of every `sem` are always applicable. Planners exist only for
  their own `sem`.

## 7. Time

**Decision: no hybrid logical clock.** Order comes from log positions alone. No
correctness property depends on a timestamp: not merge, not ordering, not
authorization. Time is data: the instant the writer's lifecycle uses for `now`/`today`,
and the creation time inside UUIDv7s.

- **Clock source.** The replica and core read time only through the injected `Clock`
  interface (S5 portability rules). Tests and the simulator drive it.
- **Captured once.** A mutation captures its instant once, at submit, at the origin
  (`intent.md` §4.1). Every lifecycle provider and every re-plan of that mutation uses
  it. Replay never reads a clock.
- **Monotonic clamp.** When capturing, the origin uses
  `max(clock.now_ms(), latest op_time it has applied + 1)`. That stops lifecycle `max`
  merges from moving `dateModified` backwards because one device's clock runs slow. It
  is the useful half of an HLC (the physical part) without logical counters, which
  nothing here would read.
- **Representation.** `time-ms` on the wire; RFC 3339 with milliseconds and `Z` in text
  (spec Chapter 09 `now`).
- **Calendar dates** (`today`) are computed once, at the origin, and carried in the
  mutation (`intent.md` §4.1). Replay needs no time-zone database for them.
- **The log service's clock** is used only for `appended_at` (informational,
  untrusted), quotas, token expiry and retention.

## 8. Golden fixtures

`conformance/wire/<format>/<case>.cbor` holds canonical bytes. `<case>.diag` holds the
annotated diagnostic notation. `<case>.json` holds a debug JSON view: field names, hex
byte strings, and data maps as arrays of pairs. Item envelopes also get
`<case>.hashes.txt`: the AAD, the signed digest and the chain hash.

The wire crate's tests (`crates/wire/tests/golden.rs`) check, for each format:
- the typed value encodes to the checked-in bytes;
- decode, then encode, gives identical bytes;
- every fixture passes the generic profile validator (§3.2);
- a set of negative fixtures (`<case>.bad.cbor`, with the reason in `<case>.bad.txt`)
  is rejected, one per profile rule plus the schema rules.

`scripts/check-wire-cddl.sh` validates every fixture against `wire.cddl` with the
independent `cddl` validator. It is a local cross-check, not a CI gate.

**Sealed fixtures arrive with the crypto layer.** These are fixtures that open with the
fixed test keys in `conformance/wire/keys.json`, reproduce their plaintext, and verify
their signatures. They use fixed salts, and **only fixtures may**: the seal API takes
entropy from the injected source, and the fixture generator injects a recorded one.
Production code never seeds.

The TS SDK runs the same fixtures.

## 9. Conventions

- MUST, MUST NOT, SHOULD and MAY are as in RFC 2119.
- "Replica" means a full participant holding collection keys: a device daemon, a
  shared runtime in an app, or the hosted replica.
- "Client" means an app or plugin calling a replica.
- "Writer" means the replica appending an item.
- "Control plane" (CP) means mdbase's account, device, grant and routing service.
- The spec is mdbase v0.3.0-rc.5. Spec chapters are cited as "spec 12A".
