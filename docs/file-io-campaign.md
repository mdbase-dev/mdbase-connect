# File I/O performance campaign

## Objective

File-sized work for file-sized operations. Keep collection semantics in mdbase-rs,
exact grant checks at the connector, and durable per-transfer recovery. Replace
broad work with a canonical smaller operation rather than adding a parallel cache.

## Sequence

- Capture synthetic baselines, including work counts independent of host speed.
- Point lookup for downloads; verify a snapshot while copying it in one pass.
- Persist only changed index rows, retaining atomic change-feed updates.
- Remove Markdown materialization from ordinary file namespace checks.
- Reconcile only the upload target; reserve full scans for inventory/recovery.
- Bound chunk acknowledgement work without weakening durable retry semantics.
- Suppress identical Markdown writes after divergence validation.

## Invariants to test

Portable path aliases, structural resource ownership, custom record extensions,
nested collections, symlinks and hard links, same-size external edits, stale
revisions, changed physical identity, interrupted commits, out-of-order and
conflicting chunk retries, pinned downloads, and mirror-local edits all remain
protected. Do not infer safety from mtime alone at an authorization/read boundary.

## Evidence

Release-mode ignored tests use temporary synthetic collections. Report elapsed
samples alongside bytes hashed, rows loaded/written, full snapshots, and chunk
status rows. Fixture setup is excluded. Benchmarks are observations; correctness
and bounded-work assertions are regression gates. A final report will record
baseline/candidate commits, engine revision, workload, environment, and results.
