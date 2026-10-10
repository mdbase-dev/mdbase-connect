# Open questions

Status: draft for review, 2026-10-04.

Each entry gives:
- the choice I was unsure of;
- the **provisional answer these contracts assume**;
- what would change it.

Entries marked **decision** need the product owner or the named owner before the contract
freezes. **Pending** entries wait on a spike.

## Encoding and identity

**Q1. Integer struct keys vs text keys in CBOR.** *Provisional: integer keys.*
- **For integer keys:** compact; the RFC 7049 and RFC 8949 key orderings coincide for
  unsigned integer keys, so any deterministic encoder agrees; criticality lives in
  variant discriminators.
- **For text keys:** readable in raw dumps, and easier with plain serde.

The `mdb-wire dump` tool and annotated fixtures make up most of the readability.
Revisit if the TS SDK finds the field tables error-prone.

**Q2. Always-64-bit floats.** *Provisional: floats are always binary64, never
shortened.* This deviates from RFC 8949 preferred serialization, deliberately, so
float encoding is trivial and identical everywhere. A generic "deterministic CBOR"
library must be configured or wrapped to match. Revisit only if interop with an
external canonical-CBOR consumer matters.

**Q3. Identifier text form.** *Provisional: every 128-bit ID is a UUID in canonical
hyphenated form; new IDs are UUIDv7.* That keeps Connect's legacy UUID record IDs
without a union type. The prototype used ULID text. Lifecycle `ulid` values in
frontmatter are unaffected.

**Q4. YAML integers outside int64.** *Provisional: not representable as `value`.*
The core parses them as floats, or as strings with a parse diagnostic (core decision,
Phase 1). CBOR bignums are excluded from `mdb-cbor/1`. If the spec requires exact big
integers, add a bignum variant to `value` as a new `fmt`.

## Time and determinism

**Q5. No hybrid logical clock.** *Provisional: captured wall time with a monotonic
clamp; order comes only from log positions.* An HLC would only matter if a timestamp
decided correctness, and none does. A device with a wildly wrong clock can still
win `max` merges of `dateModified`. Revisit if that shows up in practice. The fix
would be to clamp `instant` to the service's `appended_at`, which is not signed
today.

**Q6. Time zones in replayed expressions.** *Provisional:*
- `today` is carried as `local_date` in the mutation, so replay needs no tzdb for it;
- any other time-zone conversion in a lifecycle guard uses the tzdb release pinned by
  the semantics version.

An embedded tzdb is large for the WASM budget (S5). Alternatives:
- forbid zone conversions in lifecycle expressions (a spec change);
- carry the origin's UTC offset and evaluate only in that offset.

**Decision**, with the spec work.

**Q7. Semantics ratchet on major versions.** *Provisional: the highest `sem.major` in
the log ratchets. Minors interleave freely.* It is harsh when a phone auto-updates
first and a desktop daemon cannot write until it updates too. That is why only majors
ratchet, and why majors should be rare and shipped through auto-updaters first.

**Q8. Single-record validity decided once, at submit.** *Provisional: yes.* At head
only request and safety checks reject (`intent.md` §6). The alternative is
re-validating at head, which rejects writes that became invalid through a concurrent
change. SC0 argues against it, and verifiers would then need the submitter's level.

**Q9. Field conflicts record, body conflicts reject.** *Provisional:*
- `conflict_mode = record` by default: field conflicts keep the earlier value and
  record both;
- body conflicts on `api` updates always reject, because spec 12 mandates
  `concurrent_modification` for `body_edits`;
- `body` replacement with `body_base` reuses the `body_edits` semantics. That is an
  extension the spec does not define yet, so the spec needs a line for it.

## Log protocol

**Q10. No deduplication at apply time.** *Provisional: the log is truth.*
Idempotency comes from three things:
- byte-identical retry;
- writer-side receipts;
- service-side idempotency tokens.

Apply-time deduplication would need identical receipt windows on every replica. A
duplicate could only enter the log if its writer signed it twice *and* the service
ignored the token.

**Q11. Horizon values.** *Provisional:*
- receipts and tombstones are pruned when older than both 10,000 entries and 180 days
  of log time;
