# Hosted storage-model benchmark report

- Run: `2026-08-16-postgres18-local`
- Status: complete; awaiting user decision
- Decision: none accepted
- Connect revision: `57c7f56f34fd9125bb485b0f8fbe26bb13570fe1` (clean)
- mdbase-rs revision: `7c5a1800f66cc80e43cf2d60f5524e5b409ea4f0` (clean)
- PostgreSQL: 18.4, image `postgres:18`
- Fixtures: 10,000 records; 100,000 records; 230,128 records / 1,073,743,117 exact Markdown bytes

This report is benchmark evidence for discussion. It does not accept ADR 0011,
select a hosted storage model, authorize a migration, or change a public security
claim.

## Recommendation

Do not select or deploy any candidate yet. Candidate B-no-GIN is the strongest
research baseline if further work is authorized: it preserves encrypted exact
Markdown and bodies while making the frozen semantic projection queryable, and the
single allowed GIN index did not produce a material gate win. It is not ready for a
storage decision because it still fails frozen default-workload, latency, and
cancellation gates.

Candidate C is not recommendation-eligible. Both B variants fail the same six
unapproved ordering-budget workloads at 100,000 records and approximately 1 GiB;
both C variants fail them too. C-GIN is the only C cell that crosses one B latency
threshold (`mcp.selective_note` at 100,000 records), but its 298.84 ms p95 is only
3.83 ms below B-GIN's 302.67 ms p95 and lies well inside B-GIN's 12.17 ms sample
standard deviation. That is not a material resolution and cannot justify making
exact Markdown and bodies provider-readable.

## Evidence integrity

The runner completed all 15 candidate/tier cells and wrote 3,981 raw samples:
3,186 successes, 671 typed budget outcomes, 104 cancellations, and 20 expected
fault-injection errors. All 3,981 samples validate against
`raw-result.schema.json`. The environment record confirms clean revisions,
synthetic-only fixtures, and no contact with shared services.

The report uses nearest-rank observed quantiles and population standard deviation.
For five-sample approximately-1-GiB phases, p99 is the observed maximum. The
machine-readable `summary.json` contains all per-workload distributions rather than
only the representative values shown here.

The original raw `storage.backup_estimate` samples preserve a harness defect:
`pg_dump -Fc` used default compression although the frozen protocol specified an
uncompressed custom stream. They have not been edited or relabelled. A supplemental
read-only measurement used `pg_dump -Fc --compress=none` against every completed
disposable database; exact commands, bytes, and elapsed times are in
`backup-uncompressed.json`. Those supplemental values describe final scenario
state, not the earlier post-import instant.

## Independent evidence review

The `inventory_mcp_sdk` capability reviewer independently inspected the full raw
corpus, schemas, summary calculations, gates, report, and supplemental backup
evidence without editing files. It reproduced 3,981/3,981 schema-valid samples and
the byte-identical summary, confirmed the candidate conclusion, and identified four
reporting gaps: query release flags were not independently observed, rebuild
cancellation was omitted from the summary, rebuild byte/retry claims exceeded the
raw evidence, and reviewer provenance was absent. This revision incorporates those
findings. The reviewer was not the benchmark implementer.

## Gate results

| Gate | Result | Evidence |
| --- | --- | --- |
| Canonical semantic mismatches | Pass | 0 mismatches; exact IDs, order, pages, groups, response fields, and completeness digests checked against tracked expected artifacts |
| Authorization mismatches | Pass | 0 mismatches; current projection checks, stale/absent canonical fallback, revoked grants, corrupt exact/projection fail-closed paths exercised |
| Ambiguous recovery | Pass | 0; 54 injected mutation failures rolled back unambiguously, with rebuild resume/error/fencing evidence retained |
| Point-read p95 under concurrent scan | Pass | all 15 cells pass; approximately-1-GiB p95 1.94-3.01 ms against 250 ms |
| Provider RSS <=384 MiB | Pass | measured query maximum 85,209,088 bytes (81.3 MiB) |
| Scan pool occupancy <=25% of four connections | Pass | peak 1 connection |
| Query cancellation cleanup <5 s and releases observed | Fail / incomplete | approximately-1-GiB handler-return maxima: A 3.45 s; B-no-GIN 12.52 s; B-GIN 5.95 s; C-no-GIN 6.77 s; C-GIN 6.80 s. The query path sets release flags after rollback, but the runner does not independently verify sessions/resources afterward, so strict release evidence is unavailable for every tier. |
| Rebuild cancellation cleanup <5 s | Pass where applicable | B/C variants at 10k: 59-66 ms, zero PostgreSQL sessions observed after SIGTERM, checkpoint retained, and resume completed. Candidate A has no projection rebuild. |
| Successful metadata-query p95 <300 ms | Fail | B-no-GIN passes 8/9 cells at 10k, 2/7 successful cells at 100k, 0/7 at approximately 1 GiB; B-GIN is similar; C does not materially resolve it |
| Frozen default workload outcomes | Fail | all candidates pass 16/16 at 10k, 10/16 at 100k; at approximately 1 GiB A passes 3/16 while B/C variants pass 10/16 |

