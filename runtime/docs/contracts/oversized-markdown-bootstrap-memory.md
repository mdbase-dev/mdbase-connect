# Oversized Markdown: bootstrap memory exception

Status: launch exception, confirmed 2026-10-20.

## Scope and condition

The **32 MiB composition design budget is not met** when a browser or Hosted Engine
cold-opens a migrated, unindexed oversized Markdown **canonical Blob** snapshot.
There is a narrow launch exception for this authenticated source-validation path:
canonical **8 MiB plaintext parts**, validated one part at a time. It is not a
whole-document or whole-collection memory allowance, nor a different representation.
Original IDs/paths, generic compression/equivalence and retained UNKNOWN custody
remain unchanged. Bootstrap authenticates the full source before completing install;
it does not make the source an indexed record.

The measured per-part WASM bound for the qualified matrix is **60.875 MiB in the
browser, including 8 MiB SQLite WASM**, and **52.875 MiB in one Hosted Engine**, whose
Durable Object SQLite is native, outside that linear memory. These are observed
linear-memory capacity high-water marks, not live allocator attribution, general
worst-case entropy ceilings, or whole-process/isolate peaks. They are **not multiplied
by the number of parts**: the measured watermark stays flat as parts/notes increase.

The exception is conditional on scaling remaining within approximately **10% of the
same-platform single-part baseline** for both a 16 MiB/two-part note and three
**distinct** 8 MiB notes. Both browser and normal Hosted log-pump paths must complete
source validation/open, inspect all file metadata/native rows, and fetch every part.
The launch measurements below satisfy that condition with **0% WASM growth**. A
future change that breaks the condition requires review; this is not an extrapolated
proof for arbitrary part counts, legacy larger parts, entropy, or concurrency.

The Hosted platform's **128 MB hard isolate limit remains unchanged**. The measured
Engine headroom is not a whole-isolate fit proof: native SQLite, JS heap/backing,
transient copies and runtime overhead remain distinct accounting domains. Ordinary
32 MiB compliance is not claimed, even for the smaller successful bootstrap.

## Measured matrix

All values are MiB (1,048,576 bytes). Hosted used **one Engine**, not two replicas or
a synthetic Entry replay. The browser used a dedicated Chromium Worker,
`AppWasmRuntime`, SQLite WASM/OPFS, production `AppHttpLogTransport`/HTTP Direct, and
real `MdbaseClient` query/file-metadata calls. Hosted used actual workerd, native
DO SQLite and the fixed **normal production log pump**, not the SDK bridge.

| Genuine migrated source | Canonical parts | Browser runtime WASM | Browser SQLite WASM | Browser subtotal | Hosted Engine WASM | Growth vs single part (browser / Hosted) |
|---|---:|---:|---:|---:|---:|---:|
| One 8 MiB note | 1 | 52.875 | 8.000 | 60.875 | 52.875 | baseline |
| One 16 MiB note | 2 | 52.875 | 8.000 | 60.875 | 52.875 | 0% / 0% |
| Three distinct 8 MiB notes | 3 | 52.875 | 8.000 | 60.875 | 52.875 | 0% / 0% |

The single-part browser baseline stopped at its original 32 MiB guard after the
source reply, **before metadata/read admission**. The two scaling browser cases
explicitly continued observation and completed head4/sync, zero query records, and
real SDK metadata for every note. They **still exit1 at the final 32 MiB assertion**;
continued observation is not a passing budget test or a raised limit. Hosted baseline
and both scaling cases completed serving/pin rebuild/head4 with exact native file
rows and zero indexed records. Native proof of possession was independently checked.
No public SDK file-content download was qualified by these opens.

Fixtures came through genuine native migration, canonical sealing, cutover, Base
installation/root verification and persistent reopen. The three-note case has
**different plaintext hashes, Blob IDs and part addresses**; it is not a deduplication
surrogate. Each tested sealed source part is 6,424,145 bytes. These are public
synthetic transport/source fixtures, not LAB/provider/deployed-artifact, managed
composition, full-app sign-in or TaskNotes qualification.

