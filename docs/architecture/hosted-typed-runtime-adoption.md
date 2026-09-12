# Hosted typed runtime adoption

Hosted v0.3 execution keeps mdbase semantic outcomes and effects typed until the
Connect protocol boundary. Record mutations use `plan_hosted_mutation_typed` and
persist only its exact `HostedRecordChange` evidence. Resource and definition
mutations similarly persist only their exact `ResourceChange` evidence. Each
path verifies that the accompanying `ChangeSet` count agrees before touching
provider state.

Reads, queries, saved views, definition assessments, resource operations, and
validation use their typed hosted APIs. The only conversion to the portable
v0.3 operation envelope is `CanonicalOperationOutcome::to_v03`. Existing
journal rows may retain a wire result for replay compatibility, but replayed
JSON is not used to infer records, resources, revisions, types, or write sets.

This adoption does not change provider authority or transaction ordering.
Admission remains before plaintext reads; commit-time replica, token, lease,
row-lock, CAS, receipt, projection, feed, and outbox checks remain in their
existing PostgreSQL transactions. Mutation responses are not hydrated with a
post-commit read.

The existing hosted count, exact-byte, projection-byte, cancellation, cursor,
and transaction budgets continue to apply. Typed planning adds no second scan
or materialization budget. Architecture tests reject legacy hosted runtime seams
and `.result`-based semantic inference in hosted execution files.

Semantic projection format 6 persists mdbase's bounded resolution reason and
complete candidate evidence in the encrypted-authority projection row. Hosted
rebuild and write-through use the same `plan_record_resolution` /
`resolve_record_structure` implementation as local execution, and currentness
checks verify the structural digest and candidate evidence before projection or
relationship indexes are trusted. Format-5 generations and rows are stale by
construction: query binding chooses exact fallback and indexing creates a new
current generation; no evaluator mixes v5 rows into a v6 generation. Candidate
evidence stays inside the existing authority-readable projection and does not
add path or stable-ID fields to application responses.
