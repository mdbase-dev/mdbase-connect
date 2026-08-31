# CI qualification and artifact promotion

`Server CI / Qualification` is the stable required check. It separates feedback
from release qualification without allowing publication to cross an unverified
trust boundary.

## Lanes

- Ordinary pull requests run the fast Node build, typecheck, architecture, and
  unit-test lane.
- Pull requests labelled `ci:full` run the complete cross-platform, Rust,
  browser, container, upgrade, and system qualification. Isolated staging
  publication requires this label and verifies the full artifact.
- Merge-queue commits always run the complete qualification. Hosted-provider
  Rust qualification and every registered system suite run as parallel jobs
  rather than one serial critical path. `container` retains its packaged-image
  job; `local,relay`, `sync`, `provider`, `files`, `files-adversarial`, and
  `desktop` are explicit matrix shards. A contract test prevents new suites
  from silently falling outside full CI.
- A push to `main` reuses a successful merge-queue qualification only when its
  head SHA is exactly the same. If GitHub has no such completed run, all full
  jobs run again.

The always-present `Qualification` job checks the selected lane and records a
JSON manifest containing the commit, Git tree, package and Cargo lock hashes,
the mdbase engine revision, and the Server CI workflow hash. A reused main run
also records the exact upstream merge-queue run.

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
