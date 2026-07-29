# Control-plane migrations

The Connect server applies database changes only through
`pnpm --filter @mdbase/connect-server migrate`. The production process opens
the database without changing its schema, so every instance sees a fully
migrated control plane before it can become ready.

Migrations live in `services/server/migrations` and run in filename order. The
`schema_migrations` ledger records each filename and SHA-256 checksum. Applied
files are immutable: the migration command fails if an existing filename has
different contents. The runner takes a PostgreSQL advisory lock, so concurrent
pre-deploy jobs serialize safely.

The pre-versioned schema is recorded once as `0000_legacy_baseline`. Its
bootstrap exists only to create an empty database or import an installation
from before the ledger, and is frozen. Numbered SQL files are the sole
authority for every subsequent schema change; do not add columns, tables,
indexes, constraints, backfills, or type changes to the bootstrap. Migrations
are transactional unless the file starts with `-- mdbase:no-transaction`.

Server CI first creates a real PostgreSQL database with the exact server image
from `.github/previous-release.env`, then runs the candidate migrations and
exercises an authenticated OAuth authorization request against the upgraded
database. Release preparation must advance that image to the immediately
preceding release.

Production changes follow expand-and-contract:

1. Add nullable columns, new tables, or compatible indexes.
2. Deploy code that can read both old and new states.
3. Backfill through an idempotent migration or a separately monitored job.
4. Move reads and writes to the new representation.
5. Remove the old representation only in a later release, after the rollback
   window closes.

Application rollback does not roll back database migrations. Consequently,
every migration in a deploy must remain compatible with the previously live
application release. `mdbase-cloud-ops/bin/check-release-safety` enforces that
versioned migration files are additive and are never edited or removed.
