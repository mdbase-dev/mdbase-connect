# Performance observations

The legacy connector and `mdbase-rs` engine profilers (`pnpm profile:rs`,
`profile:connect`, `profile:writes`, `profile:finalizer`, `profile:mirror*`) were
removed with the legacy connector; their measurements remain in this file's Git
history. Runtime contention invariants are recorded in
[runtime contention fixes](benchmarks/runtime-contention/report.md).

## GitHub performance observations

`.github/workflows/performance-observations.yml` runs the hosted-provider system
suite with 10,000 records on the first day of each month and on dispatch. It is
informational: its timings are not merge or release gates. The raw provider
report and a runner fingerprint are retained as GitHub artifacts for 90 days.

GitHub-hosted runners vary in CPU model, storage, and host contention. Compare
results only when their workload, runtime, and runner fingerprints are
comparable, and prefer repeated trends over individual runs.

## Hosted-provider observation

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
