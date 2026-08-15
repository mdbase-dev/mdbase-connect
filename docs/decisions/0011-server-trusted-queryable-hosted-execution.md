# ADR 0011: Hosted query storage model and bounded execution

- Status: proposed
- Date proposed: 2026-08-15
- Review revision: 2026-08-16
- Connect checkpoint: `444ed9f86f6265d1960c5e17a5976d3559aef359`
- mdbase-rs checkpoint: `e8d84a774b8a3ddfd8efc952b4eddb455b3bf6a0`
- Reconsiders: ADR 0010's post-Phase-1 encrypted query/storage decisions
- Retains regardless of outcome: provider-neutral mdbase-rs semantics, direct
  point reads, bounded execution, horizontal providers, and `WorkingSet` deletion
- Tracked benchmark record: `docs/benchmarks/hosted-storage-model/README.md`
- Local execution task: `.ops/tasks/Queryable hosted collection execution.md`
- Decision authority: user review after the comparative benchmark

## Status and scope

This ADR records an unresolved storage-model decision. It does not authorize a
provider-readable schema, a migration, a public security-claim change, or any
production write. The authorized work is limited to preserving the existing
checkpoint, freezing representative workloads and confidentiality requirements,
specifying the projection/authorization state machine, building disposable
prototypes, and benchmarking the alternatives below.

The implementation agent must stop after publishing reproducible benchmark
evidence. Selection of a storage model and continuation into production-quality
schema or query implementation require a separate user decision.

## Context

The hosted provider currently reconstructs a complete decrypted temporary
filesystem collection for many operations. ADR 0010 established a provider-neutral
mdbase-rs catalogue and record boundary, explicit execution budgets, and temporary
`WorkingSet` containment. Its staged Phase 1 direct point read proved that one
encrypted row can be selected, decrypted, and evaluated without loading unrelated
records: a 10,003-record cold read completed in 41.52 ms and warm p95 was 31.39 ms.

Removing `WorkingSet` and removing exact-document encryption are independent
decisions. Bounded record-oriented execution is required under every storage model.
The open question is how much provider-readable derived or canonical state should
be persisted to make common hosted application queries useful without surrendering
more database/backup confidentiality than the workload requires.

The previously drafted form of this ADR incorrectly compared encrypted full scans
only with fully provider-readable records. It omitted the strongest hybrid: retain
encrypted exact Markdown, persist a provider-readable mdbase-rs-derived projection,
select candidates in SQL, and decrypt only records whose exact content or residual
semantics require it. That hybrid is now a first-class candidate.

## Accepted invariants

These decisions do not depend on which storage candidate wins:

1. Exact Markdown remains the authoritative hosted record representation.
2. mdbase-rs remains the sole implementation of Markdown parsing, type matching,
   inheritance, defaults, CEL semantics, views, contracts, validation, diagnostics,
   ordering, grouping, aggregation, and mutation planning.
3. mdbase-rs produces any persisted semantic projection and compiles any safe
   candidate-selection plan.
4. mdbase-connect may translate only a closed, versioned, parameterized candidate
   IR. It does not independently translate arbitrary CEL or infer field semantics.
5. Candidate selection may produce false positives but never false negatives.
6. Canonical residual evaluation remains available and authoritative.
7. Point reads and exact mutations use direct record identity rather than a
   collection-wide workspace.
8. Broad work is streamed in bounded batches with explicit input, operator, result,
   time, connection, cancellation, and process budgets.
9. No unsupported operation silently falls back to `WorkingSet`.
10. Existing journals, fencing, idempotency, receipts, changes, quotas, grants,
    recovery, and outbox ownership remain in mdbase-connect.
11. Local and relay-only collection security boundaries do not change.
12. No permanent pair of hosted product modes is selected by this benchmark. It
    compares implementation candidates for one eventual standard hosted model.

## Storage candidates

### Candidate A: encrypted canonical records with bounded scans

- Exact Markdown and existing record payloads remain application-layer encrypted.
- No provider-readable semantic projection is persisted.
- Direct point operations retain HMAC identity lookup and selected-row decryption.
- Queries use safe existing metadata where available, then bounded ciphertext scans
  and canonical evaluation.

This is the confidentiality baseline and the ADR 0010 direction. It protects exact
documents, bodies, and frontmatter from database/backup disclosure without provider
keys, but common metadata queries may scan and decrypt many records.

### Candidate B: encrypted canonical records with readable projections

- Exact Markdown remains application-layer encrypted.
- mdbase-rs produces a provider-readable, revision-bound semantic projection.
- SQL selects candidates from current projections.
- Projection-sufficient queries may complete without decrypting exact documents.
- Records are decrypted only when the response requests exact/body content, the
  residual evaluator requires facts absent from the projection, or authorization
  cannot safely use a current projection.
