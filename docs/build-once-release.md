# Build once, release by selecting

Status: proposed implementation; no publication, dispatch, deployment or
environment change is authorized by this document. The release freeze remains.

## Lifecycle

Every protected-main push runs Server CI and Runtime CI without path filtering.
Successful Server CI continues into the existing four-component OCI publication
in `config/release-components.json`. Successful Runtime CI continues into
`build-workers.yml`, with a fixed staging/production matrix. Neither main pipeline
cancels an older main run when main advances: only PRs share a concurrency group;
each main run has its own group so pending runs cannot displace each other.
Failed qualification produces no
releaseable candidate; a successful check wrapper cannot replace actual execution
jobs. Runtime CI's manual diagnostic entry remains, but cannot trigger a Worker
build.

The Worker builder reuses the existing pinned private ops assembly and trust
verifier. It compiles the existing three-role profiles, runs real PostgreSQL and
native-workerd tests without skips, then uploads an unsigned, immutable artifact
for each tier. The unsigned manifest binds file digests and sizes, exact runtime
source, Runtime CI run/attempt, build run/attempt, builder workflow revision,
Wrangler version, and the authenticated trust build receipt. These are build
results, not release or deployment authority. No signing identity or cloud
deployment credential is granted to the builder.

Images already have digest-bound signatures, attestations and an exact Server CI
receipt. Image change filtering and owner-dispatched image rebuilding are removed:
every qualified main commit has its own complete image bundle. Existing trust
publication operations still select an existing image run and sign their fixed
environment extension; they do not rebuild images.

## Trust must precede compilation

Hosted and escrow JavaScript embeds authenticated Connect trust. Selecting a
different trust asset after compilation would change the release bytes. Rather
than add runtime trust configuration, module patching, placeholders or a second
bundler, CI requires the repository variable `WORKER_BUILD_TRUST` containing the
already-approved public build inputs for both tiers:

```json
{
  "staging": {
    "source_commit": "<40-hex Connect trust source>",
    "image_run": 123,
    "trust_run": 124,
    "publisher_commit": "<40-hex trust publisher>",
    "asset_sha256": "<64-hex canonical trust asset digest>"
  },
  "production": {
    "source_commit": "<40-hex Connect trust source>",
    "image_run": 125,
    "trust_run": 126,
    "publisher_commit": "<40-hex trust publisher>",
    "asset_sha256": "<64-hex canonical trust asset digest>"
  }
}
```

This is a required setup decision, NOT a populated example or a claim that the
variable exists. This implementation does not configure it or mint trust. The
existing `WORKER_RELEASE_READ_TOKEN` is still needed for pinned private ops
checkouts. Missing, malformed, expired or unauthenticated trust fails closed.
Repository-variable changes select future build inputs only; they cannot modify
an already-built artifact. Ops still checks independent operator trust pins against
the signed manifest. A trust rotation needs a new main commit/build, not a release
time replacement. Trust source may deliberately differ from runtime source;
those identities were already distinct in the existing build contract.

## Human selection and signing

After both image and Worker builds finish, the owner chooses a full main source
SHA, a `build-workers.yml` run ID, its exact attempt, and the fixed tier.
`release-workers.yml` runs from current protected main. The source need not equal
the signing workflow revision: both remain separately recorded.

The selector checks repository visibility, workflow path, main ancestry, completed
success, current attempt and the unique exact artifact name. It obtains the
immutable artifact ID and archive digest from GitHub, downloads by ID, fails on a
digest mismatch, and extracts only bounded regular relative files. It validates
the original manifest, full file inventory and trust receipt, and independently
rechecks exact source qualification jobs and ancestry. It does not execute any
downloaded JavaScript, WASM, verifier, dependency hook or private assembly.

Only the manifest changes: schema `/2` records the owner signing run and revision,
plus `qualification.build` with builder revision, run/attempt, artifact ID, archive
digest and original manifest digest. Worker bytes, frozen configs and trust files
are copied unchanged. Selection installs no compiler, dependencies or Wrangler.
The owner-only keyless signing job signs this selection manifest using the same
fixed `release-workers.yml@refs/heads/main` Sigstore identity. It rechecks custody
and current attempts after signing before uploading the signed candidate.

## Security and ops authority

- **Minting:** only `callumalpass` as both actor and triggering actor can select
  and sign, on protected main in the public canonical repository. This deliberately
  does not equate arbitrary CI-on-main with owner release approval. Automatic
  builders have `contents:read` and `actions:read`, not `id-token:write`.
