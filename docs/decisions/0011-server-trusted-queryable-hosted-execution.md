# ADR 0011: Hosted query storage model and bounded execution

- Status: accepted; implementation in progress
- Date proposed: 2026-08-15
- Review revision: 2026-08-16
- Connect checkpoint: `444ed9f86f6265d1960c5e17a5976d3559aef359`
- mdbase-rs checkpoint: `e8d84a774b8a3ddfd8efc952b4eddb455b3bf6a0`
- Reconsiders: ADR 0010's post-Phase-1 encrypted query/storage decisions
- Retains regardless of outcome: provider-neutral mdbase-rs semantics, direct
  point reads, bounded execution, horizontal providers, and `WorkingSet` deletion
- Tracked benchmark record: `docs/benchmarks/hosted-storage-model/README.md`
- Local execution task: `.ops/tasks/Queryable hosted collection execution.md`
- Decision accepted: 2026-08-16, Candidate B selected by the user
- Production gate: explicit user approval before migrating existing beta/production
  data or enabling the model for production traffic

## Status and scope

This ADR selects Candidate B: encrypted exact Markdown as the sole canonical
authority plus a full provider-readable, derived semantic projection. The
projection is rebuildable and non-authoritative. Body prose and exact Markdown are
not stored provider-readably.

Production implementation, additive migrations, isolated staging, consumer
validation, reviewed PRs, and production-rollout preparation are authorized. No
existing beta/production collection data may be migrated and the new model may not
serve production traffic until a final explicit user approval. This status does
not claim that the selected model is already deployed.

## Context

The hosted provider currently reconstructs a complete decrypted temporary
filesystem collection for many operations. ADR 0010 established a provider-neutral
mdbase-rs catalogue and record boundary, explicit execution budgets, and temporary
`WorkingSet` containment. Its staged Phase 1 direct point read proved that one
encrypted row can be selected, decrypted, and evaluated without loading unrelated
records: a 10,003-record cold read completed in 41.52 ms and warm p95 was 31.39 ms.

Removing `WorkingSet` and removing exact-document encryption are independent
decisions. The comparative benchmark showed that bounded encrypted scans alone do
not satisfy scalable common queries, while making exact Markdown provider-readable
does not materially cure the shared query-plan failures. The chosen boundary is a
readable semantic projection over an encrypted exact authority.

The benchmark prototype established storage and confidentiality tradeoffs, but its
executor is not the production query design. In particular, repeat-to-completion
pagination must be implemented as bounded deterministic pages, not as one unbounded
top-K operation.

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
12. Candidate B is the single standard hosted target. Candidate A and C remain
    benchmark evidence, not product modes.

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

### Candidate B: encrypted canonical records with readable projections (selected)

- Exact Markdown remains application-layer encrypted.
- mdbase-rs produces a provider-readable, revision-bound semantic projection.
- SQL selects candidates from current projections.
- Projection-sufficient queries may complete without decrypting exact documents.
- Records are decrypted only when the response requests exact/body content, the
  residual evaluator requires facts absent from the projection, or authorization
  cannot safely use a current projection.
- Body predicates that cannot use structural projection facts fall back to bounded
  canonical decryption and residual evaluation with typed budgets.

This model preserves database/backup confidentiality for exact Markdown and body
prose while exposing paths, file facts, persisted/effective frontmatter, types,
diagnostics, relationships, structural body facts, and equality/frequency of those
values. It is not database-private as a whole.

Production projection generation corrects an important prototype omission.
mdbase-rs extracts structurally significant body facts including wikilinks,
Markdown links, embeds, semantically exposed body tags, normalized outgoing
targets, and the syntax/resolution information needed for rename, delete,
reference, and backlink behavior. Connect persists outgoing edges in a bounded
relational graph; backlinks are the indexed inverse of those edges.

That graph does not persist body label prose or complete Markdown spellings.
Readable occurrences retain only the target, kind, anchor, relative-form and
resolution facts needed for selection; bounded mutation planning decrypts and
reparses the affected exact authorities for source rewrites. Computed fields that
transitively read `file.body` are non-projectable and force canonical exact
fallback. Projection format 5 makes both confidentiality rules part of currentness,
so earlier projection rows must be rebuilt rather than relabelled.

A body write computes its structural/link digest before encryption. When the
structural set is unchanged, the transaction does not rewrite relationship edges.
When it changes, the encrypted document, revision, current projection binding, and
relationship state commit atomically.

Configured Obsidian Base execution remains an mdbase-rs semantic surface. Connect
may persist its closed parsed plan, projected `this.file` context, operation clock,
and keyset as readable bounded cursor state, and may load a bounded one-hop
projection/relationship neighborhood. It must not translate TaskNotes formulas or
backlink behavior into independent SQL/CEL semantics. This cursor state reveals
formula and property-reference metadata to database/backup readers; exact `.base`
formatting, exact record Markdown, and body prose remain encrypted.

### Candidate C: provider-readable canonical records with projections

- Exact Markdown and semantic projections are provider-readable at the PostgreSQL
  logical layer.