- Broad body predicates fall back to bounded ciphertext scans.

This candidate preserves database/backup confidentiality for bodies and exact
non-projected Markdown while exposing every value deliberately included in the
projection. It is not database-private as a whole. Its privacy inventory must state
whether paths, raw/effective frontmatter, types, relationships, diagnostics, or
other derived values are visible.

### Candidate C: provider-readable canonical records with projections

- Exact Markdown and semantic projections are provider-readable at the PostgreSQL
  logical layer.
- SQL selects candidates from projections.
- Residual body and exact-document evaluation does not require decryption.

This candidate can make broad body-dependent operations cheaper and simplifies
some storage access, but it irreversibly changes the current database/backup
confidentiality promise once written to replicas, snapshots, backups, logs, or
forensic copies.

### Index variants

Candidate A is the no-readable-projection baseline. Candidates B and C are each
measured with:

- no general projection GIN index; and
- one `jsonb_path_ops` containment GIN index where the frozen query compiler can
  safely use it.

All variants use only the existing identity/path/access indexes needed for their
current representation unless the benchmark manifest explicitly names another
physical index. Do not add per-field B-tree, full-text body, range/order, automatic
schema-property, blind, or order-revealing indexes during this comparison.

## Frozen workload and confidentiality contract

Before prototype measurements begin, publish the exact workload corpus in the
tracked benchmark record. Derive it from current TaskNotes, Reader/literature,
Editor, Pickle, MCP, and generic SDK behavior rather than invented predicates. At a
minimum it must include:

- selective type plus exact/membership frontmatter filtering;
- broad type filtering;
- common status/tag/date/project relationships;
- metadata projection with fixed limit;
- ordering/top-K and ordinary pagination;
- metadata queries that return exact documents or bodies;
- selective and broad body predicates;
- grouping/count/summary shapes currently used by consumers;
- invalid, over-budget, cancellation, and concurrent point-read cases;
- debounced body-heavy writes whose semantic projection is unchanged;
- frontmatter/path writes whose projection changes; and
- type/resource changes followed by projection rebuild.

For each shape freeze fixture distribution, selectivity, result size, ordering,
pagination, required response fields, expected canonical result, and whether a
typed budget outcome is an acceptable service result. “Common query” must refer to
this versioned corpus rather than an informal latency target.

Also publish a confidentiality inventory for every candidate. It must identify what
a database/backup reader learns about paths, bodies, raw/effective frontmatter,
types, relationships, equality/frequency, query source, result pages, structural
resources, retained versions, changes, receipts, and files.

## Projection and rebuild protocol to be specified

The benchmark may prototype projections only after documenting a concrete state
machine. The minimum model includes:

```text
Collection semantic state:
  active_catalog_revision
  active_projection_format_version

Projection generation:
  generation_id
  target_catalog_revision
  projection_format_version
  status: building | complete | abandoned
  durable checkpoint
  lease owner and expiry

Record projection binding:
  record_id
  record_revision
  catalog_revision
  projection_format_version
  generation_id
  projection payload and digest
```

A projection is current only when its record revision, pinned catalog revision,
projection format/semantic-engine version, and generation binding match the query
snapshot. Resource changes atomically advance the active semantic catalog and open
a rebuilding generation; they do not claim that all projections are current.

Writes after a catalog change evaluate against the active catalog and persist a
current projection transactionally with the record mutation. A rebuild worker reads
an exact record revision, computes through mdbase-rs, and writes with record-revision
CAS. A concurrent edit makes that rebuild write retry or skip; it cannot overwrite a
newer projection. Checkpoints and leases make interruption, restart, and abandoned
generation recovery explicit.

Queries pin a repeatable-read semantic/catalog snapshot. Candidate selection unions
current indexed matches with records whose projection is stale or absent. Those
records receive bounded canonical evaluation. Completion is marked only by a
transactional proof that no live record remains stale for the target catalog and
format. Rebuild failure changes optimization state only.

The benchmark report must supply exact tables/columns, transitions, SQL/CAS rules,
completion proof, crash recovery, and race tests before this ADR can be accepted.

## Authorization rules to be specified and tested

Candidate completeness does not establish authorization correctness. The design
must replace any authorization decision that trusts unversioned persisted `types`.

The required safety rules are:

1. Every request pins the catalog/contract semantics governing its grant and
   collection snapshot.
2. A projection may support authorization only when all currentness bindings match
   that pinned snapshot and record revision.
3. A stale, absent, ambiguous, or unverifiable projection causes the provider to
   load the canonical record and classify it through mdbase-rs.
