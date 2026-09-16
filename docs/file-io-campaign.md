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

## Implementation decisions

- Full and targeted observations use the same file eligibility rules, identity/
  revision assignment, sync change writer, and differential index persistence.
  Point updates preserve the completeness/dirty state of the full inventory.
- Namespace policy remains in mdbase-rs. Engine commit
  `dd22a58b7eede54d7380747b9461ff9ebf3da61c` shares the snapshot's structural
  resource classifier with `validate_file_path`; Connect pins that exact commit.
  This is a companion dependency commit on `perf/file-namespace-policy`, not a
  second implementation of collection semantics. Its integration must be included
  in campaign review before landing the Connect PR.
- Upload target inspection still checks portable aliases in each containing
  directory. It does not walk unrelated subtrees or read unrelated contents.
  Existing replacement targets are hashed exactly, including at commit: matching
  size/mtime alone cannot authorize replacement.
- Downloads retain private, durable, verified staging snapshots. Hashing is fused
  into the copy, eliminating a second read without streaming mutable source bytes
  to the client.
- Upload wire acknowledgements were already empty. The core now returns success
  rather than computing discarded resumability state. Frame-session lookup also
  omits that unused state. Open/status requests still return complete receipt lists;
  no protocol version or wire representation changed. Hashing the supplied chunk
  occurs before the SQLite write transaction, but file synchronization remains
  before durable receipt insertion. The transaction still serializes competing
  chunk writes/retries; this campaign does not remove that correctness boundary.
- Byte-identical Markdown avoids writes after the existing divergence checks;
  metadata still advances. Inspector paths that deliberately skip reading retain
  their existing write behavior rather than guessing equality.

### Reviewed architecture budget changes

One production module, `registry/files/index.rs`, isolates the existing SQLite row
codec and queries rather than extending the 1,000-line coordinator. Seven internal
Rust declarations are introduced: three SQLite helpers, two point lookup methods,
the target reconciler, and targeted file discovery. One additional engine
collection reference belongs to targeted discovery. These are concrete boundaries,
not new persisted state, wire APIs, cache layers, or fallback mechanisms.

## Evidence

Release-mode ignored tests use temporary synthetic collections. Report elapsed
samples alongside bytes hashed, rows loaded/written, full snapshots, and chunk
status rows. Fixture setup is excluded. Benchmarks are observations; correctness
and bounded-work assertions are regression gates. A final report will record
baseline/candidate commits, engine revision, workload, environment, and results.
