# CI qualification and artifact promotion

`Server CI / Qualification` is the stable required check. It separates feedback
from release qualification without allowing publication to cross an unverified
trust boundary.

## Lanes

- Ordinary pull requests run the fast Node build, typecheck, architecture, and
  unit-test lane.
- Pull requests that change native inputs run the complete qualification
  automatically, so failures that would otherwise first appear in the merge
  queue surface before queueing. `scripts/ci/server-test-plan.mjs` selects
  them from the merge-base diff: Rust crates, Cargo manifests and locks, the
  toolchain, `deploy/docker/`, `deploy/postgres/`, `test/system/`,
  `test/upgrade/`, Windows diagnostics, every registered system-suite command,
  and the Server CI workflows. The list only adds pull-request coverage; a
  missing input delays feedback but never skips a merge-queue gate.
  `pnpm ci:local` applies the same plan to the local branch's committed,
  uncommitted and untracked changes since `origin/main`.
- Pull requests labelled `ci:full` run the complete cross-platform, Rust,
  browser, container, upgrade, and system qualification. Isolated staging
  publication requires this label and verifies the full artifact.
- Merge-queue commits always run the complete qualification. Hosted-provider
  Rust qualification and every registered system suite run as parallel jobs
  rather than one serial critical path. `container` retains its packaged-image
  job; `relay`, `sync`, `provider`, `files`, `files-adversarial`,
  `projection-scale`, and `linux-packages` are explicit matrix shards. A
  contract test prevents new suites from silently falling outside full CI.
- A push to `main` reuses a successful merge-queue qualification only when its
  head SHA is exactly the same. If GitHub has no such completed run, all full
  jobs run again.

The always-present `Qualification` job checks the selected lane and records a
JSON manifest containing the commit, Git tree, package and Cargo lock hashes,
the mdbase engine revision, and the Server CI workflow hash. A reused main run
also records the exact upstream merge-queue run.

## Desktop PR selection

`Desktop Release` keeps cross-platform editor/release regression tests on every
matching PR. Editor-only changes skip the standalone headless CLI build matrix;
CSS-only editor changes also skip Windows Store packaging. The Windows Store
package job builds the release CLI and also runs the Windows headless smoke
test, so Windows builds it once. Mixed changes,
shared inputs, unknown paths, and empty diffs retain native checks. The selector
uses the complete base-to-head merge-base diff, with renames expanded to both
paths. Explicit release dispatches still run all native checks.

## Rust dependency caches

GitHub scopes a cache to the ref that saved it; other refs can read only their
own and the default branch's. Caches saved by merge-queue or pull-request runs
were therefore never restored, and they evicted useful entries from the
repository's 10 GB budget. A push to `main` reuses the merge-queue
qualification without building, so nothing was ever saved where later runs
could read it.

`rust-caches.yml` is the only writer. It runs on `main` when a cache-key input
changes (Cargo manifests and locks, the toolchain, or the pinned engine),
weekly so unchanged entries do not expire, and on dispatch. Each matrix entry
reproduces one consumer's toolchain, lock file and builds under a shared key:
`hosted-provider` (Rust workspace job and the system shards that build Rust)
and `mdbase-daemon-release` (Desktop Release
smoke builds of the daemon in `runtime/`, keyed on `runtime/Cargo.lock`). Every CI job restores with `save-if: false`; a contract test
fails if a job restores a key the workflow does not write. rust-cache keeps
dependencies only, so workspace crates always compile from source.

The hosted-provider upgrade job restores, read-only, the Docker Cargo cache
mounts that `publish-images.yml` saves from `main` before building the
candidate image.

## Rust checks

The `hosted-provider-rust` job owns formatting, resolved feature validation,
workspace Clippy, and workspace unit tests for the hosted-provider lockfile,
pinned engine revision, and Linux toolchain configuration. System shards that
start the provider binary or run its Cargo tests (`provider`, `files`,
`files-adversarial`, `projection-scale`; `rust: true` in the matrix) build that
same configuration locally and run their own suites, without repeating those
workspace checks. The `relay`, `sync` and `linux-packages` shards are
JavaScript and Docker only and skip the engine checkout, toolchain and Cargo
build. `Qualification` still requires both the Rust job and all shards.

The opt-in `ci:benchmark-binaries` transfer measurement was removed; it
concluded that independent shard builds stay, and its record is in Git history.

## Pinned hosted provider

Production, staging and LAB run one hosted-provider image until the provider is
switched off, so the control plane must keep working against that image rather
than a build of this checkout. `deploy/docker/hosted-provider-image` holds its
`image@sha256` reference; moving the pin is a one-line change there.

The `provider-pinned` system suite (`pnpm e2e:provider:pinned`) runs the
`provider` suite with the provider binary copied out of that image
(`scripts/pinned-hosted-provider.mjs`, into `target/pinned-hosted-provider/`).
It needs Docker, Node and Chromium, not Cargo, the engine checkout or
`crates/`. It skips the checks that test provider source rather than the
image: the Cargo test of the provider's database pool bounds and the two
fixtures that replay migration SQL from `crates/`. Server CI's
`hosted-provider-pinned` job runs it in the merge queue and on pull requests
that change `services/server/`, `packages/protocol/` or the extraction script;
`Qualification` requires it whenever it runs. The from-source `provider` shard
is deleted with `crates/` once one deployment has run on the pinned provider.

The pinned image and its signatures must stay in the registry until the provider
is switched off. Nothing in this repository deletes versions of the
`mdbase-connect-hosted-provider` package, and the registry has no retention rule
that would; only someone with admin access to the package can delete a version.
A cleanup of the package must leave these six versions for the pinned digest:

- the image index, tagged `sha-<commit>`, with its platform manifest and its
  build attestation manifest, both untagged;
- the signature index, tagged `sha256-<digest>`, with the two untagged bundles
  it lists: the image signature and the release-image attestation.

Removing untagged versions would therefore break the image and its signatures.
A deleted version can be restored for 30 days.

## Publication

Server and client images are built after a successful `main` push qualification,
smoke-tested, signed, and attested at immutable digests. Release preparation
promotes those digests; it does not rebuild them.

The full Node job packs public npm tarballs only after package audit and retains
them with its qualification. A tag workflow verifies the exact successful
`main` qualification and publishes those tarballs unchanged. Desktop release
jobs verify the same qualification, then perform only the platform-specific
build, signing, and package verification that cannot be promoted portably.

## Required check and observability

Branch protection requires only `Server CI / Qualification`. Heavy jobs may be
skipped on ordinary pull requests without leaving obsolete compatibility
contexts pending. The aggregate check still requires every cross-platform,
container, upgrade, Rust, and system shard on `ci:full` and merge-group runs.

`CI timings` observes both Server CI and Editor CI. It makes one bounded,
paginated jobs request per completed run and retains machine-readable workflow
attempt, runner-queue, execution, job pre-start wait, step, and Playwright
cache-hit data. Use this
evidence before merging jobs or adding retries; a retry should address a
classified transient failure, not conceal a deterministic one.
