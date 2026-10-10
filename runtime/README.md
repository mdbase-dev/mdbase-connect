# mdbase next

Reimplementation of mdbase + Connect around one deterministic core, one replica service and a blind shared log.

**Status:** Phase 1 in progress. `mdbn-core` has the document model, the YAML
profile with format-preserving writes, paths, the three-way merge, body edits,
move detection, the regex profile and the CEL engine (temporal and file
helpers still to come). Spec interpretations are recorded in
`docs/spec-notes.md`.

## Layout

```text
Cargo.toml              workspace, profiles (incl. wasm-release), shared lints
rust-toolchain.toml     pinned toolchain (1.94.0) + wasm32 target
clippy.toml             determinism/portability bans (all crates; see below)
deny.toml               cargo-deny: licenses, advisories, banned crates, getrandom features
crates/                 the product crates (map below)
xtask/                  repo automation: `cargo xtask help`
conformance/
  spec/                 vendored rc.5 spec fixtures + SOURCE (spec commit)
  spec-expectations.txt the spec ratchet: pass / pending / skip per fixture id
  determinism/          replay fixtures (*.log) and golden outputs (*.expected.json)
  wire/                 golden byte fixtures per wire format (docs/contracts/00-overview.md §8)
scripts/                sync-spec-fixtures.sh, wasm-replay.mjs, wasm-size.mjs, extract-cddl.sh, check-wire-cddl.sh,
                        gen-casefold-table.py
packages/sdk/           the TS SDK (@mdbase-dev/sdk): client API, transports; `cargo xtask sdk`
packages/mdbase/         the npm `mdbase` package: universal helpers over mdbase-core.wasm (`cargo xtask mdbase-wasm`)
packages/obsidian-runtime/  the Obsidian runtime host (vault platform, journal, index, fence, shared runtime); `cargo xtask obsidian`
tools/wasm/             pinned binaryen (wasm-opt) and the WASM size budget
fuzz/                   cargo-fuzz targets for mdbn-core (local only, not in CI)
docs/                   docs/contracts/ (wire formats, log service and client APIs);
                        spec-notes.md (spec gaps and the core's interpretations)
```

## Crate map

Directories carry the role, packages carry the prefix: `crates/core` is package
`mdbn-core`, crate `mdbn_core`.

