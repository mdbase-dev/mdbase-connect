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
- Merge-queue commits always run the complete qualification.
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

## Required-check transition

Enable merge queue for `main`, add `Server CI / Qualification` as required, and
remove the old matrix job names in the same branch-protection update. Keeping an
old job required after it becomes intentionally skipped will strand pull
requests in an expected-check state. Do not change branch protection before the
workflow commit is present on the default branch.

During this transition, the existing required `node`, `server-container`, and
`hosted-provider` contexts remain present. `node` carries fast PR feedback; the
other two are compatibility wrappers that require their real heavy job in a
full lane and explicitly defer it in an ordinary PR lane. Remove those wrappers
only after branch protection requires `Qualification` instead.

`Server CI timings` makes one paginated jobs request after each completed run,
uploads machine-readable job and step durations, and writes a longest-first job
table to the workflow summary. Use this evidence before merging jobs or adding
retries; a retry should address a classified transient failure, not conceal a
deterministic one.
