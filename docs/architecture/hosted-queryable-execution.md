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
Because the safety union precedes canonical type classification, a scoped request's
public budget details report only `limit + 1` when that union exceeds a row,
document, or plaintext-byte ceiling. Operators may observe exact aggregate metrics,
but a restricted caller cannot infer the number or size of out-of-scope stale
records from an error response.
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

Configured Obsidian Base sources use a dedicated mdbase-rs semantic plan rather
than CEL or SQL reinterpretation. The plan evaluates formulas, shared/local filters,
ordering, grouping, TaskNotes link operations, and backlink traversal over current
projections plus a bounded one-hop relationship neighborhood. Its operation clock,
optional projected `this.file` context, semantic plan, and keyset are pinned across
pages. Expression AST work, candidate rows, relationship edges, groups, transferred
projection bytes, retained rows, and resident copies all consume explicit budgets.
The immutable Base plan, semantic context, and operation clock live in one
invocation row for the cursor's hard lifetime. Each page rotates only the narrow
single-use keyset cursor that references that invocation, avoiding repeated
TOAST/WAL writes of the same potentially large semantic state.
The readable cursor plan exposes Base formulas and referenced property names, but
not the exact `.base` formatting, exact record Markdown, or body prose.

Canonical Base expression work runs on a blocking worker with a cooperative
mdbase-rs token checked at every AST node. Request drop cancels that worker token;
PostgreSQL backend cancellation, transaction/session drop, pool return, and
operation/plaintext counters remain independently guarded and observable.

Connect translates only the Base plan's closed candidate predicate. It currently
lowers proven frontmatter equality/inequality and canonical combined frontmatter/
body tag exact-or-descendant membership; every selected row still runs through
mdbase-rs. Candidate SQL joins the projection to the record revision live at the
pinned snapshot, so a stale, deleted, or orphan projection cannot become a result.
Complex TaskNotes relationship expressions remain bounded residual work. Unsupported
predicates never become ad-hoc SQL and never narrow candidates.

The disposable PostgreSQL regression corpus includes 10,001 nonmatching live
version/projection pairs—one more than the transfer ceiling—one matching TaskNotes
row with a hierarchical tag, and one candidate-matching orphan projection. The
closed normalized tag candidate returns only the canonical live result without
triggering the scan budget, proving pruning occurs before projection transfer and
residual work while orphan state is excluded.

SQL applies safe ordering and limiting before transfer. Unsupported ordering uses
an explicitly bounded top-K operator; grouping and summaries retain only bounded
state. Scan rows, transferred bytes, decrypted documents, plaintext bytes, result
bytes, operator state, wall time, statement time, connections, and memory are
accounted separately. Exhaustion returns a typed budget outcome. No request silently
falls back to collection-wide `WorkingSet`.

For a Base that does not require relationship semantics, Connect executes a safe
snapshot union: SQL returns candidate-matching current projections plus every stale
or absent live identity, and only that stale subset is decrypted and canonically
projected before the shared residual/order/reduction step. Deleted and orphan
projections never enter the union. This keeps a one-record projection lag bounded
even in the 10,001-decoy regression corpus.

If a relationship-dependent Base has any absent, stale, or relationship-incomplete
projection, Connect does not trust a mixed graph. It loads a complete snapshot only
within the exact-document and plaintext-byte ceilings, decrypts those exact
authorities, regenerates and resolves the full bounded graph through mdbase-rs, and
evaluates the same closed Base plan. A snapshot above those ceilings returns the
corresponding typed exact-document, byte, relationship, memory, or time budget
outcome; it never silently omits a candidate or falls back to `WorkingSet`.

If the collection has no globally usable projection binding, Base planning pins
the current catalog/engine contract and exact record-version head directly. The
same bounded exact reconstruction supplies candidates, relationships, and optional
`this.file` context. Its cursor carries no generation ID and cannot be replayed as
another query kind; pagination remains deterministic over the pinned temporal head.

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
