# Canonical unindexed Blob: read-only plaintext custody

This contract describes the custody/public API at source `725d72b2`.
The measured browser/native read exception below includes a clean browser rerun
and passing future-profile compatibility coverage. Hosted-only
refusal and its regression remain separate from the browser measurement.
This is a narrow exception, not the strict region redesign.

## Scope

For authenticated `UnindexedOversizedMarkdown` + canonical `FileContent::Blob`,
ClientApi `read_file` and SDK `files.downloadStream` / `files.download` may retain
**one native-owned zeroizing plaintext part** under the active native READ pin and
its exact exclusive region lease. This Blob-only staging may exist outside the
unchanged fixed 9 MiB ciphertext/attachment region. No other reader or uploader
may acquire that region while the read lease is held.

- The staged plaintext is bounded by the authenticated descriptor and the
  canonical **8 MiB** part limit, never by app-supplied size or a file extension.
  A declared larger legacy part fails before transport/region allocation with
  `too_large` / `hosted_read_budget`, even if its final payload would be small.
- There is one held part, not a whole-source accumulator, collection cache,
  resumable plaintext store or second fixed 9 MiB region. No plaintext goes to
  SQL. The next part cannot coexist with the previous held part.
- Ciphertext input stays bounded by existing native object validation and the
  leased region. Whole-object requests omit range; an upper bound is not an
  exact range. Native original request identity/hash/authentication remain
  authoritative after transport completion.
- Existing `UnindexedSourceReader` performs authentication, expected part-length,
  full count/hash and UTF-8 checks. There is no new crypto/sealer primitive,
  algorithm, key export or app-chosen object-address authority.

This explicitly supersedes the earlier blanket owned-fallback prohibition **only
for the above Blob plaintext staging**. Ordinary Blob remains unsupported by this
client read addition. AttachmentV1 still uses its existing in-region authenticated
span, pinned input/output, ownership, ranges, ACK and cancellation behavior. This
exception does not permit an AttachmentV1 owned fallback or another region.

## Lifetime and output

The staging allocation belongs to the current native session/read pin and exact
lease generation, not merely a public owner label. Admission is checked before
capacity reporting. Fetch reserve/write/complete, output and ACK recheck current
native authority and lifetime; possession of bytes never grants continuing access.

The held plaintext is zeroized/dropped after draining, or on matching cancellation,
EOF/error, idle expiry, revoked admission or retired lifetime. Exact-lease cleanup
must not wipe or release a successor's region. Output stays within the existing
1 MiB frame limit and 8 MiB ACK window, with unchanged read-lane arbitration.

A source read is full-source only. No range or exactly `[0, size]` is allowed;
partial ranges refuse `invalid_request` / `unindexed_full_read_required`.
Per-part authenticated chunks are provisional until successful stream close/last,
which additionally requires complete source count/hash/UTF-8 validation. A bad,
missing, truncated or excess part, invalid UTF-8 or a failed final hash must not
produce successful last. SDK stream `.file` resolves metadata, **not** proof of
successful source completion; callers requiring that proof must await stream end.
The existing 64 MiB convenience allocation cap for `download` remains unchanged.
No edit/save, indexed-record conversion or new write semantics are added.

## Memory and qualification

The [bootstrap exception](oversized-markdown-bootstrap-memory.md) records
60.875 MiB browser runtime+SQLite WASM and 52.875 MiB for one Hosted Engine,
flat across its qualified part/note scaling matrix. Those are **bootstrap**
measurements, not a public read result or whole-isolate peak. Retaining plaintext
until output drain and the real host/read/admission composition need their own
measurement, including existing queued-caller behavior where applicable.

### Accepted measured browser/native read exception

The browser/native exception permits **runtime + SQLite WASM capacity <= 68 MiB
for one canonical 8 MiB Blob read**. This supersedes the
provisional own-baseline 10% read screen, not the original design budget.

The genuine migrated-Base public SDK `downloadStream` observation at source
`725d72b2` / production app runtime SHA256
`6984f87d98e29d9f99c6b07f7728f716d1f7b2e3585a74bcc2046ba259a8afab`
recorded runtime 52.875 -> 59.0625 MiB, SQLite unchanged at 8 MiB, subtotal
**60.875 -> 67.0625 MiB** (+6.1875 MiB / **10.164271%**). Capacity stayed at
that high-water through stream completion and close; WASM memory does not shrink
when staged parts are released. This is an accepted one-read high-water, not a
repeated-read, queued-caller, larger-source or scaling qualification.

The initial browser invocation completed exact 8,388,608-byte hash/count, all nine ACKs, native
last and SDK stream end, but its overall result is **failed**: an incidental
favicon was misrouted into the strict RPC fixture handler. Its read screen
assertion was not reached; the 10.164271% comparison derives from checkpoints.
The single clean rerun explicitly serves favicon requests, retains
zero-error fixture/proof assertions and binds every WASM checkpoint to 68 MiB.
That rerun recorded **PASS/exit0/zero fixture errors** using the same app
artifact/native producer above and SDK/harness source `05c987406`. It observed the same
**67.0625 MiB** subtotal, exact source hash/count, nine ACKs, native last, SDK
stream completion and clean close. The original 32 MiB design budget still fails.
Exceeding 68 MiB requires stop/report, not another run or threshold adjustment.

JS heap/backing is **reported separately, not budgeted**: the unforced v2
Worker backing observation grew 7,610,080 -> 75,723,286 bytes and Window backing
391,225 -> 24,510,867 bytes at completed read. These observations may overlap
WASM/other buffers and do not prove retained allocations, an exact transient peak,
a deduplicated sum or whole-isolate fit. No forced GC belongs in product; no
further scaling/GC experiments are authorized by this exception.

This bound is **browser/native only**. It does not authorize executing the owned
Blob reader inside the Hosted Worker 128 MB isolate. A Hosted reader must refuse
that execution after native authority/preflight checks unless separately qualified,
with `unavailable` / `unindexed_read_unavailable_hosted` / recovery `none`.
This Hosted-only refusal is required before queue/frame;
bootstrap success and capacity preflight alone do not establish read-isolate fit.

Qualification also covers ACK/window, cancel and lane reuse, revocation/lifetime,
whole hash, UTF-8/corrupt parts and unchanged AttachmentV1 regressions. Publish
receipts with the review, preserving prior failures; the previous two-engine
synthetic replay is not an isolated migrated-snapshot read result.

Object 9 MiB, frame 1 MiB, ACK 8 MiB, region bounds and the Hosted 128 MB hard
isolate limit remain unchanged. This custody authorization is not a general
32 MiB fit claim. No managed/LAB/provider/app acceptance is implied by code or
synthetic qualification; fresh native runtime artifacts and managed proof are
separate subsequent gates.
