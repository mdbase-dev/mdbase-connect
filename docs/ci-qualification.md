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

## Desktop PR selection

`Desktop Release` keeps cross-platform editor/release regression tests on every
matching PR. Editor-only changes skip the standalone headless CLI build matrix;
CSS-only editor changes also skip Windows Store packaging. Mixed changes,
shared inputs, unknown paths, and empty diffs retain native checks. The selector
uses the complete base-to-head merge-base diff, with renames expanded to both
paths. Explicit release dispatches still run all native checks.

## Rust checks and binary transfer measurement

The `hosted-provider-rust` job owns formatting, resolved feature validation,
workspace Clippy, and workspace unit tests for the hosted-provider lockfile,
pinned engine revision, and Linux toolchain configuration. System shards build
that same configuration locally and run their own suites, without repeating
those workspace checks. `Qualification` still requires both the Rust job and
all shards. macOS/Windows coverage remains separate.

To measure binary fan-out, label a PR `ci:benchmark-binaries`. This opts into
full Server CI and adds a measurement-only upload of the CLI/provider runtime
binaries, followed by six matching Linux runner downloads. The tar preserves
executable permissions; each consumer extracts it and exercises both binaries.
Artifacts expire after one day. This never replaces a shard build, contributes
no qualification evidence, and is not a release artifact. Remove the label
when the experiment is complete.

Compare the archive/upload/download/extraction steps and producer readiness
against the same run's per-shard `cargo build` steps using `CI timings`. Include
producer dependency wait in wall-clock estimates and all six downloads in
runner-minute estimates. Do not compare transfer time with the old combined
Clippy/unit-test/build cost: those duplicate checks have already been removed.
The `files-adversarial` suite invokes Cargo tests directly, so shipping only
runtime binaries cannot remove its compilation requirements. A dedicated
build-only producer would need its own end-to-end measurement before adoption.

### Initial measurement (2026-09-16)

[Run 35100242511](https://github.com/mdbase-dev/mdbase-connect/actions/runs/35100242511),
source `dd7506cead8e98fe1da192dd2826669ba8add07b`, completed all six transfer
probes successfully:

- Compressed runtime artifact: 247,093,162 bytes (about 236 MiB).
- Archive step: under the API's one-second timing resolution; upload including
  compression: 12 seconds.
- Download steps: 7, 7, 12, 9, 13, 19 seconds; extraction and both `--help`
  probes: 0–1 seconds each.
- Independent shard builds: desktop 179s, files 156s, local-relay 189s,
  provider 175s, files-adversarial 181s, sync 132s (1,012 runner-seconds total).
- The existing Rust qualification producer completed after 454 seconds;
  consumers started two seconds later. Its unit tests and Clippy are on that
  dependency path. Waiting for that job would delay runtime tests versus the
  independent builds, despite cheap transfers.

Decision: retain independent builds for now. Transfer is inexpensive enough to
justify a future **build-first** producer experiment, not a dependency on the
existing qualification job. This is one run, not a cold/warm-cache study or an
end-to-end artifact-fed system-suite qualification. Runtime probes do not prove
all suite dependencies portable, and files-adversarial still compiles tests.
The run's two upgrade jobs failed on the then-existing mutable-newest-release
policy; that failure does not invalidate the completed transfer measurements.

## Windows daemon task qualification

Full Server CI calls `windows-daemon-lifecycle.yml` and requires its result in
`Qualification`. The small native probe compiles the production CLI service
module directly, avoiding a second copy of installer logic. It uses disposable
Windows runner state and unpaired public release binaries, not account data.

The registration case uses a newly created non-administrator account: the old
unscoped task fails, while current-user installation, replacement, identity
checks, and uninstall succeed. Fresh-start and beta96-to-beta99 runtime
replacement cases use the runner's existing interactive account with the task
configured at least privilege. They verify real daemon status across start,
stop, replacement, cold start, and uninstall. These are separate boundaries:
new non-interactive test accounts cannot execute `InteractiveToken` tasks, and
successful registration alone is not counted as daemon execution. This does
not replace packaged Electron/Squirrel or actual sign-out/logon qualification.

A separate job builds the **current actual CLI**, using the pinned engine, and
executes `--json connect daemon` commands through Node's `execFile` with the
same whole-stdout `JSON.parse` contract as Electron. It verifies install,
replacement, stop, start, restart, uninstall, and real daemon running state.
Exit-code-only service tests cannot detect scheduler output corrupting CLI JSON.
Raw stdout/stderr and the failing command are retained as a bounded artifact.
This job uses the interactive runner account, not a standard-user desktop session.

The elevated-registration fixture creates a task as the runner administrator
for a separate standard-user principal. It proves that principal cannot replace
the administrator-owned task, then has the fixture owner remove it and verifies
normal standard-user registration again. This qualifies an ACL failure and
owner-assisted repair, **not** automatic permission recovery or same-account
UAC token transitions. No production task permissions are weakened.

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
