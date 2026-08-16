# Candidate B production executor: bounded high-cardinality evidence

Date: 2026-08-16  
Status: implementation evidence; not a production rollout authorization

## Outcome

The production Candidate B executor completed its ignored PostgreSQL integration
mission with 100,001 live nonmatching decoys above the 10,000-row transfer budget.
It returned the canonical result during the test, excluded a candidate-matching
orphan projection, and reconstructed one stale exact authority without materializing
a collection-wide `WorkingSet`. Two clean disposable-database runs took 8.85 and
15.51 seconds respectively, including deterministic fixture construction, migration,
and import; this is setup-inclusive mission time rather than page latency.

The isolated worst-case candidate SQL plan was also measured after the selected
authority was tombstoned. It returned zero rows, transferred no projection payloads,
used no temp files, generated no WAL, and completed in 345.119 ms on local
PostgreSQL 18.4. The plan retained 7,654 KiB for its live-row hash and 25 KiB for
its final sort.

This result proves bounded transfer and semantic fallback at 100k. It does **not**
prove sublinear PostgreSQL work for JSON tag predicates: the no-GIN baseline scanned
100,003 projection rows and evaluated the tag subplan 100,001 times. This is a
measured physical cost, not a correctness or memory-bound failure. It remains an
index-selection input for shared-staging contention and repeated-page missions.

## Frozen fixture and plan

- 100,003 record-version rows: 100,001 live decoys, one selected authority, and one
  fault/tombstone row.
- 100,003 projections plus a candidate-matching projection with no live authority
  during the end-to-end assertion.
- One live exact ciphertext; synthetic decoys deliberately have null ciphertext so
  this fixture isolates candidate SQL and transfer behavior.
- Candidate: canonical hierarchical `file.hasTag("task")`.
- No general projection GIN or automatic field index.
- Production live-version, revision, catalog, projection-format, engine,
  completeness, stale-union, orphan-exclusion, ordering, and limit predicates.

The exact SQL is in
[`reproduce-100k-tag-plan.sql`](./reproduce-100k-tag-plan.sql). The captured metrics
and explicit limitations are in
[`raw/100k-tag-plan-summary.json`](./raw/100k-tag-plan-summary.json).

## Physical evidence

| Metric | Observed |
| --- | ---: |
| Query execution | 345.119 ms |
| Planning | 0.933 ms |
| Rows removed by candidate filter | 100,001 |
| Tag function loops | 100,001 |
| Shared hit blocks | 108,610 |
| Shared read blocks | 12,315 |
| Temp blocks | 0 |
| WAL records / bytes | 0 / 0 |
| Projection JSON bytes | 130,503,947 |
| Projection table / indexes | 163,856,384 / 58,753,024 bytes |
| Version table / indexes | 10,928,128 / 16,171,008 bytes |

The broader deterministic Candidate A/B/C benchmark remains the source for 10k,
100k, approximately-1-GiB storage, WAL, write pressure, HOT, rebuild, recovery, and
cross-candidate comparison. Those prototype executor timings must not be confused
with this production query path. Conversely, this synthetic executor fixture is not
a replacement for the prototype's encrypted-payload, write, and storage evidence.

## Gate interpretation

- Correctness and no-orphan gate: pass.
- Transfer/result budget gate: pass.
- Provider plaintext/decryption gate: pass for the measured current-projection
  path; one stale exact record is covered by the end-to-end mission.
- PostgreSQL temp/memory gate: pass locally.
- 100k common-operation latency gate: provisionally pass for one local execution;
  shared-staging distributions and contention remain required.
- Narrow-index decision: deferred. The plan demonstrates collection-scale JSON tag
  CPU/I/O, but a write-costed shared-staging workload is required before adding a
physical tag index. A general projection GIN remains unjustified.

## Exact scalar filtering and grouping

The later query-plan v10 production path proves schema-backed scalar types in
mdbase-rs and pushes exact string/boolean candidate predicates, scalar ordering,
counting, and count grouping into PostgreSQL. It does not use the prototype's
repeat-to-completion top-K operator. Page bodies are decrypted only after the
bounded page of identities has been selected.

Two ignored PostgreSQL missions were rerun at Connect `5caee699` after removing
redundant reconstruction of the live-version set and adding fixed-width
expected/observed row-digest verification before candidate selection:

| Mission | Exact filtered page | Count grouping | Setup-inclusive test |
| --- | ---: | ---: | ---: |
| 100,001 decoys | 1,956 ms | 1,615 ms | 50.97 s |
| 230,128 decoys | 3,052 ms | 4,633 ms | 144.26 s |

Both missions passed canonical output, orphan exclusion, malformed-projection
fail-closed fallback, and the 15-second operation time budget in an unoptimized
Rust test build. The selected result cardinality was two. The setup duration now
also includes trigger-side digest construction for every directly inserted
synthetic projection; it is conservative write-pressure evidence and is not a
production rebuild or ciphertext import measurement. Read-time SQL compares two
stored 32-byte digests and does not detoast/re-hash semantic JSON. These single
local observations prove bounded production execution at the target sizes; they
are not percentile latency evidence. The machine-readable record is
[`raw/scalar-filter-group-timings.json`](./raw/scalar-filter-group-timings.json).

## Current-head page latency distributions