The six default-outcome failures shared by every candidate at 100,000 records and
approximately 1 GiB are:

- `tasknotes.broad_active_page`
- `tasknotes.group_status_count`
- `editor.metadata_index`
- `editor.body_hydration_page`
- `pickle.pending_inbox`
- `pickle.all_requests_page`

Every repetition returned typed `ordering` budget rejection. The frozen workload
contracts do not accept `ordering` for these shapes, so the outcomes are failures;
they were not reclassified after observation. At approximately 1 GiB, Candidate A
also returns unacceptable `scan` budgets for seven selective metadata/relationship
workloads. Candidate B's `scan` outcomes for `reader.body_search_common`,
`sdk.selective_body_no_return`, and contention are explicitly accepted by their
frozen contracts. Candidate C changes the body scans to success or an accepted
`result` budget but does not fix the shared ordering failures.

The separately labelled `large_fixture_v1` diagnostic entitlement produced 85
samples: per candidate, 9 successes, 6 ordering budgets, 1 result budget, and 1
cancellation. It never replaces the default-budget result.

## Representative query evidence

Approximately-1-GiB p95 values below include all five default-budget repetitions;
typed budget outcomes are shown separately from success.

| Variant | Selective TaskNotes | Reader body search | Selective body/no-return |
| --- | ---: | ---: | ---: |
| A | 9,607 ms, scan budget; 100,001 rows / 100,000 decrypts | 10,114 ms, scan budget; 100,001 / 100,000 | 9,604 ms, scan budget; 100,001 / 100,000 |
| B-no-GIN | 373 ms success; 522 rows / 0 decrypts | 8,293 ms, accepted scan budget; 100,001 / 100,000 | 8,038 ms, accepted scan budget; 100,001 / 100,000 |
| B-GIN | 436 ms success; 522 / 0 | 8,453 ms, accepted scan budget; 100,001 / 100,000 | 7,929 ms, accepted scan budget; 100,001 / 100,000 |
| C-no-GIN | 467 ms success; 522 / 0 | 7,767 ms, accepted result budget; 46,026 / 0 | 6,840 ms success; 24 / 0 |
| C-GIN | 531 ms success; 522 / 0 | 7,847 ms, accepted result budget; 46,026 / 0 | 6,785 ms success; 24 / 0 |

Candidate A's encrypted exact scans scale approximately linearly and cannot satisfy
selective default-budget queries at the largest tier. Candidate B materially
reduces candidate rows and removes decryption for projection-contained predicates,
but body predicates still hit the 100,000-record scan limit. Candidate C removes
decryption and enables SQL body filtering, but its representative metadata queries
are not faster than B and its body advantage does not cure the shared ordering or
cancellation gates.

KMS/key-cache numbers are a deterministic benchmark model, not observed external
KMS calls. Cold-key samples model one miss/unwrap, while warm encrypted scans model
cache hits. This limitation is carried in every relevant sample note.

## Storage, import, rebuild, and backup

Approximately-1-GiB post-import physical bytes:

| Variant | Database | Table | Projection relation | TOAST | Index | Uncompressed final backup stream |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 3.71 GiB | 242 MiB | 0 | 3.41 GiB | 62.8 MiB | 6.33 GiB |
| B-no-GIN | 4.00 GiB | 517 MiB | 290 MiB | 3.41 GiB | 77.2 MiB | 6.58 GiB |
| B-GIN | 4.07 GiB | 517 MiB | 364 MiB | 3.41 GiB | 151 MiB | 6.58 GiB |
| C-no-GIN | 1.04 GiB | 979 MiB | 290 MiB | 0.73 MiB | 81.7 MiB | 3.73 GiB |
| C-GIN | 1.11 GiB | 979 MiB | 359 MiB | 0.73 MiB | 151 MiB | 3.73 GiB |