- SQL selects candidates from projections.
- Residual body and exact-document evaluation does not require decryption.

This candidate can make broad body-dependent operations cheaper and simplifies
some storage access, but it irreversibly changes the current database/backup
confidentiality promise once written to replicas, snapshots, backups, logs, or
forensic copies.

### Production index policy

Candidate B-no-GIN is the baseline. Identity, canonical path, deterministic cursor,
current-binding, generation, and source/target relationship indexes are mandatory.
Additional narrow indexes require `EXPLAIN (ANALYZE, BUFFERS)` and measured common
workload benefit including write latency, WAL, HOT rate, rebuild time, vacuum, and
bloat. Do not add a general projection GIN, automatic per-field indexes, full-text
body indexes, blind indexes, or order-revealing indexes without contrary evidence
and a follow-up architectural review.

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

## Projection and rebuild protocol

The production state machine retains the benchmark's versioned model:

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

A projection is current only when its record revision, pinned semantic catalog
revision, projection format/semantic-engine version, and generation binding match
the query snapshot. The semantic catalog revision is a canonical digest of the
exact configuration, resolved type resources, and record contracts that can change
record classification or projection output. It is deliberately distinct from the
broader resource revision: saved-view source changes do not invalidate record
projections. Semantic resource changes atomically advance the active catalog and
open a rebuilding generation; they do not claim that all projections are current.

Writes after a catalog change evaluate against the active catalog and persist a
current projection transactionally with the record mutation. A rebuild worker reads
an exact record revision, computes through mdbase-rs, and writes with record-revision
CAS. A concurrent edit makes that rebuild write retry or skip; it cannot overwrite a
newer projection. Checkpoints and leases make interruption, restart, and abandoned
generation recovery explicit.

Hosted file modification time is the record-version commit timestamp, not a
provider-read clock sampled later. Ordinary writes bind that same timestamp to the
encrypted version and its derived projection; rebuild and exact fallback recover it
from the selected version. A projection format bump prevents older null-time rows
from being treated as current.

Queries pin a repeatable-read semantic/catalog snapshot. Candidate selection unions
current indexed matches with records whose projection is stale or absent. Those
records receive bounded canonical evaluation. Completion is marked only by a
transactional proof that no live record remains stale for the target catalog and
format. Rebuild failure changes optimization state only.

Production migrations and implementation must preserve these bindings, transitions,
SQL/CAS rules, completion proof, crash recovery, and adversarial race tests.

## Authorization rules

Candidate completeness does not establish authorization correctness. Production
authorization must not trust unversioned persisted `types`.

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
7. Semantic resource changes, projection rebuilds, record edits, and concurrent
   mutations receive adversarial race and restart tests.

Existing grant contract digests and type scope bind to the pinned catalog. The
current pre-mutation authorization path based on unversioned persisted types must be
removed before hosted parity is declared.

## Physical update and index rules

No table split or HOT behavior is assumed. Each prototype must name every indexed
column. Mutable record revision, sequence, or timestamp columns are not described as
mandatory indexes without an observed access requirement, because indexing them
prevents HOT updates.

Body-heavy writes use narrow updates and omit unchanged projection/type/path columns
where the candidate permits. Measure HOT rate as an upside, not an invariant. Record
heap tuples, TOAST bytes, WAL, dead tuples, vacuum behavior, index writes, and bloat
even when HOT succeeds.

## Benchmark evidence and implementation gates

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

The comparative run is preserved under
`docs/benchmarks/hosted-storage-model/results/2026-08-16-postgres18-local/`.
No candidate passed its prototype executor gates. That result motivates production
page-at-a-time planning and reliable cancellation; it is not evidence that the
selected storage boundary is unsound. The frozen workloads, semantic results,
budgets, and physical costs remain regression evidence and may not be relaxed merely
to produce a passing result.

## Migration, consent, and irreversibility

Implementation and validation use disposable local or isolated staging databases.
No existing beta or production collection is migrated before the final rollout
approval.

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

## Production rollout gate

Implementation may proceed through reviewed merges and isolated staging. Stop and
present the final architecture, PRs, staging missions, benchmark gates, schema and
migration plan, rollback/recovery plan, capacity effects, security changes, and
remaining typed budget behaviors before any of the following:

- migrating existing beta or production collection data;
- enabling the selected storage model for production traffic;
- removing recoverable production state; or
- changing customer-facing production security promises.

## Consequences

The projection becomes a deliberately database-readable index of semantic facts,
not an encryption boundary or record authority. Database, replica, snapshot, and
backup readers can learn all projected values and their frequency. Exact Markdown
and body prose remain application-encrypted, although the live provider can decrypt
them for authorized exact/body operations, mutation, fallback, and rebuild.

Hosted common operations must cease materializing collection-wide `WorkingSet`.
PostgreSQL executes only a closed, versioned plan compiled from mdbase-rs semantics;
unsupported or over-budget operations return typed outcomes instead of falling
back silently. Legacy compatibility is deleted only after differential parity,
fault/race testing, isolated staging missions, and normal reviewed merge gates pass.