The corrected production fixture at Connect `026ae2ac` and mdbase-rs `6185e6a`
runs a true page-at-a-time keyset traversal. The 100k fixture now contains exactly
100,000 live records rather than 100,004, and the high-cardinality missions use a
200-record page so repeated pagination cannot be mistaken for one unbounded top-K
operation. Each page uses a new request ID and encrypted replay receipt.

| Live records | Samples | Page 1 median / p95 | Page 2 median / p95 | Page 10 median / p95 | Group median / p95 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,004 | 7 | 136 / 158 ms | 88 / 95 ms | 69 / 78 ms | 121 / 155 ms |
| 100,000 | 7 | 984 / 2,927 ms | 333 / 361 ms | 327 / 560 ms | 968 / 1,075 ms |
| 230,131 | 5 | 2,327 / 4,137 ms | 840 / 1,025 ms | 840 / 1,154 ms | 1,651 / 2,119 ms |

Every observed page and grouping sample passed the 15-second typed operation-time
gate. The 230k mission used the explicit `large_fixture_v1` entitlement in a
release-optimized build with debug assertions; that test-only mechanism does not
raise the production 100k scan ceiling. Full samples, setup-inclusive durations,
commands, revisions, and percentile rules are in
[`raw/page-latency-distributions.json`](./raw/page-latency-distributions.json).

These distributions supersede the earlier single observations for query latency.
They do not supersede the earlier plan, write-pressure, storage, WAL, rebuild, or
cross-candidate evidence. Shared-staging contention, process memory, cancellation,
and point-read coexistence remain separate rollout gates.

## Final sustained local rollout gates

The exact-head 100-repetition production-executor run at Connect `ca520290` with
mdbase-rs `d453de9` supersedes the seven-sample latency table above and the earlier
`0a8c683a` sustained run. It includes the metadata-first Base projection transfer
guard, streaming provider reducer, and database-side group-key preflight added after
independent performance review. Every sustained p95 passed the published 300 ms
gate:

| Workload | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Path page 1 | 26 ms | 33 ms | 36 ms | 38 ms |
| Path page 2 | 27 ms | 36 ms | 42 ms | 682 ms |
| Path page 10 | 28 ms | 34 ms | 36 ms | 37 ms |
| Mtime page 1 | 26 ms | 35 ms | 37 ms | 37 ms |
| Mtime page 2 | 27 ms | 37 ms | 59 ms | 154 ms |
| Count grouping | 211 ms | 223 ms | 346 ms | 393 ms |

These are one-operation-per-page measurements with a 200-row page. They are not a
repeat-to-completion top-K timing. The page plans select 201 identities through the
path or mtime cursor indexes, prove the live record revisions, and transfer only the
bounded page. Representative `EXPLAIN (ANALYZE, BUFFERS)` observations completed in
1.688 ms for path and 1.842 ms for mtime without an explicit sort. Count grouping
scans the authorized 100k snapshot by design. Its current group-key width preflight
completed in 69.913 ms with no temporary blocks; the subsequent two-group plan
completed in 81.572 ms with a 3,073 KiB in-memory sort, no temporary blocks, and
10,464 KiB peak parallel live-version hash memory. A separate 128-record fixture
with approximately 67 KiB distinct keys returned the typed
`hosted_aggregation_state_budget_exceeded` outcome before aggregate execution and
increased PostgreSQL temp bytes by zero. The 100k fixture was then rewritten to
contain at least 2,501 distinct short grouping keys. It returned
`hosted_group_budget_exceeded` after observing the bounded 2,001st group and
increased PostgreSQL temp bytes by zero. The sustained application-level group p95
was 223 ms. Above 100k records, the production manifest rejects this
collection-wide operator with typed
`hosted_scan_budget_exceeded`; the debug-only entitlement run is retained solely as
correctness, cancellation, and resource-release evidence.

The final cancellation mission independently observed the PostgreSQL backend,
transaction, query-pool checkout, scan permit, accounted execution bytes, and
plaintext scope. Cancellation released every observation within five seconds, and
both an exact point read and a group query succeeded on the reused pool afterward.

After the exact-head fresh-server run and the adversarial 2,500-record cardinality
rewrite/probe, PostgreSQL reported 319,887,039 database bytes, 367,470,263 WAL bytes
from server start, 277,266,432 projection relation bytes, and 29,057,024
record-version relation bytes. The preceding clean 100k run at `d89007a0` remains
separately recorded as 308,483,775 database bytes, 353,833,475 WAL bytes, and
266,747,904 projection relation bytes.
The frozen B-no-GIN storage benchmark remains the authority for the true
approximately-1-GiB content tier: 230,128 records and 1,073,743,117 exact Markdown
bytes produced a 4,290,655,935-byte database and 6.82 GB WAL during import. These
storage figures are not inferred from the lean synthetic production-executor rows.

The complete final gate record, physical sizes, plan observations, typed large-tier
outcome, cleanup observations, and evidence limitations are machine-readable in
[`raw/final-rollout-gates.json`](./raw/final-rollout-gates.json). All 600 exact-head
latency samples, revisions, current physical observations, and group-plan evidence
are retained in
[`raw/exact-head-sustained-latency.json`](./raw/exact-head-sustained-latency.json).
The evidence does not justify a general projection GIN or any automatic field index.