Uncompressed logical backup streams do not contain materialized index pages, so
the no-GIN/GIN pairs are nearly identical there. Candidate C's smaller physical
database and backup reflect PostgreSQL compression of repetitive plaintext fixture
bodies; synthetic compressibility may not generalize to real collections.

| Variant | Import | Import WAL | Projection rebuild | Rebuild WAL | Explicit vacuum |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 130.6 s | 4.84 GiB | 0.01 s catalogue-only | n/a | 7.0 s |
| B-no-GIN | 212.5 s | 6.25 GiB | 49.9 s | 1.27 GiB | 16.0 s |
| B-GIN | 220.0 s | 6.64 GiB | 77.5 s | 2.40 GiB | 33.6 s |
| C-no-GIN | 76.6 s | 1.52 GiB | 51.6 s | 1.65 GiB | 5.0 s |
| C-GIN | 74.4 s | 1.93 GiB | 87.0 s | 3.11 GiB | 15.9 s |

The implementation and property tests enforce pinned catalog/generation snapshots,
128-row/4-MiB source batches, per-page checkpoints, CAS completion, and concurrent
record retry. The raw full-run evidence directly records completion checkpoints,
lease/generation fencing, durable injected-error state, process cancellation,
post-process PostgreSQL session cleanup, and resume. It does not record per-page
source bytes, retry counts, or a dedicated concurrent-row retry sample, so those
remain implementation/test evidence rather than measured Phase 3 facts. The full
run retains 20 expected validation errors:
4 corrupt-projection fail-closed classifications, 8 injected process exits,
4 generation supersessions, and 4 stolen-lease fences.

## Writes, HOT, dead tuples, and bloat

Approximately-1-GiB single-write p95 / mean-derived throughput:

| Variant | Body | Frontmatter | Path |
| --- | ---: | ---: | ---: |
| A | 2.77 ms / 465 s^-1 | 2.83 ms / 450 s^-1 | 2.69 ms / 434 s^-1 |
| B-no-GIN | 18.37 ms / 84 s^-1 | 18.22 ms / 92 s^-1 | 14.53 ms / 106 s^-1 |
| B-GIN | 18.39 ms / 84 s^-1 | 17.82 ms / 78 s^-1 | 16.47 ms / 84 s^-1 |
| C-no-GIN | 26.72 ms / 63 s^-1 | 16.88 ms / 80 s^-1 | 17.64 ms / 86 s^-1 |
| C-GIN | 17.79 ms / 84 s^-1 | 17.54 ms / 89 s^-1 | 17.21 ms / 80 s^-1 |

Post-scenario PostgreSQL counters (including projection rebuild updates, not just
the micro-write repetitions) show the GIN cost clearly:

| Variant | HOT rate | Dead tuples before vacuum | Bloat estimate |
| --- | ---: | ---: | ---: |
| A | 83.9% | 34 | 12 KiB |
| B-no-GIN | 75.3% | 14,534 | 9.2 MiB |
| B-GIN | 1.7% | 228,809 | 146 MiB |
| C-no-GIN | 76.7% | 33,307 | 38.0 MiB |
| C-GIN | 1.7% | 92,734 | 105 MiB |

The one GIN index approximately doubles B vacuum time, increases B rebuild time by
55%, nearly doubles B rebuild WAL, and collapses scenario-wide HOT rate without a
material gate win. This is evidence against adding it by default.

## Confidentiality and operational tradeoffs

- A exposes identifiers, sequence/timing, ciphertext and document lengths, and
  keyed path equality, while retaining encrypted exact content and metadata. Its
  bounded scan model is not memory-problematic here, but it fails scalable query
  gates and is the most provider-CPU/decryption intensive.
- B preserves encrypted exact Markdown, bodies, structural resources, versions,
  and changes, but exposes canonical path, canonical types, arbitrary persisted and
  effective frontmatter, projected relationships, validation diagnostics, file
  facts, and equality/frequency of projected values. Unknown frontmatter may itself
  contain sensitive prose. Projection generation, rebuild, authorization
  currentness, canonical fallback, and dual-state recovery make B the most complex
  operational model.
