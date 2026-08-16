# Hosted queryable execution

Status: selected architecture; implementation in progress; not production-enabled

Governing decision:
[ADR 0011](../decisions/0011-server-trusted-queryable-hosted-execution.md)

Additive schema and rollout state:
[Hosted semantic projection migration](./hosted-projection-migration.md)

Isolated consumer validation:
[Hosted Candidate B consumer staging missions](./hosted-consumer-staging-missions.md)

## Authority boundary

Encrypted exact Markdown is the sole canonical record authority. A full
provider-readable semantic projection is derived by mdbase-rs, version-bound,
rebuildable, and non-authoritative. PostgreSQL stores and queries the projection,
but neither Connect nor SQL may invent collection semantics.

The readable projection contains canonical paths, file facts, matched types,
persisted and effective frontmatter, diagnostics, outgoing relationships, and
structurally significant body-derived facts. It never contains exact Markdown or
body prose. Exact records are decrypted only for exact/body output, body predicates,
mutation, rebuild, stale fallback, or fail-closed authorization classification.

## Semantic and persistence ownership

mdbase-rs owns:

- canonical single-record parsing, classification, defaults, computed values,
  validation, diagnostics, and projection generation;
- extraction and resolution of wikilinks, Markdown links, embeds, exposed body
  tags, aliases, anchors, relative targets, and ambiguous targets;
- the versioned closed candidate/query IR and safe ordering, pagination, grouping,
  aggregation, residual, and mutation plans; and
- differential conformance with filesystem execution.

Connect owns:

- encryption, PostgreSQL persistence, transactions, snapshots, and physical
  indexes;
- current projection bindings, outgoing edge rows, indexed inverse backlinks,
  generation/lease/checkpoint/rebuild state, and record-revision CAS;
- grants, authorization snapshots, journals, receipts, fencing, quota, changes,
  retained versions, recovery, and outbox behavior; and
- typed runtime budgets, statement cancellation, connection/pool fairness,
  observability, and cleanup.

## Projection currentness

A projection is usable only when all of these match the request snapshot:

- record identity and exact record revision;
- active semantic catalog revision, computed from exact configuration, resolved
  types, and record contracts (not the broader resource revision);
- semantic engine and projection format versions; and
- current complete generation binding.

Current projected matches are unioned with every live stale or absent projection.
Stale/absent records are decrypted and canonically evaluated within explicit
budgets. Corrupt, ambiguous, or unverifiable state never narrows authorization; it
falls back to canonical classification and fails closed when that cannot complete.
Record mutation scope checks no longer trust the unversioned `types` cache on the
exact-record row: they canonically classify current ciphertext against the current
resource catalog until an equivalently bound complete projection is proven.

Semantic resource changes advance the active catalog and open a rebuilding
generation. Ordinary writes immediately target that catalog. Rebuild workers read
exact record revisions, generate through mdbase-rs, and persist with record-revision
and generation CAS. A transactional completion proof, not a checkpoint alone, marks
a generation complete.

The collection resource revision still binds the exact encrypted resource snapshot
and resource mutation CAS. It includes non-semantic resources such as saved views.
Changing a view therefore advances the resource revision without abandoning the
active projection generation; changing configuration, a type, or a record contract
changes the semantic digest and invalidates the binding. Authorization and query
currentness never compare the broader resource revision as a substitute for this
semantic digest.

## Structural relationship graph

Each projection carries a deterministic structural/link digest and a canonical set
of outgoing relationship occurrences. An occurrence retains enough syntax and
resolution information for correct rename, delete, reference, and backlink
behavior. Connect persists outgoing edges keyed by collection, source identity,
target identity or unresolved target, semantic kind, and stable occurrence key.
Backlinks are the bounded inverse query over target identity; they are not copied
into every target projection.

Before encrypting a body write, mdbase-rs computes the new structure and digest. If
the digest is unchanged, the transaction keeps existing edge rows. If it changes,
the encrypted exact document, revision, projection binding, and complete outgoing
edge replacement commit atomically. A crash exposes either the old complete state
or the new complete state, never a mixed graph.

## Bounded query execution

mdbase-rs compiles each supported request into a closed versioned plan containing a
safe candidate predicate, canonical residual requirements, deterministic ordering,
grouping/aggregation operators, response fields, and resource limits. Connect
translates only that allow-listed IR into parameterized SQL.

Queries operate one page at a time under a pinned semantic generation and logical
collection-head snapshot. Temporal projection/key/edge rows make that snapshot
durable without retaining a PostgreSQL transaction between requests.
Deterministic keyset cursors bind collection, grant/scope epoch, catalog and
generation revisions, plan version/digest, ordering keys, snapshot/checkpoint, and
expiry. They are authenticated and rejected when their binding is stale or invalid.
Saved canonical views compile through mdbase-rs into the same closed plan and retain
their view/context metadata across pages. Cursor rows bind the operation kind and
public invocation digest; an exact `this` context is stored only as bounded
collection-encrypted cursor state. View-only resource edits do not alter an already
pinned page sequence.

SQL applies safe ordering and limiting before transfer. Unsupported ordering uses
an explicitly bounded top-K operator; grouping and summaries retain only bounded
state. Scan rows, transferred bytes, decrypted documents, plaintext bytes, result
bytes, operator state, wall time, statement time, connections, and memory are
accounted separately. Exhaustion returns a typed budget outcome. No request silently
falls back to collection-wide `WorkingSet`.

## Mutation transaction

The existing durable journal remains the mutation coordinator. A prepared semantic
plan carries exact record/catalog preconditions, destination uniqueness,
relationship-neighborhood evidence, exact writes/deletes, and the portable final
result. The short commit transaction rechecks grant/scope epoch, authority and
catalog revision, record revision, destination, quota, generation fence, and
journal state.

Successful ordinary writes atomically persist ciphertext, revision, current
projection binding, relationship changes, versions/changes, quota accounting,
receipt, and outbox state. A CAS loss or changed semantic precondition returns a
typed conflict or performs a bounded reprepare; it never commits a partial semantic
state.

## Cancellation and recovery

Every query sets a PostgreSQL statement deadline and bounds transaction/snapshot
lifetime. Cancellation rolls back the transaction, closes the stream, releases the
pool permit and connection, and drops decrypted plaintext before returning. Tests
must observe those resources independently after cancellation rather than trusting
in-process flags.

Projection rebuild leases, per-page checkpoints, generation fencing, idempotent
edge replacement, and record-revision CAS make restart safe. Rebuild failure affects
optimization only: exact authority remains available, subject to the same bounded
fallback and fail-closed authorization rules.

## Physical index policy

The baseline is Candidate B-no-GIN. Identity, path, deterministic cursor,
current-binding, generation/checkpoint, and relationship source/target indexes are
part of the access model. Any further projection index requires real
`EXPLAIN (ANALYZE, BUFFERS)` evidence and must account for query benefit, write
latency, WAL, HOT rate, rebuild duration, vacuum, bloat, and confidentiality
leakage. A general projection GIN and automatic schema-property indexes are not
defaults.

## Rollout boundary

Implementation, reviewed merges, additive migrations, and isolated synthetic
staging validation are authorized. Existing beta/production data migration and
production traffic enablement require a final explicit user approval after the
complete rollout, rollback, recovery, capacity, observability, incident, and
security package is reviewed.
