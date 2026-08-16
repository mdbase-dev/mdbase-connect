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