- C exposes exact Markdown, body text, raw frontmatter, paths, resources, versions,
  and changes to database/replica/snapshot/backup readers in addition to B's
  projection. Rollback cannot restore confidentiality after replication or backup.
  It simplifies decryption and exact-body filtering but retains projection/rebuild
  complexity for the frozen response contracts.
- GIN additionally exposes projected key/value posting frequency and imposes the
  write/rebuild/vacuum costs above. No per-field, full-text, range/order, blind, or
  automatic schema-property index was created.

## Complexity assessment

| Variant | Implementation | Migration | Operations |
| --- | --- | --- | --- |
| A | medium query executor; high encrypted scan/cancellation burden | lowest schema change | high provider CPU, KMS/cache modelling, bounded-scan tuning |
| B-no-GIN | highest: encryption plus projector, currentness, fallback, CAS, authorization and rebuild state machines | high: additive projection/backfill while preserving exact ciphertext | high: generation leases/checkpoints, dual-state recovery, backfill monitoring |
| B-GIN | B plus index lifecycle | B plus index build | highest B maintenance/WAL/vacuum cost |
| C-no-GIN | medium-high: readable exact plus the same projection contract/state machinery | highest confidentiality and compatibility risk; exact-state rewrite required | lower query/decrypt burden, but rebuild/currentness remains |
| C-GIN | C plus index lifecycle | C plus index build | highest C maintenance cost without a material gate win |

## Failures and uncertainties

- No candidate passes the frozen comparison. Shared ordering-budget failures begin
  at 100,000 records, and successful metadata latency degrades beyond 300 ms.
- Four largest-tier variants exceed the 5-second query-cancellation handler-return
  limit. Although the query path sets transaction, permit, and plaintext release
  flags after rollback, the runner does not independently observe post-process
  resource state; strict release evidence is therefore incomplete for every query
  cancellation cell. Rebuild cancellation has separate observed session cleanup and
  passes at 10k.
- C cancellation records PostgreSQL work but reports zero residual rows scanned;
  A/B provide residual-row evidence. C's cleanup evidence is valid, but its
  residual evaluation metric is weaker.
- Provider RSS includes tracked facts and the measured process, but allocator,
  hash-map, and query-buffer attribution is not exhaustive. V2 expected artifacts
  are generated outside the provider, but the small artifact is parsed inside the
  timed process.
- Pool occupancy samples are multi-point but remain `[1,1,1]`; the corpus does not
  measure two simultaneous active scans. Point reads do validate encrypted envelope
  and revision, but the raw sample exposes ID/revision/byte counts rather than a
  full serialized canonical response envelope.
- PostgreSQL ran without explicit container CPU or memory limits on one local AMD
  Ryzen 9 host. Results establish relative evidence, not cloud production SLOs.
- Fixture plaintext is deterministic and repetitive; PostgreSQL/backup compression
  ratios may differ materially for real user content.
- Initial-backup raw samples used default compression; corrected uncompressed
  samples are final-state supplemental evidence as described above.

## Reproduction and evidence files

From the clean Connect revision:

```sh
node scripts/hosted-storage-benchmark/run-benchmark.mjs \
  --run-id 2026-08-16-postgres18-local \
  --output docs/benchmarks/hosted-storage-model/results/2026-08-16-postgres18-local

node scripts/hosted-storage-benchmark/summarize-results.mjs \
  --input docs/benchmarks/hosted-storage-model/results/2026-08-16-postgres18-local/raw/samples.ndjson \
  --output docs/benchmarks/hosted-storage-model/results/2026-08-16-postgres18-local/summary.json \
  --workload-contract docs/benchmarks/hosted-storage-model/workload-contract.json

node scripts/hosted-storage-benchmark/measure-uncompressed-backups.mjs \
  --run-id 2026-08-16-postgres18-local \
  --container mdbase-benchmark-pg \
  --output docs/benchmarks/hosted-storage-model/results/2026-08-16-postgres18-local/backup-uncompressed.json
```

Evidence:

- `environment.json`: exact host/tool/database/revision capture
- `commands.log`: executed command ledger
- `checkpoints.ndjson`: resumable operation ledger
- `raw/samples.ndjson`: all schema-valid raw samples
- `summary.json`: deterministic distributions, gates, and full pass/fail matrix
- `backup-uncompressed.json`: supplemental corrected backup-stream measurement
- `run-complete.json`: full matrix completion marker

No hosted storage decision has been accepted. Stop here for user review.
