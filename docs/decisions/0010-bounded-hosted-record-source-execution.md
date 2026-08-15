# ADR 0010: Bounded hosted record-source execution

- Status: accepted
- Date: 2026-08-15
- Connect baseline: `6ea62cf2593e91a0e0b17e9e931ebf0ec23dc805`
- mdbase-rs baseline: `818866705dcc4b6dcfd3bbc1ba63f83fdaec406f`
- Supersedes: hosted materialization portions of the current provider architecture
- Extends: ADR 0009, cross-repository collection runtime execution contract
- Companion contract: `mdbase-rs/docs/architecture/hosted-record-source-execution.md`
- Budget manifest: `config/hosted-execution-budgets.json`
- Refined by: accepted ADR 0011. Phase 1 remains accepted. Candidate B replaces the
  later encrypted-scan design with encrypted exact authority plus a readable
  semantic projection, structural relationship graph, and closed bounded SQL plan.
  ADR 0010's provider-neutral semantics, direct point reads, budgets, journals, and
  `WorkingSet` deletion remain in force.

## Context

The hosted provider currently decrypts every record, clones it into a process map,
writes exact Markdown into a temporary filesystem collection, opens that collection
through mdbase-rs, and retains the resulting `WorkingSet` plus query results. This
preserves canonical semantics but makes resident plaintext and memory proportional
to collection size and the number of collections previously used. The per-collection
mutex also makes a provider process an accidental session-affine actor.

PostgreSQL is already the authoritative hosted record, resource, version, change,
receipt, quota, and journal store. Exact Markdown is already encrypted as the
canonical record representation. Replacing PostgreSQL with a filesystem or asking
PostgreSQL to interpret CEL would create a second authority or a second semantic
engine. Neither is acceptable.

ADR 0009 established portable generations, outcomes, change sets, mutation
preparation, cancellation, and bounded read cursors for the local runtime. This ADR
extends that ownership boundary to an authority whose records are streamed from an
encrypted transactional store.

## Decision

### One semantic engine, authority-owned orchestration

`mdbase-rs` remains the only implementation of canonical parsing, catalog
compilation, type matching, CEL evaluation, projection, validation, saved-view
semantics, diagnostics, bounded aggregation, and mutation planning.

The hosted provider owns asynchronous orchestration: admission, PostgreSQL
transactions and row streams, application-layer encryption, grants, journals,
receipts, quotas, durable cursor pages, cleanup, and protocol conversion.

The semantic boundary is incremental rather than database-shaped. mdbase-rs exposes
pure provider-neutral values and state machines that accept resource documents and
one canonical record input at a time. An authority adapter drives those state
machines. mdbase-rs does not acquire SQL, Tokio, Connect, account, grant, KMS, or
cursor-table types.

Conceptually:

```rust
struct CatalogInput {
    spec_version: String,
    resources: Vec<CanonicalResourceInput>,
    resource_revision: String,
}

struct CanonicalRecordInput {
    stable_id: Option<String>,
    path: String,
    revision: String,
    exact_document: String,
    stored_type_hint: Option<RevisionBoundTypeHint>,
}

struct CompiledCatalog { /* canonical mdbase semantics */ }
struct CompiledQuery { requirements: QueryRequirements, /* private plan */ }
struct BoundedQueryExecution { /* private bounded accumulators */ }
struct MutationPlan { /* portable reads, preconditions, and exact writes */ }

impl CompiledCatalog {
    fn parse_record(&self, input: CanonicalRecordInput,
                    requirements: &RecordRequirements)
        -> Result<CanonicalRecord, SemanticDiagnostic>;
    fn compile_query(&self, input: &Value, budgets: &ExecutionBudgets)
        -> Result<CompiledQuery, ExecutionFailure>;
}

impl BoundedQueryExecution {
    fn push(&mut self, record: CanonicalRecord,
            context: &OperationContext) -> Result<(), ExecutionFailure>;
    fn finish(self) -> Result<PortableQueryOutcome, ExecutionFailure>;
}
```

The exact Rust surface may evolve as vertical slices land, but these properties are
normative:

