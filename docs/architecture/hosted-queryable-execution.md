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
Hosted file modification time is the authoritative record-version commit time. The
same transaction stamps the encrypted version, current record, and version-5
projection input; exact reads and snapshot fallback recover that revision-scoped
time rather than synthesizing or omitting it.

## Semantic and persistence ownership

mdbase-rs owns:

- canonical single-record parsing, classification, defaults, computed values,
  validation, diagnostics, and projection generation;
- extraction and resolution of wikilinks, Markdown links, embeds, exposed body
  tags, anchors, relative targets, and ambiguous targets; exact parsing retains
  label/source syntax for mutation, while readable body projections redact it;
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

Type-pack and collection-setup assessment/apply use mdbase-rs's closed bounded
definition seam. Connect decrypts at most 2,000 exact resource documents and 32 MiB,
never reads record ciphertext for the inline definition operation, and atomically
persists the returned resource/type/contract catalog. A successful semantic change
opens a new projection generation; it does not reclassify or rewrite every record
inside the definition transaction. Until rebuild completion, query and authorization
paths use the same stale/absent canonical fallback and fail-closed rules described
above. Legacy collections retain their prior behavior until explicitly activated.

## Structural relationship graph

Each projection carries a deterministic structural/link digest and a canonical set
of outgoing relationship occurrences. An occurrence retains enough syntax and
resolution information for correct rename, delete, reference, and backlink
behavior. Connect persists outgoing edges keyed by collection, source identity,
target identity or unresolved target, semantic kind, and stable occurrence key.
Backlinks are the bounded inverse query over target identity; they are not copied
into every target projection.

Body occurrences contain target identity, link/embed kind, anchor, relative-form
and resolution facts, but not visible labels, destination titles, malformed source
tails, or complete Markdown source spelling. Exact mutation planning decrypts and
reparses only the bounded affected authorities. Computed fields that transitively
read `file.body` are omitted from readable effective frontmatter and make that
projection incomplete, forcing bounded exact fallback. Projection format 5 fences
all earlier rows because older formats may contain either class of body prose.

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
For collections above the 10,000-row eager-summary ceiling, an ordinary page does
not add an unbounded exact-count pass: `total_count` is null and
`total_count_outcome` reports the typed `eager_summary_rows` deferral. `has_more`
comes from the single `page_size + 1` lookahead row. A caller that consumes
`queryAll` learns the exact returned length at completion; explicit count/group
requests use their separately budgeted SQL reduction plan.
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

Projection transfer is two-stage. SQL first returns only record identity, canonical
path, currentness, and the persisted canonical projection-byte count. Connect
rejects row or byte exhaustion before selecting any projection JSON, then fetches
only the preflighted identities inside the same repeatable-read transaction. It
rechecks serialized size after decoding as an integrity guard. Relationship SQL
deduplicates source/target pairs and has a 65,536-pair provider ceiling in addition
to the plan's operator budget; the exported 4,096-related-record semantic ceiling is
enforced before related projections are fetched.

The disposable PostgreSQL regression corpus includes 10,001 nonmatching live
version/projection pairs—one more than the transfer ceiling—one matching TaskNotes
row with a hierarchical tag, and one candidate-matching orphan projection. The
closed normalized tag candidate returns only the canonical live result without
triggering the scan budget, proving pruning occurs before projection transfer and
residual work while orphan state is excluded.

SQL applies safe ordering and limiting before transfer. Query-plan version 11 carries
mdbase-rs catalog proofs for scalar candidate, order, and group keys. Connect accepts only the
closed string proof for canonical path, file mtime, and schema-declared projected
frontmatter fields (plus boolean equality/membership predicates), verifies actual
current values at the pinned snapshot, and then uses strict SQL filtering, canonical
null placement, deterministic path/descending-mtime keyset ordering, and count-only SQL grouping. Exact
body hydration happens only after the page identities are selected. A malformed
value fails the fast-path proof and forces fail-closed exact residual work; it is
never silently dropped. Other scalar ordering uses an explicitly bounded 10,000-entry
top-K operator and returns `hosted_ordering_budget_exceeded` rather than asking
PostgreSQL for an unbounded sort; grouping and summaries retain only bounded
state. Scan rows, transferred bytes, decrypted documents, plaintext bytes, result
bytes, operator state, wall time, statement time, connections, and memory are
accounted separately. Exhaustion returns a typed budget outcome. No request silently
falls back to collection-wide `WorkingSet`.

Each hosted query transaction uses PostgreSQL `force_custom_plan` locally. Candidate
and generation selectivity varies per collection, and the prepared-statement generic
plan selected after five executions was measured to double sustained 100k grouping
latency. This setting does not alter other provider or control-plane transactions;
statement, snapshot, connection, and cancellation bounds still enclose planning and
execution together.

The production regression corpus also executes two consecutive 1,000-row
file-mtime keyset pages over 100,002 live identities (plus an orphan projection),
and a 100,003-match typed filter plus two-group count over a 100,004-row typed
snapshot. Neither crosses the 10,000-row transfer ceiling. This distinguishes
page-local SQL execution from the disposable benchmark prototype's
repeat-to-completion top-K implementation.

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

Before acquiring a database connection, collection-scan query surfaces acquire one
of the published process-wide scan permits (two by default). Permit wait uses the
same bounded acquisition clock as the database pool and returns a typed
`scan_permit_wait_ms` outcome. Activity probes
track scan permits separately from active requests and plaintext scopes so
cancellation tests prove each resource is released.

Projection rebuild leases, per-page checkpoints, generation fencing, idempotent
edge replacement, and record-revision CAS make restart safe. Rebuild failure affects
optimization only: exact authority remains available, subject to the same bounded
fallback and fail-closed authorization rules.

Provider startup awaits one bounded recovery pass for at most 20 active or durably
pending Candidate B generations before binding the HTTP listener. The pass can create a missing
generation and advances at most one bounded projection or resolution batch per
selected collection. Pending initial activation remains routed through legacy until
the complete generation is bound atomically; recovery cannot expose partial state.
The startup pass does not turn global readiness into a wait for every tenant
rebuild to complete. Terminal semantic or ciphertext faults remain quarantined,
while an unexpected database or recovery error fails startup instead of advertising
a ready process that has not attempted recovery. The periodic bounded worker resumes
remaining batches after readiness.

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
