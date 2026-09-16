# File I/O campaign results

## Scope and reproducibility

All six reviewed areas are implemented. No campaign PR has been opened.

- Baseline Connect: `176c294a` (production algorithms unchanged; work counters added).
- Candidate Connect: `11d4e911`.
- Baseline engine: `c9e2e15bd3487faeaa15c5439139aac03e705fbe`.
- Candidate engine: `dd22a58b7eede54d7380747b9461ff9ebf3da61c`, on
  `perf/file-namespace-policy`; Connect pins it. This companion engine commit
  needs explicit review/integration with the eventual single Connect campaign PR.
- Five alternating before/after runs, optimized Rust, same host and lockfile,
  separate target directories. The same final benchmark module was used on the
  baseline, with a test-only download-copy counter; production algorithms were
  not backported. Fixture creation, initial index construction, and compilation
  are outside measured intervals.
- AMD Ryzen 9 7940HS, Linux. Default temporary fixtures use **tmpfs**. Those
  measurements characterize CPU/work amplification, not physical disk throughput.
  The Markdown microbenchmark uses an in-memory adapter.
- An additional five alternating runs used explicit **ext4** temporary fixtures.
  These showed large shared-host/fsync stalls (some phases varied over 10×), so
  disk-throughput improvements are **not established** by this run. All samples,
  including slower cases, are retained in `results.json`.

Run the workloads with `pnpm profile:file-io`. To exercise a particular storage
volume, set `TMPDIR` to an existing private directory on that volume. The Rust
fixtures remove their own temporary subdirectories. Run multiple rounds without
concurrent builds; keep the pinned engine checkout alongside Connect.

## Results: stable work reductions

Large-collection fixtures contain 1,000 Markdown records (4 KiB bodies) and 32
unrelated 1 MiB binary files. Small uploads and point downloads use 4 KiB files.

| Area | Before | After |
| --- | --- | --- |
| Upload inventory hashing | 100,667,392 bytes (~96 MiB) | 4,096 bytes, only the uploaded target |
| Upload full Markdown snapshots | 3 | 0 |
| Upload index insertions | 97 | 1 |
| Unchanged full integrity scan: index insertions | 32 | 0 |
| Point download: indexed rows loaded | 66 | 2 |
| 64 MiB download preparation | Copy 64 MiB, then hash-read staging 64 MiB | Copy and hash the same 64 MiB in one pass |
| 128 chunk acknowledgements: accumulated status rows | 8,256 | 0 |
| 1,000 identical Markdown materializations: writes | 1,000 | 0 |
| Identical Markdown materializations: digest calls | 2,000 | 1,000 |

Uploads still hash staged content (another 4 KiB in this fixture), and existing
replacement targets are verified exactly before accepting their revision. Full
integrity scans intentionally still hash their files; this is not a metadata-only
claim of integrity. Chunk receipts remain durable before acknowledgement, and
explicit resume/status requests still enumerate the complete receipt list once.

## Results: tmpfs/in-memory timing medians

These are synthetic observations, not production latency guarantees or timing
gates. Percentages refer to elapsed-time reduction, not throughput increases.

| Workload | Before | After | Change |
| --- | ---: | ---: | ---: |
| 4 KiB upload in large collection | 118.03 ms | 8.33 ms | 92.9% less |
| Unchanged full integrity scan, large collection | 37.86 ms | 23.55 ms | 37.8% less |
| Point download, large collection | 2.20 ms | 2.15 ms | ~2%; no material latency claim |
| Prepare 64 MiB pinned download | 67.43 ms | 60.06 ms | 10.9% less |
| 128 × 1 MiB chunk writes | 172.50 ms | 179.05 ms | 3.8% more; no observed latency win |
| 1,000 identical Markdown records, read-only | 8.84 ms | 6.39 ms | 27.7% less |
| 1,000 identical Markdown records, writable | 6.17 ms | 3.59 ms | 41.9% less |
| 1,000 changed Markdown records, read-only control | 8.08 ms | 8.14 ms | 0.7% more |
| 1,000 changed Markdown records, writable control | 7.06 ms | 7.48 ms | 6.0% more |

The chunk improvement is removal of quadratic bookkeeping, **not** a demonstrated
wall-clock gain at this size. Hashing, durable file writes, and database receipts
remain. The unchanged-work controls and noisy disk samples argue against treating
small percentage changes as established regressions or improvements.

## Architecture and correctness

- Engine-owned structural classification replaces full Markdown snapshots; no
  record-policy reimplementation or inventory cache was added to Connect.
- Full and targeted observations share the same identity/revision assignment,
  atomic sync change writer, and differential index persistence.
- Partial updates never assert completeness or clear outstanding full-inventory
  invalidation. Physical-identity changes are persisted even if public metadata
  is identical. Changed rows are removed before replacement insertion, retaining
  portable-path uniqueness during swaps.
- Point queries use existing `(collection_id, file_id)` and
  `(collection_id, path_key)` indexes; no schema migration is necessary.
- Pinned downloads retain private durable staging and size/digest verification.
- No wire version or response representation changed: chunk acknowledgements were
  already bounded; the old core unnecessarily constructed discarded full status.
- SHA-256 chunk calculation moved outside the SQLite write transaction. File sync
  and receipt insertion remain ordered inside the transaction to serialize
  conflicting retries; that correctness boundary was not weakened.
- Identical Markdown skips the write only after existing divergence checks and
  advances metadata. Byte-fenced inspector paths that skip reading still write.

Target inspection must enumerate containing-directory entries to reject portable
aliases. It does not traverse unrelated subtrees or read their contents. This is
bounded by namespace directories, not a claim that every operation is O(1).

## Validation

Passed:

- `cargo fmt --all -- --check`, architecture check, and `git diff --check`.
- Complete Connect Rust workspace tests (debug info disabled to limit build disk use).
- Engine library tests: 436 passed, one existing ignored test.
- `pnpm typecheck`, `pnpm test`, and isolated local `pnpm e2e`.
- Seven new Rust bounded-work/correctness regressions, existing file lifecycle and
  transfer tests, and eight focused mirror-materializer cases.
- Five-round tmpfs and five-round ext4 benchmark correctness assertions.

The first JS suite attempt encountered concurrent Electron first-install activity
in the fresh workspace. Initializing the dependency once and rerunning the complete
suite passed; no application code was changed to mask that environment failure.

Regression cases include unrelated invalid Markdown, structural/portable alias
rejection, same-size/same-mtime replacement conflicts, physical identity replacement,
pending inventory invalidation, out-of-order/retried chunks, interrupted commits,
revision-pinned downloads, local mirror divergence, and read-bypassing inspector paths.
