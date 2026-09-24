# Pinned, test-only S3 fixtures

## Why source builds

Full Server CI for #466 (run 36015913658, attempts 1 and 2) could not pull the
existing pinned MinIO server image: Quay returned `UNAUTHORIZED` before file or
provider assertions ran. Independent anonymous requests also received 401 from
Quay and Docker Hub, including the client repository. The corresponding official
binary-archive checksum URLs returned 410. Cached local images do not establish
availability on fresh CI runners. This records observed availability, not an
assertion about upstream's permanent distribution policy.

This fixture instead builds the same upstream **source release revisions** in
CI. It does not mirror an unverifiable image, publish cached binaries, replace
MinIO with a mock, skip suites, or weaken integrity checks. These are new source
builds, **not byte-identical copies of the withdrawn/inaccessible images**.

## Immutable input evidence

The official GitHub annotated tags were resolved to these commits; source
archives were downloaded from GitHub's codeload endpoint and SHA-256 hashed:

| Component | Release tag | Commit | Archive SHA-256 |
| --- | --- | --- | --- |
| MinIO | `RELEASE.2025-09-07T16-13-09Z` | `07c3a429bfed433e49018cb0f78a52145d4bedeb` | `8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2` |
| mc | `RELEASE.2025-08-13T08-35-41Z` | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` | `95cd293c7119f16921a6dc515a1fb74a2227f19fd994b9c8b770a154e802ac44` |

The Dockerfile contains the canonical pins: official Go 1.26.7/bookworm and
BusyBox 1.37.0/musl image-index digests, immutable archive URLs and checksums.
Those base-image manifests were accessible anonymously during preparation.
Checksums are checked before archive extraction. Go cannot silently select a
new toolchain or modify the dependency requirements; upstream `go.sum` and
`go mod verify` enforce module integrity. Source licenses are copied into the
runtime images. No release signature or bit-for-bit reproducibility is claimed.
The newer pinned compiler/runtime and resulting binaries require the system
qualification below; matching source revisions alone is not that evidence.

## Use and fail-closed behavior

Only the two existing S3 system-suite scripts import
`scripts/lib/s3-test-images.mjs`. It builds each target once per process and
passes Docker's immutable output IDs to the existing container commands. There
is no mutable output tag, registry override, legacy-image fallback, credential
injection, or production deployment change. Any build failure, missing ID or
malformed ID rejects the fixture setup; a partial build is not returned.
Only its own temporary IID directory is removed. The real PostgreSQL/S3 tests
and their assertions remain intact.

## Qualification and resource limits

- `node --test scripts/lib/s3-test-images.test.mjs` checks immutable input pins,
  output-ID validation, memoization, temporary-file cleanup and fail-closed
  behavior for both build targets. Its isolated child processes replace Docker
  spawning before loading the helper; these unit tests cannot build images.
- Full CI must build the fixtures on fresh runners and pass **both `files` and
  `provider` system suites**, as well as all other required qualification jobs.
  A green static/unit test alone is insufficient.
- After this dependency repair is reviewed and integrated, #466 must qualify
  again on its exact integrated source. No gate is waived or transferred from
  a different commit.

Go compilation is limited to four parallel packages; module/build cache IDs
are test-fixture-specific and remain on disposable CI workers. This does not
promise a fixed disk footprint: source builds can need several GiB and must
fail normally if a runner lacks space. No CI timeout or storage checks are
relaxed. No local Docker/Go/Rust build was performed during preparation on the
nearly full shared development filesystem. Only small source archives and
metadata were downloaded; no shared caches are cleaned by this helper.

These images are ephemeral test dependencies, not production artifacts. Any
future registry publication needs its own provenance/licensing review.
