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

Server CI first creates real PostgreSQL databases with the exact server and
provider images from `.github/previous-release.env`. Candidate tests exercise
an authenticated OAuth authorization write and notification recovery against
those upgraded stores. Release preparation must advance both images to the
immediately preceding release.

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

JSONB values are part of the persisted schema too. A Rust or TypeScript type
change is not backward compatible merely because no SQL column changed. Any
incompatible field representation needs a numbered data migration and a
previous-release fixture that reads the upgraded value through candidate code.