1. resource compilation is independent from record storage;
2. point parsing needs one exact document, not a collection;
3. query state is incremental and budget-accounted;
4. an adapter may supply safe false-positive candidates but never false negatives;
5. final matching and authorization-relevant type classification occur in mdbase-rs;
6. mutation plans contain semantic preconditions and exact intended writes but no
   Connect request, grant, encryption, or journal state; and
7. filesystem and hosted adapters execute the same conformance fixtures.

An async record-source trait is deliberately not added to mdbase-rs. The hosted
coordinator already owns async database and crypto lifetimes; a pure incremental
engine keeps the semantic crate runtime-neutral and makes plaintext batch lifetime
explicit at the caller.

### Hosted read snapshot

Every ordinary hosted point read or query uses one PostgreSQL `REPEATABLE READ,
READ ONLY` transaction and one pool connection from catalog load through the final
candidate row. The snapshot jointly observes:

- collection authority epoch and head;
- structural resource revision and documents;
- candidate metadata and classification revision; and
- encrypted record rows.

The adapter constructs an opaque `CollectionGeneration` from at least authority
epoch, head, and resource revision. It never compares only one component. Admission,
an absolute deadline, cooperative cancellation, and the manifest's maximum snapshot
lifetime bound connection and MVCC-history retention.

Point reads use stable record ID or the existing collection-keyed HMAC path token.
They fetch and decrypt no unrelated record row. A point read may reuse a compiled
catalog keyed by resource revision; cache eviction changes latency only.

### Streaming queries and requirements

The query compiler reports requirements for bodies, file facts, links/backlinks,
effective or computed fields, contract projection, ordering and top-K size,
grouping, summaries, counts, and diagnostics. The hosted adapter uses only safe
metadata and revision-valid hints to narrow candidates. It streams ciphertext in
the manifest's row and byte batches, decrypts with bounded parallelism, feeds
canonical inputs to the engine, and releases plaintext with each batch.

The initial production operator set is:

- streaming filters and projections;
- streaming counts and fixed-state built-in summaries;
- bounded top-K ordering for capped `offset + limit`;
- bounded group cardinality and aggregation bytes;
- bounded diagnostic count and serialized bytes; and
- bounded final result and cursor serialization.

Custom summaries, link graphs, high-cardinality grouping, excessive offsets, or
unlimited results succeed only after they have a reviewed bounded algorithm. Until
then they fail atomically with `operation_budget_exceeded` and a privacy-safe
`budget_kind`. No operator silently truncates or falls back to `WorkingSet`.

Arbitrary CEL may scan all encrypted rows. The guarantee is bounded memory,
admission, cost visibility, cancellation, and isolation—not sublinear execution.

### Durable query cursors

Hosted query cursors retain encrypted final result pages, not a query plan or enough
historical authority state to reevaluate it. The initial snapshot completes the
entire bounded result, closes, and a short write transaction atomically stores the
cursor and every immutable encrypted page. A one-page result creates no durable
cursor.

Each page token is independently random; PostgreSQL stores only its hash and exact
cursor/page binding. Cursor opening is durably idempotent for application, replica
or grant, collection, scope epoch, keyed normalized-query digest, and caller opening
key. Lost-response replay returns the same finalized first page. Reusing an opening
key for different bound input returns a typed idempotency conflict.

Any provider instance can deliver a page after authenticating the current
capability and rechecking live grant/replica state and scope epoch. Mutation,
resource change, or process restart does not alter finalized pages. Revocation or
scope change blocks delivery. Expiry, release, and maintenance remove all page rows
within the published bound.

Durable cursor quotas are transactionally global PostgreSQL quotas. Per-process
limits cover only live cursor construction and temporary page buffers.

### Type hints

Exact encrypted Markdown remains canonical. Existing stored type labels become
optimization hints only. Each collection and hint has an explicit type-catalog
revision. A row may be excluded by type only when its hint revision equals the
pinned catalog revision. Stale or absent hints remain candidates and mdbase-rs
classifies them.

A type resource mutation advances the catalog revision and does not synchronously
rewrite every record. New writes store current classification. Background refresh
may improve selection but is never required for correctness or authorization.

No plaintext frontmatter JSONB, raw query source, unkeyed query digest,
order-preserving encryption, or speculative blind/link index is introduced.

### Mutations

