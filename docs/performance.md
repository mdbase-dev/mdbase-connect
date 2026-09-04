# Local performance profiling

The local loop has two complementary profilers. Both run optimized binaries
and avoid including collection paths, query inputs, frontmatter, or bodies in
their reports.

## Hosted mirror regression gate

`pnpm profile:mirror:check` exercises initial, no-op, and incremental
read-only sync plus initial and no-op writable sync over 10,000 in-memory
records. It compares wall time, peak heap, filesystem operations, and durable
checkpoints against `scripts/mirror-profile-baseline.json`.

The baseline records the exact source commit, Node runtime, platform, and
capture-round count. V8 heap accounting changes between Node major versions,
so recapture it from the recorded source commit with the repository's current
Node 24 runtime before comparing an implementation change. Never update the
numbers from the candidate implementation merely to make a regression pass.

## Fast query feedback

Run the deterministic mdbase-rs workload from this repository:

```bash
pnpm profile:rs
pnpm profile:rs -- --files 10000 --editor-iters 3 --json \
  --output /tmp/mdbase-query-profile.json
```

The `queries` scenario measures cache rebuild, filtered and projected v0.3
queries, and the editor's two-pass paginated index. It also reports schema,
preflight, cache, load, link graph, evaluation, sort, grouping, serialization,
and total phases. Use `--scenario core` to measure CRUD, runtime startup, and
mutation-plus-watcher synchronization; use `--scenario all` for both.

## End-to-end Connect core

The Connect profiler is read-only and can safely run against a real local
collection:

```bash
pnpm profile:connect -- --root /path/to/collection --scenario all
pnpm profile:connect -- --root /path/to/collection \
  --scenario editor --iterations 5 --json \
  --output /tmp/connect-profile.json
```

It measures a 200-record query page, a read, the editor's complete two-pass
index, and concurrent query batches through `CollectionRegistry` and the
filesystem provider. A temporary Connect registry is removed when the process
exits. Records, configuration, and types are never mutated; the collection's
internal `.mdbase` query cache may be refreshed as it would be by a normal
query.

## Live agent timings

Enable payload-free request timings while running the normal local agent:

```bash
MDBASE_CONNECT_PROFILE=1 cargo run -p mdbase-cli -- connect daemon run
```

Each completed local, relay, or encrypted operation logs `execute_us`,
`synchronize_us`, and `total_us`, along with the operation name, transport,
success state, and stable error code. No grant data, paths, inputs, or results
are logged.

For watcher decisions and refresh durations, add:

```bash
MDBASE_CONNECT_PROFILE=1 MDBASE_WATCH_PROFILE=1 \
  cargo run -p mdbase-cli -- connect daemon run
```

## CPU profiles

The workspace's `profiling` Cargo profile keeps release optimizations and adds
symbols suitable for sampling:

```bash
cargo build --profile profiling -p mdbase-cli
perf record -g --call-graph dwarf -- \
  target/profiling/mdbase profile connect --root /path/to/collection \
  --scenario editor --iterations 3
perf report
```

`samply record` or `cargo flamegraph` can replace `perf record`. Keep latency
JSON beside a CPU profile so changes can be compared at both the request and
function level.

## GitHub performance observations

`.github/workflows/performance-observations.yml` records the supported
payload-free profiles without making their timings merge or release gates.
It runs the release-mode engine and Connect profiles plus both in-memory mirror
adapters every Monday. On the first day of each month it also runs the existing
hosted-provider system suite with 10,000 records. Manual runs can select 5,000
or 10,000 engine records, the core iteration and concurrency counts, and
whether to include the provider lane.

Each run records the exact Connect commit, its pinned mdbase-rs commit, workload
parameters, workflow and lockfile digests, and separate runner fingerprints for
the core and provider jobs.
Raw producer reports and a normalized JSON/Markdown observation are retained as
GitHub artifacts for 90 days. Successful observations of the default branch are
also appended, without force-pushing, to the orphan `performance-history`
branch under `results/YYYY/MM/`. That branch contains only allowlisted aggregate
measurements; synthetic fixtures and system-test logs are not persisted.

GitHub-hosted runners vary in CPU model, storage, and host contention. Compare
results only when their workload, runtime, and runner fingerprints are
comparable, and prefer repeated trends over individual runs. Workflow failure
means that a build, functional assertion, report contract, or history write
failed—not that a timing became slower.

### Hosted-provider observation

The existing provider stress suite keeps its normal latency assertions under
`pnpm e2e:provider:stress`. Its observation form writes the same aggregate
metrics as standalone JSON while retaining all functional, authorization,
durability, pagination, bounded-work, and cleanup assertions:

```bash
pnpm profile:provider:observe
```

`MDBASE_CONNECT_PROVIDER_E2E_PERFORMANCE_OUTPUT` selects the JSON destination.
`MDBASE_CONNECT_PROVIDER_E2E_OBSERVATION_ONLY=1` disables only the five
runner-sensitive elapsed-time budgets and requires that output path. It does
not weaken correctness or bounded-query assertions.

The earlier beta.63 prototype included an encrypted-daemon profiler and an RSS
soak tied to the daemon architecture of that release. The scheduled workflow
recovers its durable-observation design, but deliberately uses the current
engine, Connect, mirror, and provider profilers rather than restoring those
retired runtime modules. Eight-hour functional soak profiles, private live-vault
profiles, CPU sampling, and staging or production network timing remain manual
because they are unsuitable for ordinary GitHub-hosted runners.
