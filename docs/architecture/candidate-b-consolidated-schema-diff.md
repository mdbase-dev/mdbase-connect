# Candidate B consolidated schema comparison

Status: reviewed implementation evidence for the production cutover branch.

## Compared histories

The comparison uses two disposable PostgreSQL 17 databases:

- **chronological staging history**: migrations `0001` through `0059` from the parent of commit `b6ff4456`;
- **production cutover history**: the production beta69 baseline (`0001` through `0034`) followed by the consolidated `0035_hosted_semantic_projections.sql` and `0036_hosted_query_runtime.sql`.

Both histories produce 41 public tables. The comparison normalizes columns through `information_schema.columns`, constraints through `pg_get_constraintdef`, and indexes through `pg_indexes`. It intentionally does not compare migration-ledger rows or formatting of equivalent trigger/function bodies.

The executable upgrade contract is also covered by `candidate_b_consolidated_migrations_upgrade_the_beta69_schema`, which first applies exactly migrations 1–34, proves that no projection table exists, then applies the final migrations and requires the exact 1–36 ledger.

## Intentional differences

The final schema is deliberately not byte-for-byte equivalent to the experimental staging history. It removes transitional states that production has never stored:

- `hosted_execution_model` and `pending_hosted_execution_model` are absent. Candidate B is the only hosted runtime.
- `active_projection_head` is part of the all-null/all-present active binding. It advances atomically with exact authority writes and non-record collection sequence changes.
- collection and authority-import state machines include the temporary `indexing` state used to keep new/imported authority hidden until a verified projection is active.
- projection generations require a non-null `source_resource_revision`; final rows require a non-null observed projection digest.
- query cursors contain only the version-2 encrypted execution proof. Inline Base plans/contexts/clocks, `remaining_rows`, proof versions 0/1, zero budgets, and zero-byte cursors are absent.
- Obsidian Base cursor state is invocation-backed only.
- query replay receipts have one bounded zstd JSON representation. `response_encoding` and the `json-v1` compatibility representation are absent.
- the old activation/recovery mode indexes are replaced by the missing-binding backfill index.
- the redundant non-snapshot path cursor index is absent; the reviewed snapshot path and mtime cursor indexes remain.

Column ordering differs where the chronological migrations appended fields over time. Constraint names can also differ where the final migration creates the final contract directly. Neither affects the SQL contract.

## Index policy result

The final projection table has no general-purpose GIN index and no automatic per-field, body-text, range/order, or blind indexes. It retains only identity, current-row, deterministic snapshot cursor, and relationship graph indexes required by the closed runtime. This matches the B-no-GIN starting policy.

## Reproduction

Create two empty disposable databases and apply the histories in order. For the chronological side, enumerate migration files from `b6ff4456^`; for the final side, enumerate the current migration directory. Compare these ordered queries:

```sql
SELECT table_name, column_name, data_type, udt_name, is_nullable,
       coalesce(column_default, '')
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

SELECT relation.relname, constraint.contype,
       pg_get_constraintdef(constraint.oid, true)
FROM pg_constraint AS constraint
JOIN pg_class AS relation ON relation.oid = constraint.conrelid
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
ORDER BY relation.relname, constraint.contype,
         pg_get_constraintdef(constraint.oid, true);

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
```

On 2026-08-17 this comparison produced only the intentional differences listed above. The beta69 upgrade test, package tests, and focused indexing/lifecycle tests passed against the same consolidated migrations.