- **Provenance:** source SHA, signer workflow SHA, build workflow SHA and all
  run/attempt identities are distinct. Exact artifact names include source and
  attempt; artifact IDs and GitHub SHA-256 digests prevent substitution. Reruns
  invalidate old attempts rather than silently choosing the newest attempt.
- **Qualification:** automatic protected-main push checks need not have the
  owner's actor identity. Owner identity remains required for manual diagnostic
  qualification and signing. PR/fork/non-main/partial/skipped runs remain refused.
- **Acceptance:** the companion ops verifier supports `/2` only for Connect. It
  checks the fixed signature identity with the signing revision, owner dispatch,
  builder identity and immutable artifact metadata, reconstructs and hashes the
  original build manifest, and checks actual source jobs/ancestry. Historical
  NEXT and Connect `/1` evidence remains accepted unchanged.
- **Deployment:** ops remains the authority for separately authenticated trust,
  frozen profiles, complete inventories, code-only changes, qualification,
  acceptance, migration, rollback, and environment authorization. A signed build
  is not staging or production permission. Existing attempt evidence retains the
  additional build receipt inside `qualification`; deployed-state schemas and
  transitions are unchanged. No deployment state machine is added.

The ops PR must merge first; it is an additive format reader and still accepts
the existing producer. Only then merge Connect's producer replacement. Older ops
fail closed on `/2`; do not use them to consume a new selection. The private
builder pin stays at ops #1323: its assembly API imports the canonical public
source/custody functions and needs no new assembly implementation. Its trust
verifier pin also stays unchanged.

## Retention and costs

Both unsigned Worker artifacts and selected signed candidates request 90 days;
image manifests/trust artifacts already request 90 days, while image blobs live
in GHCR. Repository/organization policy may cap the requested retention. Expiry,
deletion or missing digest metadata is a hard refusal, never permission to rebuild
inside selection or to infer a replacement run. The initial supported candidate
window is the minimum actual retention of the build artifact, its metadata and
all independently verified trust/qualification evidence.

Long-lived candidates require an explicit custody extension before expiry: retain
the exact original archive, selection manifest and Sigstore bundle in a durable
registry or R2, with an ops-verifiable digest/provenance contract. That transport
and its credentials are deliberately not invented here. Merely copying a signed
archive does not remove the present GitHub-metadata dependency. Decide that
extension before adopting candidates older than the supported window. GHCR
cleanup must likewise preserve release-referenced immutable digests.

The tradeoff is predictable main CI cost for near-zero release compilation cost:
each main commit now runs Runtime CI even for docs-only changes, builds four OCI
components even when inputs are unchanged, and performs two managed Worker
assemblies (one per tier). The existing 90-minute assembly timeout is a ceiling,
not a measured duration. Matrix builds duplicate tier-independent compilation;
do not claim this removes Runtime CI's separate test builds. Existing Docker cache
mounts and Rust caches remain available, but are not a provenance substitute.
For D successful main commits/day, Worker assembly adds up to 180D runner-minutes
under these ceilings; actual billed time must be measured after an authorized
rollout. Worker storage is approximately 90D times the sum of both tier archives,
plus selected archives, subject to provider policy and billing. No new paid
storage service is provisioned. Selection has a 15-minute timeout and no build.

## Replaces and deletes

- Deletes compilation, tests, private ops checkouts and trust selection from the
  owner-dispatched Worker publisher; moves the one existing assembly into CI.
- Deletes dispatch-time CI/log run inputs and `github.sha == source_revision`.
- Deletes OCI path-based publication skipping and manual image rebuild mode.
- Removes the need to freeze main between a diagnostic Runtime CI dispatch and
  Worker publication; release chooses existing exact evidence instead.
- Does not add a second ops assembly, verifier, signer, deployment route, journal,
  schema for deployed state, or runtime trust fallback.

SDK and WASM release publication is a later extension, not implemented here.
Runtime CI's current SDK/WASM outputs remain qualification evidence. Extend the
same immutable inventory/run/attempt/owner-selection model when their consumers
and retention contract are specified; do not claim npm publication is solved.

## Decisions before rollout

Callum must approve the two trust build pins and their rotation owner, the
90-day candidate window (or durable custody extension), and the per-main CI cost.
After the freeze ends, separately authorize merging in the stated order and a
real protected-main build/selection/ops-verification exercise. Hermetic checks
and source review do not establish real signed acceptance or deployed readiness.