- the service keeps tokens for at least 180 days;
- compaction keeps 10,000 entries of grace and 7 days.

Pure guesses sized for offline laptops. Measure them in the Phase 3 simulator, with
long-offline scenarios.

**Q12. Entry size limit of 1 MiB.** *Provisional: 1 MiB sealed per item, with large
texts in blobs.* A rename that rewrites references in thousands of records may not fit,
and is then rejected as `too_large`. The alternative, multi-item atomic groups, adds a
commit-marker protocol. Not worth it until a real collection hits the limit.

**Q13. Fork detection between replicas.** *Provisional: detection only.*
- The chain hash and the `(seq, prev)` conditional append catch rollback.
- A fork is caught only when two replicas compare `(seq, chain)`.
- Replicas exchange heads only through the service, or opportunistically through the
  hosted replica and client sessions.

A small "head witness" (devices gossiping signed heads through ephemeral streams, or
storing them in the control plane) would make detection systematic. Defer to Phase 3.

**Q14. Snapshot endorsement.** *Provisional:*
- compaction advances only to snapshots endorsed by a device other than the builder;
- single-device collections fall back to 30 days.

It protects against bogus snapshots at the cost of longer retention for single-device
users.

## Crypto

**Q15. One sealing construction (age-style STREAM) for everything.** *Provisional:
yes.* A single-shot XChaCha20-Poly1305 for small items would save about 8 bytes per
item, at the cost of two constructions. **For the external crypto review.**

**Q16. DEFLATE now, zstd later.** *Provisional: raw DEFLATE (`miniz_oxide`, pure
Rust).* zstd with a trained dictionary would compress small entries much better, but
there is no mature pure-Rust encoder. The algorithm byte lets it be added without a
format change.

**Q17. The compression oracle.** *Provisional: accepted residual risk.*
- Per-entry compression contexts.
- Snapshot chunks compressed per bucket.
- Collections can turn compression off with `compress: false`.

The theoretical attack: a create-only app colluding with the log operator watches
snapshot chunk sizes. **For the external crypto review.**

**Q18. Policy items in clear.** *Provisional: yes.* The control plane authors them,
and the log service must enforce them. So membership, device public keys and app
grants are visible to mdbase even for end-to-end collections. Hiding them would need
the control plane to stop managing them, which contradicts the product.

**Q19. Device approval in end-to-end collections.** *Provisional: required, with a
six-digit SAS compared on both devices.* This stops a compromised control plane from
enrolling its own device and receiving keys. It adds friction to "add a device"
(Signal-style). The alternative of trusting the control plane would make end-to-end
equivalent to cloud copy. **Decision (product).**

**Q20. Recovery for end-to-end collections.** *Provisional: none beyond the user's
other devices.* A user who loses every device loses the data, unless they turned the
cloud copy on. An optional offline recovery key (a paper key as an `escrow`-kind
device the user holds) fits the design without changes. **Decision (product).**

**Q21. Ephemeral messages are unsigned.** *Provisional: yes.* Members could forge
each other's presence. Signing every presence update costs about 50 µs and 64 bytes.
Revisit for rooms, where a forged update would change text.

**Q22. Noise over local IPC too.** *Provisional: yes, one authentication mechanism
for local and remote clients.* The alternative, OS peer credentials plus a bearer
token, is simpler but is a second auth path to secure and test.

## Policy and grants

**Q23. Folder-scoped file grants vs ADR 0012.** *Provisional: keep `file_folders` as
the one narrowing below the collection, for files only.* ADR 0012 removed type scoping
for records. Connect's file capability kept folder scopes. It is cheap to enforce,
since paths are known at the replica, and it matters for photo-style apps.

**Q24. Grants for local-only collections.** *Provisional: the replica stores them
locally in the policy `grant` shape, and they become policy items when sync is
turned on.* Needs the desktop pairing flow designed in Phase 5.

**Q25. Viewer devices.** *Provisional:*
- viewers are read-only replicas;
- their local edits are held with reason `read_only`, never appended.

Alternative: viewers don't get folder replicas at all.

## Files and binaries