Exact sync put, move, and delete parse and classify the submitted target through
mdbase-rs, then use one short hosted journal transaction. They lock and revalidate
the collection, authority/scope epoch, relevant record revisions, destination path
token, resource revision, and quota before atomically writing current state,
retained versions/tombstones, ordered changes, accounting, receipt, journal
settlement, and notification outbox.

Semantic application mutations prepare a provider-neutral `MutationPlan` against a
bounded read snapshot. Reference discovery is a bounded scan when no safe index
exists. A short write transaction locks the collection head and revalidates the
plan's generation, resources, grant/scope, records, destinations, and quota. A
bounded retry may reprepare after a head change; exhaustion returns a typed
conflict. No arbitrary scan holds the collection write lock.

The existing hosted mutation journal remains the sole durable request and receipt
system.

### State ownership

| State | Owner | Class |
| --- | --- | --- |
| Local Markdown | filesystem authority | authoritative |
| Local SQLite index/cache | mdbase-rs | rebuildable |
| Hosted encrypted Markdown rows and resources | PostgreSQL provider | authoritative |
| Hosted versions, changes, receipts, leases, quotas, journal, outbox | PostgreSQL provider | durable support |
| Hosted immutable binary payloads | R2 | authoritative opaque blobs |
| Compiled catalogs and recently unwrapped keys | provider process | byte/age-bounded rebuildable cache |
| Individual decrypted records or batches | provider process | operation-bounded transient state |
| Final encrypted query cursor pages | PostgreSQL provider | bounded durable support |
| Complete hosted temporary collection and per-collection query cache | none | deleted after rollout |

No ordinary request depends on process-local state or session affinity.

### Encryption and observability

Record paths, frontmatter, bodies, retained versions, changes, receipts, durable
cursor pages, and content-derived diagnostics remain application-layer encrypted.
Structural resource paths retain their currently documented visibility. Path lookup
continues using collection-keyed HMAC tokens and purpose-specific AES-GCM associated
data.

Logs, metrics, traces, crash evidence, and shadow evidence exclude paths, query
source, frontmatter, bodies, projections, diagnostics, cursor contents, unwrapped
keys, and reusable content/query digests. Allowed signals are operation kind,
privacy-safe budget kind, row/byte counts, phase durations, admission waits,
snapshot lifetime, connection occupancy, aggregate cache/live-byte accounting,
cursor encrypted bytes, cancellation cleanup, and stable error code.

### Compatibility and rollout

The implementation lands as vertical slices behind a reversible hosted-only feature
flag. Migrations are additive while old instances may run. Rust and TypeScript wire
changes are versioned together. Legacy non-cursor requests succeed only when their
complete result fits the response bound; otherwise they receive an explicit typed
pagination/budget outcome.

Local authority behavior remains compatible. SDK cursor negotiation is lazy by
default; array conveniences require an explicit caller item/byte bound no larger
than the service result maximum.

Each vertical slice bypasses a concrete `WorkingSet` path and passes filesystem vs
hosted semantic, authorization, encryption, recovery, cancellation, and
multi-instance tests. Production promotion requires the published staging workload,
memory, latency, cleanup, semantic, and security gates. After observation succeeds,
the fallback and temporary containment are deleted; the old and new hosted runtimes
do not coexist permanently.

## Rejected alternatives

- Porting the local SQLite cache schema to PostgreSQL: duplicates a physical model
  and does not solve canonical semantic ownership.
- CEL-to-SQL translation: creates a second query engine and conflicts with encrypted
  content.
- Permanent collection actors or sticky routing: makes correctness depend on
  process state and weakens horizontal operation.
- Historical query reevaluation cursors: pins unbounded versions/resources and
  complicates revocation and cleanup.
- General external encrypted spill/sort in the first implementation: unnecessary
  before bounded operators and workload evidence.
- A larger LRU around the current `WorkingSet`: limits collection count but not one
  collection's memory or plaintext lifetime.

## Consequences

Point reads, exact sync writes, cold starts, and multi-collection workloads become
independent of collection size. Full encrypted scans may be slower than a warm
filesystem cache, but their memory, connection, deadline, and cancellation behavior
is explicit and bounded. The engine extraction is incremental work in mdbase-rs,
but every seam has both filesystem and hosted consumers and replaces rather than
adds a permanent implementation.