| Crate | Responsibility | May depend on (internal) | Portable (WASM) |
|---|---|---|---|
| `mdbn-core` | All replicated semantics: parse, YAML patch, types, lifecycle, CEL, links, merge, intent planning, query IR. No I/O. | nothing | yes |
| `mdbn-noise` | Shared native/WASM production Noise IK cryptography; caller-supplied secrets/prologues, no I/O/entropy or admission policy. | nothing | deterministic lib; WASM host consumer is hosted Worker only, not SDK/runtime |
| `mdbn-wire` | Wire types and canonical encoding (`mdb-cbor/1`) for every format in `docs/contracts/`, plus the golden fixtures in `conformance/wire/`. | core | yes |
| `mdbn-replica` | The replica service and the `Store` trait; client API. | core, wire | yes |
| `mdbn-store-file` | File-backed `Store` over `FilePlatform` + `IndexStorage`: publish, recovery, ingest, holds, adopt/join. | core, wire, replica | yes |
| `mdbn-platform-native` | `FilePlatform` for Linux/macOS/Windows; native SQLite `IndexStorage`. | core, store-file | no |
| `mdbn-store-pg` | Postgres `Store` for the hosted replica. | core, wire, replica | no |
| `mdbn-log-service` | Blind log service: conditional append, snapshots, blobs, push. Platform-neutral logic behind a per-collection `Backend` seam; builds for wasm32 (the Durable Object runs it). | **wire only** | builds for wasm32; not held to the determinism rules |
| `mdbn-log-server` | Native host of the log service: WebSocket/HTTPS gateway, Postgres backend (D2 candidate A), local object store. | wire, log-service | no |
| `mdbn-backup-verify` | Offline authenticated native cut/completion verifier; pure library and CLI, no network/provider access or current-authority assertion. | wire, log-service | no (native-only, no application/WASM consumer) |
| `mdbn-log-conformance` | Log service conformance suite (`log-service-api.md` §13), over the wire against any backend; `logsvc-bench` for D2. | wire, log-service, log-server | no |
| `mdbn-wasm` | `runtime.wasm`: core + replica + file layer behind a raw ABI. | core, wire, replica, store-file | yes |
| `mdbn-hosted-worker` | The hosted replica's engine for the Cloudflare Worker: one DO per collection, hosted mode over a disposable DO SQLite cache; metadata-only legacy import preflight. | core, wire, replica, store-file, noise, migrate-portable | yes |
| `mdbn-sim` | Deterministic simulator and seed sweeps. | core, wire, replica, store-file, log-service | lib is deterministic |
| `mdbn-bench` | Benchmarks for native, replicated and WASM runtime performance. | any library crate | no |
| `mdbn-local-host` | The native composition of a collection folder: FileStore + SqlStore/SqliteIndex + NativePlatform, the folder host lock, identity, the local-only drive loop. For `mdbase` and the daemon. | core, wire, replica, store-file, platform-native | no |
| `mdbase` | The public library: `Collection::open/init`, typed CRUD, CEL queries, validation, links, changes, batches over a local-only replica (`docs/library/README.md`). | core, wire, replica, store-file, platform-native, local-host | no |
| `mdbase-node` | The Node.js addon (napi-rs) behind `mdbase/node`: `mdbase::Collection` on its own thread, JSON calls. Ships inside the npm package only. | mdbase | no |
| `mdbn-trust` | The one verifier of the release environment trust asset (payload v1) against its authenticated context, and the normalized policy-pin output (canonical CBOR); `mdbn-trust verify` for build steps. Library does no I/O. | wire, replica | no (not linked into runtime.wasm) |
| `mdbn-daemon` | The desktop daemon and the `mdbase` CLI: one replica per collection, embedded local log, local IPC, control endpoint, keychain identity. | core, wire, replica, store-file, platform-native, local-host, log-service, legacy, noise, trust | no |
| `mdbase-wasm` | `mdbase-core.wasm`: the pure helpers (digests, JSON Schema, catalog, packs) behind the npm `mdbase` package (`docs/library/README.md`). | core | yes |
| `mdbn-conformance` | Spec fixture runner + ratchet; native side of the determinism replay. | core, wasm | no |
| `mdbn-legacy` | Read-only readers for old Connect/mdbase-rs state (connector SQLite, mutation journal, receipts, engine journals, role markers, locks), for migration. | nothing | no |
| `mdbn-migrate` | The migrator: hosted adoption (generation 0, re-seal, shadow verify), estimates, hosted rollback and the rehearsal oracle; re-exports the local takeover. A composition point. | migrate-portable, legacy, takeover, core, wire, replica, store-file, platform-native, store-pg | no |
| `mdbn-takeover` | The local takeover of old Connect collections (T0–T6) and local rollback; the daemon implements its traits and drives it. | legacy | no |
| `xtask` | Repo automation and the architecture check. | nothing | no |

Rules worth knowing:

- **Nothing depends on a store crate.** Stores depend on the replica (they
  implement its `Store` trait), and composition points (`mdbn-wasm`, `mdbn-sim`,
  `mdbn-bench`, future service binaries) wire a store to a replica.
- **The log service sees only `mdbn-wire`.** If it cannot interpret records, it
  cannot leak them.
- The table is code: `RULES` in `xtask/src/arch.rs`. A new crate fails CI until
  it gets a row there.

### Why the `mdbn-` prefix

- **No collisions.** mdbase-rs uses `mdbase`, `mdbase-runtime`, `mdbase-command`,
  `mdbase-testbed-adapter` and `mdbase-architecture-check`. The feasibility
  prototype uses `mdb-*`. `mdbn-` ("mdbase next") clashes with neither, so code,
  logs and `cargo tree` output never leave doubt about which system a crate belongs
  to, even when the three sit side by side in the reference worktrees.
