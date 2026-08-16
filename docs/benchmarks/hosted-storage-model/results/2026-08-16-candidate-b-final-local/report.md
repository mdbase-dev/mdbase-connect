# Candidate B final local storage and prototype-workload benchmark

- Run: `2026-08-16-candidate-b-final-local`
- Status: complete local evidence; not production authorization
- Candidate: B-no-GIN only
- Connect source revision: `a586b0b09b1a2f2d56a25ebd927e22fc74de08fa`
- mdbase-rs source revision: `d14cc1ed3bacc9baa414cc7188f8053d468b2d22`
- PostgreSQL: 18.4, image `postgres:18`
- Fixtures: 10,000 records; 100,000 records; 230,128 records containing
  1,073,743,117 exact Markdown bytes

## Conclusion

This clean B-no-GIN rerun confirms the selected storage model's earlier storage,
write-pressure, rebuild, recovery, semantic, authorization, memory, and point-read
evidence. It does not supersede production-executor measurements for page-at-a-time
queries. The benchmark runner deliberately preserves the frozen comparison
executor, including its repeat-to-completion ordering model and its incomplete
independent cancellation observation. Those prototype failures are implementation
evidence about that runner, not evidence that Candidate B requires an unbounded
top-K production executor.

The production executor now uses closed query-plan v10, exact schema-proven SQL
predicates, deterministic scalar keyset pages, bounded grouping, page-only exact
hydration, typed budgets, and fail-closed canonical fallback. Its separate evidence
is in
[`../2026-08-16-candidate-b-production-executor/report.md`](../2026-08-16-candidate-b-production-executor/report.md).

No general projection GIN is justified. The selected physical baseline remains
B-no-GIN with mandatory identity, path, cursor, generation, and relationship graph
indexes. Any future narrow projection index requires a real production-plan win
large enough to pay for measured WAL, rebuild, HOT, vacuum, and bloat costs.

## Evidence integrity

The runner completed all three requested tiers and wrote 800 schema-valid samples:
98 validation, 604 measured, and 98 warmup samples. Outcomes were 644 successes,
130 typed budgets, 21 deliberate cancellations, and five expected fault-injection
errors. Synthetic fixtures were used exclusively and no shared service was
contacted. Exact invocation, host/tool versions, frozen contract digests, commands,
checkpoints, samples, and the generated summary are retained beside this report.

The summary's top-level `variants` field enumerates the full frozen candidate
contract; the environment record and run-complete marker establish that this run
executed only `B-no-gin`.

## Gate interpretation

| Gate | Result | Interpretation |
| --- | --- | --- |
| Semantic parity | Pass | zero canonical mismatches |
| Authorization parity | Pass | zero mismatches across three focused samples |
| Ambiguous recovery | Pass | zero ambiguous outcomes |
| Concurrent point-read p95 | Pass | 1.72 ms at 10k, 1.90 ms at 100k, 3.49 ms at 230,128 |
| Provider RSS | Pass | maximum 66,404,352 bytes against 384 MiB |
| Pool occupancy | Pass | peak one of four connections |
| Rebuild cancellation | Pass at measured 10k cell | 61 ms, zero sessions afterward, checkpointed resume completed |
| Prototype query cancellation | Fail/incomplete | 148 ms at 10k, 26.84 s at 100k, 9.10 s at 230,128; runner did not independently observe releases |
| Frozen prototype default workloads | Fail | six ordering-budget workloads at 100k and 230,128 |
| Successful prototype metadata p95 <300 ms | Mixed/fail | 8/9 at 10k, 3/7 at 100k, 0/7 at 230,128 |

Typed budget outcomes remain distinct from success. The six frozen ordering failures
at both larger tiers are TaskNotes broad active page and group count, Editor metadata
index and body hydration, and Pickle pending/all-request pages. Production does not
reclassify those results; it replaces the prototype execution strategy and must be
validated under its own cursor/page contract.

## Storage and lifecycle

| Tier | Post-import database | Projection relation | TOAST | Indexes | Backup estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10k | 193,091,263 B | 13,180,928 B | 157,401,088 B | 3,506,176 B | 168,101,858 B |
| 100k | 1,866,307,263 B | 131,907,584 B | 1,586,946,048 B | 34,447,360 B | 1,693,039,083 B |
| 230,128 / ~1 GiB | 4,290,655,935 B | 303,996,928 B | 3,657,621,504 B | 80,961,536 B | 3,903,617,903 B |

At the largest tier, import completed in 625.2 seconds and emitted 6.82 GB of WAL.
Initial projection generation covered all 230,128 records in 14.5 seconds. The
post-write health sample recorded 176,270 HOT and 55,877 non-HOT updates, 20,885
dead tuples, and a 13.85 MB bloat estimate. Explicit vacuum took 335.0 seconds on
this local run. These unusually long import/vacuum observations are retained as
measured; the container had no explicit CPU/memory limits and the host filesystem
was 88% full.

Twenty largest-tier body writes had 17.7 ms median and 347.9 ms p95 latency; the
large tail means this local series is not a production SLO. Full distributions and
the corresponding frontmatter/path, WAL, CPU, I/O, rebuild, recovery, fencing, CAS,
and authorization metrics are in `summary.json` and `raw/samples.ndjson`.

## Confidentiality boundary

Candidate B keeps exact Markdown and body prose application-encrypted. PostgreSQL,
replicas, snapshots, and backups can read the derived semantic projection: paths,
file facts, canonical types, persisted/effective frontmatter, diagnostics,
relationships, and body-derived structural facts. Values placed in frontmatter may
therefore expose sensitive prose. Relationship syntax and resolved targets expose
graph structure. The projection is non-authoritative, versioned, bound to an exact
revision, and rebuildable by mdbase-rs.

This run does not change customer-facing promises or authorize existing-data
migration. Its fixtures are disposable and synthetic.

## Reproduction

From the recorded clean Connect revision:

```sh
node scripts/hosted-storage-benchmark/run-benchmark.mjs \
  --run-id 2026-08-16-candidate-b-final-local \
  --output docs/benchmarks/hosted-storage-model/results/2026-08-16-candidate-b-final-local \
  --tiers records-10000,records-100000,canonical-1gib \
  --variants b-no-gin
```

The exact expanded commands and outputs are in `commands.log`; `environment.json`
captures tool versions, PostgreSQL settings, source revisions and contract digests;
`checkpoints.ndjson` records resumability; `run-complete.json` is the terminal
marker. Recompute the machine summary with the tracked summarizer and compare it
byte-for-byte with `summary.json`.
