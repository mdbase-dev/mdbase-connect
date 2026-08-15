# Frozen measurement protocol

Status: frozen before candidate measurements. Existing hosted execution limits are
comparison inputs and are not raised to manufacture a pass.

## Revisions and environment capture

Every run records:

- Connect, mdbase-rs, harness, workload, fixture, schema, and budget-manifest Git
  revisions plus dirty-state flags;
- OS/kernel, CPU model/count, total memory, filesystem, Docker, PostgreSQL image and
  server version, Rust, Node, and OpenSSL/runtime versions;
- container CPU/memory limits, PostgreSQL settings, shared buffers, work memory,
  maintenance work memory, WAL settings, autovacuum state, and database size before
  and after each phase; and
- candidate, GIN variant, fixture manifest digest, seed, repetition, warm/cold key
  cache state, and timestamps.

The canonical PostgreSQL image is `postgres:18` and each candidate/tier starts in a
fresh disposable database on the same local container runtime. No production or
shared staging service is contacted.

## Fixture tiers

- `records-10000`: exactly 10,000 records.
- `records-100000`: exactly 100,000 records.
- `canonical-1gib`: deterministic records from the same distribution until
  canonical exact Markdown bytes first equal or exceed 1,073,741,824 bytes. The
  manifest records the resulting count and overshoot.

Resources, seed, type mix, metadata distributions, and workload parameters are
identical across candidates. Generated content is synthetic and contains no
production-derived strings.

## Samples

- Import/backfill/rebuild/recovery: one measured cold run after one harness
  validation run per candidate/tier; destructive phases use fresh databases.
- Queries: 2 warmups followed by 7 measured repetitions per shape for 10k/100k;
  1 warmup followed by 5 measurements for the approximately-1-GiB tier.
- Writes: 2 warmups and 20 measured operations of each body, frontmatter, path, and
  resource shape; report throughput for batches of 100 where the fixture permits.
- Cancellation/contention: 5 repetitions. Start cancellation at the frozen 50 ms
  boundary; measure time until transaction, pool permit, and accounted plaintext
  bytes are released.
- Cold-key query samples clear only the benchmark process key cache and record one
  unwrap/miss. Warm samples retain the one collection key and record cache hits.

Report p50, p95, p99 when the sample count supports them, plus minimum, maximum,
mean, standard deviation, and every raw sample. For five-sample 1-GiB phases, p99 is
the observed maximum and is labelled accordingly.

## Unchanged execution budgets

The harness reads `config/hosted-execution-budgets.json`. In normal comparison:

- scanned records: 100,000;
- scanned ciphertext/plaintext input: 1 GiB;
- operation deadline and read snapshot: 30 seconds;
- record batch: 128 rows / 4 MiB ciphertext;
- simultaneously decrypted bytes: 8 MiB;
- result items/bytes: 10,000 / 16 MiB;
- top-K and offset: 10,000;
- groups/aggregation state: 2,000 / 8 MiB;
- active scans: 2 per provider process; and
- cancellation cleanup: 5 seconds.

The existing `large_fixture_v1` entitlement may be used only for the explicitly
labelled 1-GiB diagnostic pass. Its outcome is reported separately and never
substituted for the default-budget result.

## Raw result schema

Every line in `raw/*.ndjson` is a JSON object with:

```text
schema_version, run_id, candidate, variant, tier, fixture_digest,
phase, workload_id, repetition, sample_role, cache_state,
workload_contract_digest, fixture_contract_digest, schema_digest,
budget_manifest_revision, budget_manifest_digest,
outcome(success|budget|cancelled|error), budget_kind, error_code,
error_details, started_at, elapsed_ms, rows_selected, rows_scanned,
sql_candidate_rows, canonical_rows_evaluated, documents_decrypted,
ciphertext_bytes, plaintext_bytes, result_items, result_bytes,
completeness_digest, key_cache_hits, key_cache_misses, kms_unwraps,
provider_cpu_ms, provider_rss_bytes, provider_pss_bytes,
accounted_operator_bytes_peak, cancellation_cleanup_ms,
postgres_cpu_ms, postgres_blocks_read, postgres_blocks_hit,
postgres_temp_bytes, pool_connections_peak, pool_connections_average,
pool_wait_ms, snapshot_lifetime_ms, table_bytes, projection_bytes,
toast_bytes, index_bytes, wal_bytes, backup_estimate_bytes, hot_updates,
non_hot_updates, dead_tuples, vacuum_elapsed_ms, bloat_estimate_bytes,
failure_stage, checkpoint_record_id, lease_state, recovery_state,
authorization_classification, transaction_released, pool_permit_released,
plaintext_released, page_boundaries, relation_sizes, database_bytes_before,
database_bytes_after, notes
```

Null means not applicable or unavailable, never zero-by-default. `budget_kind` is
required and non-null only for `outcome = budget`; `error_code` is required and
non-null only for `outcome = error`. Budget rejection is a valid service outcome
but a workload gate passes it only when the frozen workload contract explicitly
permits that budget kind. Cancellation and typed errors use their separate frozen
allow-lists.

## Storage and write accounting

- Table/index/TOAST sizes use `pg_relation_size`, `pg_indexes_size`, and
  `pg_total_relation_size`, retaining per-relation rows in raw evidence.
- WAL is the byte difference between `pg_current_wal_insert_lsn()` samples.
- Backup estimate uses an uncompressed custom-format `pg_dump` byte count and is
  labelled an estimate rather than logical plaintext size.
- HOT/non-HOT/dead tuple/vacuum counters use `pg_stat_user_tables` after an explicit
  stats flush. Bloat estimate records its exact query and extension availability.
- Body-only writes omit unchanged projection/path columns. Frontmatter/path/resource
  writes update the required semantic state. Resource rebuild begins only after its
  state transition commits.

## Query and correctness accounting

The harness records SQL candidate rows separately from canonical scanned/evaluated
rows. `documents_decrypted` counts successful exact-document decryptions, not rows
whose projection alone suffices. Completeness is checked against canonical
mdbase-rs expected record IDs, order, page boundaries, group values/counts, summary
values, and response-field digest.

Candidate IR property tests generate false-positive cases and require zero false
negatives. Stale/missing projections are included by union and canonically
evaluated. Authorization correctness has zero tolerated mismatch.

## Gates

- Semantic mismatch, authorization mismatch, or ambiguous recovery outcome: zero
  tolerance.
- Point read p95 under concurrent scans: 250 ms.
- Steady provider RSS: at most 384 MiB.
- Scan pool occupancy: at most 25% of configured pool.
- Successful common metadata query p95: 300 ms.
- Every cancellation releases resources within 5 seconds.
- A required default-budget workload may not be reclassified as acceptable after
  results are observed.

Candidate C is recommendation-eligible only if at least one required common
workload fails both B variants, the corresponding C variant materially changes it
to a passing result, and the report separately presents the irreversible
confidentiality cost. Latency improvement alone is insufficient.