- **Short.** The prefix is a namespace, not a description; the directory names
  (`core`, `replica`, `store-file`) carry the meaning.
- **Renameable.** Directories carry role names rather than package prefixes,
  keeping package naming separate from the source layout. A prefix rename is
  one mechanical replace of `mdbn-`/`mdbn_` in manifests, `use` paths and
  `xtask/src/arch.rs`.

## Build and test

Prerequisites: rustup (the toolchain in `rust-toolchain.toml` installs itself),
Node 22, and `cargo install cargo-deny` for the licence/advisory check.

```sh
cargo build                                  # native, all product crates
cargo test --workspace                       # unit tests + spec ratchet + golden replay
cargo xtask arch                             # crate boundaries + portability scan
cargo deny check                             # licenses, advisories, bans
npm ci --prefix tools/wasm                   # once: pinned wasm-opt
cargo xtask wasm                             # target/wasm/runtime.wasm
cargo xtask wasm-size                        # budget check
cargo xtask determinism                      # native vs WASM replay
cargo run -p mdbn-sim --release -- --seeds 1000
cargo xtask ci                               # all of the above, in CI order
```

Keep `target/` inside the worktree; never build under `/tmp` (see `AGENTS.md`).

## Determinism and portability

The core is bit-identical natively and in WASM. The portable crates
(core, wire, replica, store-file, wasm) are held to that by three layers:

1. **clippy** (`clippy.toml`, `deny` for every crate): bans `Instant`/`SystemTime`,
   `std::fs`, `std::env`, `thread::sleep`/`spawn`, `rand::thread_rng` and OS
   entropy, `HashMap`/`HashSet`, and transcendental float functions (`powf`,
   `exp`, `ln`, `sin`, ...: they use the platform libm natively and a compiled-in
   one in WASM). Crates that do real I/O opt out with a crate-root
   `#![allow(...)]`; portable crates may not.
2. **`cargo xtask arch`**: what clippy can't express. It token-scans portable
   sources (no `std::fs`/`env`/`net`/`process`/`thread` paths, no hash
   containers, no opting out of the bans), and resolves each portable crate's
   dependency tree for `wasm32-unknown-unknown` to reject `getrandom`, `rand`,
   `libc`, `regex`, `rusqlite`, `tokio`, `chrono`, `wasm-bindgen` and `js-sys`.
3. **cargo-deny**: workspace-wide bans (`regex`, since `regex-lite` is the decided
   flavour; unmaintained YAML crates) and no default/OS features on `getrandom`.

Time and entropy enter only through `mdbn_core::host::{Clock, Entropy}`.

## WASM size budget

`runtime.wasm` (core + replica + file layer, excluding sqlite-wasm) is built with
the `wasm-release` profile (`opt-level="z"`, `lto="fat"`, `codegen-units=1`,
`strip`, `debug=0`, `panic="abort"`) and then `wasm-opt -Oz` from the pinned
`binaryen` npm package.

| | raw | gzip -9 | brotli q11 |
|---|---|---|---|
| Target (Phase 5 exit) | 1.5 MB | 600 KB | 450 KB |
| Former ceiling (informational) | 3.3 MB | 1,350 KB | 1,000 KB |
| Today (core: YAML, writer, paths, Unicode tables) | 331 KB | 161 KB | 127 KB |

Units are decimal (1 MB = 1,000,000 bytes). The numbers live in
`tools/wasm/budget.json`. CI reports sizes in the job summary on every PR.

Standalone apps, including TaskNotes, have no bundle/WASM size limit. These measurements
and historical targets/ceilings are report-only, never PR/CI size gates. Do not size-qualify app changes or run size experiments. The only
small-bundle concern is the post-production Obsidian plugin; runtime safety and
architecture bounds are unaffected.

## Spec conformance ratchet

`conformance/spec/` vendors the rc.5 fixtures the core must pass: three-way merge,
body edits, the regex profile, paths, and move detection, plus the suite README
that defines their format. `conformance/spec/SOURCE` records the spec commit.
Refresh them with `scripts/sync-spec-fixtures.sh`.

