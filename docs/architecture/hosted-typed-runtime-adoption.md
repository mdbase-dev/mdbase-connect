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