**Q26. Large-file publish and hashing cost.** *Provisional: no size threshold in the
log format.* Files of any size are part sequences. On the file layer, though:
- hashing a multi-GB file on every change is expensive;
- the never-clobber publish keeps the displaced version as a stash. S2 decided stashes
  are kept for seconds, which for a multi-GB video means doubling disk use briefly.

Options:
- (a) a size threshold above which the replica hashes lazily and publishes by
  rename-only with a backup, instead of a stash;
- (b) default `max_size` in inclusion (for example 2 GiB);
- (c) both.

**Pending:** publish-side details. **Decision needed:** default inclusion cap.

**Q27. Default device materialization per platform.** *Provisional: desktop
materializes everything included; mobile defaults to on demand for video and audio,
with images and PDFs materialized.* Whether "remote" means absent from disk or an OS
placeholder (Windows Cloud Files, macOS File Provider) remains unresolved, and is a
large product decision on its own. **Decision (product).**

**Q28. Keyed blob addressing across epochs.** *Provisional: the content-ID key is
per epoch.*
- Deduplication restarts after a rekey (the first upload of each file after a rekey is
  full).
- Revoked devices cannot probe the store.

Alternative: a collection-lifetime content key, which deduplicates across epochs but
lets a revoked device keep testing for files it can guess.

**Q29. Blob squatting by a malicious member.** *Provisional: detected, not prevented.*
A member device could upload garbage at a valid keyed address before an honest
uploader. Readers detect the digest mismatch and mark the blob unavailable. Prevention
would need the service to verify content, which a blind service cannot.

**Q30. Migration re-encryption of hosted R2 objects.** *Provisional: re-seal
eagerly during the hosted import.* Each existing R2 file object (stored
plaintext-at-rest today) is read by the hosted replica, sealed into blob parts under
the new collection key, and uploaded before the `base` item. The old objects are
deleted once the legacy rows are retired.
- **Cost:** a full read and write of every attachment, so time and egress scale with
  media volume.
- **Alternative:** lazy re-encryption, where the `base` references legacy objects
  through a migration indirection. It complicates the blind-service invariant (I12),
  because legacy objects are not sealed.

**Decision** before Phase 6, with a cost estimate from production R2 sizes.

**Q31. File revision equals content digest.** *Provisional: yes.* Connect separates
`revision`, which changes on move, from `content_digest`. Here moves are guarded by
`from`, so one value suffices. Apps that want "fail if moved" use `from`.

**Q32. Where the inclusion policy lives.** *Provisional: as log state (`sync_settings`),
not in `mdbase.yaml`.* It is ordered with the file writes it governs, and no user file
gets mdbase-specific metadata. Plain tools don't see it; it only means something to
synced replicas anyway.

## Product and UX

**Q33. Holds are device-local.** *Provisional: yes.* A held file on the laptop is
invisible to a web app connected to the hosted replica. It only shows as "the laptop
has k pending changes". Publishing a per-device hold summary (an ephemeral "device
status" stream, or a small sealed state object) would let any client show "resolve on
your laptop". Phase 5 UX work.

**Q34. Collection state names.** *Resolved 2026-10-06.* The only
signup/main-UI options are **Cloud copy** (default; hosted serves apps when devices
are off) and **Private** (end-to-end synced; apps need a user device online).
Local-only remains hidden as connector migration landing state and the advanced
per-collection **Sync: off** setting; it has no pricing tier. Migrated connector
users get a clear prompt to turn sync on with either visible option. Wire states
`e2e`, `cloud-copy` and technical local-only status are unchanged.

## Pending spikes

**Q35. What S1, S2 and S4 can still change in these contracts.** By design, little.
These parts are explicitly pending:
- how a file-backed replica publishes records and files, and the stash and hold rules
  (`FilePlatform`);
- what a remote file looks like on disk (Q27);
- folder materialization during snapshot install;
- the derived index during progressive install (`IndexStorage`);
- per-platform key storage;
- when the editor fence routes a publish.

S2 (done) added stash retention of seconds, and "a single missing observation is not a
delete". Those are file-layer rules, and they surface here only as the
`suspect_write` hold reason and the join rules.