`conformance/spec-expectations.txt` gives every fixture id a status:

- `pass`: a failure is a regression and fails CI;
- `pending`: expected to fail; an unexpected pass also fails CI until it is
  recorded;
- `skip`: not run.

To land a passing fixture, implement the core function, call it from
`crates/conformance/src/ops.rs`, run
`cargo run -p mdbn-conformance --bin spec-conformance -- --bless`, and commit the
diff. The CI job summary shows passing/pending counts per file. Every fixture
starts as pending.

## Determinism check

`cargo xtask determinism` replays each `conformance/determinism/*.log` twice: with
the native `replay` binary and with `runtime.wasm` under Node
(`scripts/wasm-replay.mjs`). Both call the same `mdbn_wasm::replay`. The outputs
must match each other and the committed `*.expected.json`. The log is a list of
core operations, one YAML flow mapping per line (`mdbn_core::replay` lists them),
and the golden file holds every operation's result, so a drift shows which
operation changed. Add operations to `conformance/determinism/core.log` as core
semantics land.

## CI

`.github/workflows/ci.yml` runs on PRs and pushes to `main`. Docs-only changes are
skipped, and superseded runs are cancelled.

| Job | Steps |
|---|---|
| fast lane | rustfmt, clippy `-D warnings`, `xtask arch`, cargo-deny, tests, spec ratchet (with summary) |
| wasm | wasm32 clippy, build `runtime.wasm`, size budget, native-vs-WASM determinism; uploads `runtime.wasm` |
| sim | seed sweep: 1,000 seeds on PRs and pushes, 100,000 nightly (cron; sim job only) |

Caches are saved only from `main`, and PRs restore them.

Native service-lifecycle jobs keep all three real service-manager checks on
GitHub-hosted disposable runners. Clippy and build share `CARGO_BUILD_TARGET`,
and the lifecycle check runs that exact target's binary. Trusted `main` pushes
that change dependencies/toolchains (or the native workflow) seed per-target
`native-lifecycle-v1` dependency caches; ordinary source merges do not add a
second native run. An explicit main `service-lifecycle` dispatch can seed them
once after landing. PR runs remain restore-only; a PR cache would not warm other
PRs. No service state or credentials are cached.

The heavy Log service DO build/test lane uses the existing private trusted Spot
pool under the same repository/actor/PR-author checks as Linux CI when
`MDBN_DO_SELF_HOSTED=true`. Leave it unset/false to route **new** DO jobs to
GitHub-hosted runners without changing other lanes or interrupting active jobs. Signing/attestation,
small control checks, and real OS service lifecycle stay GitHub-hosted. No worker
or disk increase is required. Compare queue time **and** execution time with the
same workload before claiming a speed or cost improvement. The main
`Log service DO` manual dispatch has a `runner` choice (`hosted`/`spot`/`automatic`)
so one bounded benchmark can seed Spot's main-scoped cache without switching
other jobs. Compare a subsequent warm Spot run with hosted at the same source;
never repeat a failed assertion to get green. Dispatch bundles cannot qualify
for signing: the existing attester requires successful **main push** producer
and full CI runs. At rollout the switch is false: the initial trial queued for
about eight minutes, so broad Spot routing is held pending speed acceptance.

`Dependency cache maintenance` runs every six hours. Its dry-run command is:

```sh
python3 -B scripts/ci/prune-actions-caches.py
```

`--apply` revalidates each deletion. Only default-branch `v0-rust` dependency
caches that are superseded and unused for six hours are eligible; two generations
per compiler/lane/OS family, recent entries, unknown keys, and non-main refs are
retained. Main native cache publication defers eviction. The goal is 8 GiB to
leave native-cache headroom within the existing 10 GB limit, **not** a storage
limit increase. Protected caches can keep usage above the goal. Local caches,
sources, jobs and artifacts are untouched. Run policy tests with
`python3 -B -m unittest discover -s scripts/ci -p 'test*.py' -v`.
