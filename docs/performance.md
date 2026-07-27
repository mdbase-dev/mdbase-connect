# Local performance profiling

The local loop has two complementary profilers. Both run optimized binaries
and avoid including collection paths, query inputs, frontmatter, or bodies in
their reports.

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
pnpm profile:connect -- --collection /path/to/collection --scenario all
pnpm profile:connect -- --collection /path/to/collection \
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
MDBASE_CONNECT_PROFILE=1 cargo run -p mdbase-connect -- daemon run
```

Each completed local, relay, or encrypted operation logs `execute_us`,
`synchronize_us`, and `total_us`, along with the operation name, transport,
success state, and stable error code. No grant data, paths, inputs, or results
are logged.

For watcher decisions and refresh durations, add:

```bash
MDBASE_CONNECT_PROFILE=1 MDBASE_WATCH_PROFILE=1 \
  cargo run -p mdbase-connect -- daemon run
```

## CPU profiles

The workspace's `profiling` Cargo profile keeps release optimizations and adds
symbols suitable for sampling:

```bash
cargo build --profile profiling -p mdbase-connect-core --bin connect-profile
perf record -g --call-graph dwarf -- \
  target/profiling/connect-profile --collection /path/to/collection \
  --scenario editor --iterations 3
perf report
```

`samply record` or `cargo flamegraph` can replace `perf record`. Keep latency
JSON beside a CPU profile so changes can be compared at both the request and
function level.
