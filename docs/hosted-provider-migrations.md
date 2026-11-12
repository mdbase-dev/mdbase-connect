# Hosted-provider migrations

Hosted-provider migrations live in `crates/connect-hosted-provider/migrations`
as `NNNN_description.sql` and are applied by SQLx at provider startup, in
version order, recorded in `_sqlx_migrations` with each file's checksum. A file
is never edited, renamed or removed once it has reached a deployed database.

Rolling back a release does not roll back its migrations: the previous
provider has to start against the newer schema. By default it cannot, because
the provider refuses a migration ledger it does not fully recognise, so a
release that adds a migration is **forward-only** and ops continuous deployment
will not ship it. A migration can opt out of that by being marked
rollback-compatible.

## Expand, then contract

Write schema changes so that the previous release keeps working at every step:

1. **Expand**: add the new table, column, index or constraint the new code
   needs, without changing anything the previous release reads or writes.
2. Ship code that uses the new shape and still tolerates the old one.
3. **Contract**: remove what the old code needed only in a later release, once
   no release that needs it can be rolled back to.

Each expand step is usually rollback-compatible. A contract step is not.

## Marking a migration rollback-compatible

Put this line in the migration's leading comment header (the comment lines at
the very top of the file; after `-- no-transaction` when that is needed too):

```sql
-- mdbase: rollback-compatible
```

Mark a migration only when the previous release works unchanged on the schema
it produces. That covers:

- additive schema: new tables, new nullable columns or columns with defaults,
  new indexes, new constraints the previous release's writes already satisfy;
- deleting rows that no older build reads, such as delivered events or expired
  leases.

Never mark a migration that:

- drops or renames a table, column, index, constraint, type or function an
  older build reads or writes;
- changes a column's type, nullability or default in a way an older build would
  notice;
- rewrites data an older build reads, including JSON shapes inside a column;
- adds a constraint the previous release's writes can violate.

When in doubt, leave it unmarked: the release is then forward-only, which is
safe but needs the breaking-migration process instead of ordinary CD.

## How it works

- **Runner.** Before applying migrations, the provider records the version and
  checksum of every marked migration it knows in
  `hosted_provider_rollback_compatible_migrations`, so the record exists even
  if startup stops halfway. At startup it requires the ledger to begin with an
  exact, successful copy of its own catalog, as before, with unchanged
  checksum checks. Rows after the end of its catalog are accepted only if they
  succeeded and are recorded as compatible with the same checksum; the
  provider then serves without migrating anything. Any other newer migration
  stops startup with `hosted migration ledger is not an exact successful
  catalog prefix at N`. The behaviour is declared in source as
  `MIGRATION_ROLLBACK_TOLERANCE = "marked-v1"`.
- **CI gate.** Server CI's *Hosted-provider migration rollback gate* job
  (`scripts/ci/provider-migration-rollback-gate`) looks at new migration files.
  The previous release is the base commit the tested merge sits on: the base
  branch tip for a pull request's test merge, the queue base in the merge
  queue. That is deterministic and never older than production; ops checks the
  real production predecessor separately when it deploys.
  - No new migrations: nothing to do.
  - Any new migration unmarked, or an existing migration changed: the job warns
    that the release is forward-only and passes.
  - All new migrations marked, and the previous release has the tolerant
    runner: the job checks out the previous release and runs its
    `scripts/ci/hosted-provider-postgres-tests` with
    `MDBASE_TEST_NEWER_HOSTED_MIGRATIONS` pointing at this branch's migrations.
    Every disposable test schema then starts with this branch's migrations
    applied and recorded, and the previous release's tests run against it
    through its own tolerant startup. The job fails if they fail.
- **Ops.** `mdbase-cloud-ops/bin/provider-migration-capability` reports
  `recovery_mode: predecessor` for a migration increase only when every added
  migration is marked and the production predecessor's source declares the
  tolerant runner.

The first release with the tolerant runner has to reach production before any
marked migration can be rolled back past.