## JS backing: transient collection, not a retained three-part leak

JS heap/backing samples are separate from WASM and are not added as a supposedly
deduplicated isolate total. No forced GC was used in the ordinary matrix.

| Browser case | Worker JS heap maximum sampled | Worker backing maximum sampled |
|---|---:|---:|
| One 8 MiB note (guard-stopped baseline) | 4.014 | 10.758 |
| One 16 MiB note | 4.012 | 24.194 |
| Three distinct 8 MiB notes | 4.291 | 31.559 |

One additional, explicitly authorized **measurement-only** three-note diagnostic
issued CDP `HeapProfiler.collectGarbage` in both Worker and window **before each
checkpoint**. Worker backing was **0.992 MiB** at native open; **7.125 / 7.123 / 7.125
MiB** during the three source transfers; **0.993 MiB** after log turns; and **0.994
MiB** after completed sync/all-note SDK metadata. Window backing stayed approximately
0.365–0.366 MiB. WASM remained 60.875 MiB. Backing returned to baseline instead of
remaining near 31 MiB, satisfying the launch diagnostic criterion (baseline plus no
more than roughly one 8 MiB part).

Thus the unforced additional backing above the guard-stopped baseline (about13.4 /
20.8 MiB in the scaling cases) reflects lazy collection of roughly one-to-three
canonical 8 MiB parts' worth of transport copies, not a retained three-part leak at
those checkpoints.
Forced GC is **never a product requirement or implementation change**. Checkpoint
samples, forced or not, do not measure exact between-checkpoint JS peaks or establish
a universal no-leak claim.

## Unchanged safety and follow-up

- Object9 MiB, external frame1 MiB, ACK8 MiB and existing region/permit bounds do not
  change. Whole objects use `range: None`; an upper bound is not an exact range.
- The Hosted Direct fix completes ciphertext through immutable trusted origins,
  exact range/length/checksum/expiry/currentness checks and bounded BYOB before
  native authentication. A completion error remains a retryable call failure;
  stale sessions drop old reads rather than delivering to a retired engine.
- Ordinary Blob and AttachmentV1 semantics, pinned streaming/range/cancel/ACK and
  attachment metadata's raw Direct path remain unchanged. This exception does not
  itself authorize an owned whole-part **public SDK** fallback or qualify
  incremental reads. The later [Blob-only read custody authorization](unindexed-blob-read-custody.md)
  separately permits lease-bound one-part zeroizing staging and requires actual
  read-composition qualification; AttachmentV1 ownership remains unchanged.
- Copy reduction is a **post-launch improvement**. Noncrypto transport/ownership
  opportunities may reduce overlapping copies; estimates are not additive and JS
  savings cannot be subtracted from WASM. No crypto/native decryption changes or
  extra limits are authorized by this exception.

## Artifact and qualification attribution

- Browser production app-runtime SHA256:
  `a57387f8d4c9bdebd2cef61534d0a1df80712a814ca712459242d23b3aa38414`.
- Measured Hosted artifact: **b03d, local production build of6ec021f6**,
  SHA256 `b03d6a9e10bb0ec47ec092353a76756850859bfc5306518aa5f9a5d1152f2133`.
  It was explicitly accepted for the probes; it is **not** CIa356.
- Direct fix [#935](https://github.com/mdbase-dev/mdbase-next/pull/935), merge
  `cae8e5eb76aaa40fc65795316a21d5e64b34eb88`, has byte-identical production TS to the
  measured fix. Its sole normal [Hosted CI39349454321](https://github.com/mdbase-dev/mdbase-next/actions/runs/39349454321)
  qualified head `5f5caac1240c59edc2b614f6f579889927f97d53`:759 tests/0 skips plus62
  PUBLIC native scenarios, using distinct CI WASM
  `a3564eae70f6b2ae4f2b85e281d9769aed697d65348f307fa8e9d496105c2084`.
  The fix changes only Hosted TS/tests; app-runtime and daemon production inputs
  remain unchanged. It is not deployment qualification or a new native build receipt.