4. If canonical classification cannot complete, authorization-sensitive reads and
   mutations fail closed.
5. Mutations locate their target by stable identity/path authority before applying
   type scope; they must not exclude it using stale type hints.
6. The provider revalidates record revision, catalog revision, grant/scope epoch,
   destination, and quota inside the existing short journal transaction.
7. Resource changes, projection rebuilds, record edits, and concurrent mutations
   receive adversarial race and restart tests.

The benchmark phase must document how existing grant contract digests and type
scope interact with the pinned catalog and demonstrate the transition away from the
current pre-mutation persisted-type authorization path.

## Physical update and index rules

No table split or HOT behavior is assumed. Each prototype must name every indexed
column. Mutable record revision, sequence, or timestamp columns are not described as
mandatory indexes without an observed access requirement, because indexing them
prevents HOT updates.

Body-heavy writes use narrow updates and omit unchanged projection/type/path columns
where the candidate permits. Measure HOT rate as an upside, not an invariant. Record
heap tuples, TOAST bytes, WAL, dead tuples, vacuum behavior, index writes, and bloat
even when HOT succeeds.

## Benchmark protocol and decision gates

Use deterministic synthetic fixtures only, never production content. Exercise at
least 10,000 records, 100,000 records, and approximately 1 GiB canonical Markdown
with representative size, type, tag, body, and selectivity distributions.

Record for every candidate/variant and workload:

- exact document, projection, table, TOAST, index, WAL, and backup-estimate bytes;
- import, backfill, rebuild, and recovery time;
- body/frontmatter/resource write p50/p95/p99 and throughput;
- HOT rate, dead tuples, vacuum work, and bloat;
- query p50/p95/p99, rows selected/scanned, documents decrypted, plaintext bytes,
  KMS/key-cache activity, and result completeness;
- provider RSS/PSS, accounted operator bytes, CPU, and cancellation cleanup;
- PostgreSQL CPU, IO, pool occupancy, snapshot lifetime, and contention with point
  reads/mutations; and
- implementation/schema complexity, migration states, and operational failure
  modes.

Use identical semantic fixtures and query expectations across candidates. The
report must distinguish a query completing successfully from returning a typed
budget outcome. Existing defaults such as the 100,000-record/30-second scan ceiling
remain visible; the benchmark must not silently increase them to make a candidate
pass.

No latency threshold alone authorizes a confidentiality change. The final report
must identify whether Candidate B satisfies the frozen common workload while
preserving encrypted exact documents. Candidate C may be recommended only if B
fails explicit workload gates, C materially resolves those failures, and the
confidentiality-irreversible trade is separately approved.

## Migration, consent, and irreversibility

All benchmark schemas use disposable local/staging databases. No existing beta or
production collection is migrated during this ADR's proposed phase.

Any future migration may be additive and operationally reversible, but writing
provider-readable values is confidentiality-irreversible until every replica,
snapshot, backup, log, forensic copy, and retained artifact containing them has
expired or been destroyed. “Rollback” must always distinguish code/schema rollback
from confidentiality restoration.

Before the first production provider-readable write, an accepted follow-up plan
must resolve:

- current encryption/threat-model promise changes;
- exact projection/content exposure;
- customer notice and consent, including existing beta collections;
- backup, replica, snapshot, log, and evidence retention;
- tenant isolation and least-privilege database access;
- incident response and legally compelled disclosure documentation; and
- rollback wording and operator controls.

Operator approval alone is insufficient for a confidentiality-irreversible change.

## Evidence independence

Acceptance requires independent capability-based missions and structured evidence,
not a permanent dependency on a named agent model. The current implementation may
prefer Luna sub-agents when available, but any suitably independent executor may
perform the mission. The implementer cannot be the only acceptance tester.

## Stop gate

The authorized work ends when the reproducible benchmark report, frozen workload,
confidentiality inventory, state-machine specification, authorization design, and
candidate recommendation are committed on review branches and presented to the
user. At that point:

- do not mark this ADR accepted;
- do not select or merge a storage schema;
- do not continue into exact-sync adaptation or general query implementation;
- do not deploy a candidate to shared staging or production; and
- mark the local task blocked/awaiting decision.

Continuation requires explicit user approval after discussion of the results.

## Consequences while proposed

ADR 0010 Phase 1 and its staged point-read candidate remain valid. Later encrypted
execution work remains paused, but encrypted storage remains the current deployed
authority and current public security documentation remains accurate.

The bounded semantic/query boundary can be prototyped because every candidate needs
it. No result from the benchmark prejudges whether exact documents remain encrypted.
The review may select Candidate A, B, C, or require another design.
