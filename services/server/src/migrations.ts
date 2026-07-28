import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryable
} from "./db.js";
import { migrateLegacySchema } from "./db.js";

const MIGRATION_LOCK_ID = 1_291_842_019;
const LEGACY_BASELINE_ID = "0000_legacy_baseline";
const LEGACY_BASELINE_CHECKSUM = createHash("sha256")
  .update("mdbase-connect-control-plane-legacy-baseline-v1")
  .digest("hex");
const NON_TRANSACTIONAL_DIRECTIVE = "-- mdbase:no-transaction";

export interface MigrationOptions {
  lock?: boolean;
  directory?: string;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

export async function runControlPlaneMigrations(
  pool: DatabasePool,
  options: MigrationOptions = {}
): Promise<void> {
  const connection = await pool.connect();
  try {
    if (options.lock) {
      await connection.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    }
    await ensureMigrationLedger(connection);
    await establishLegacyBaseline(connection);
    await applySqlMigrations(
      connection,
      options.directory ?? resolve(import.meta.dirname, "../migrations")
    );
  } finally {
    if (options.lock) {
      await connection
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID])
        .catch(() => undefined);
    }
    connection.release();
  }
}

export async function assertControlPlaneMigrationsCurrent(
  db: DatabaseQueryable,
  options: Pick<MigrationOptions, "directory"> = {}
): Promise<void> {
  const applied = await db.query<AppliedMigration>(
    "SELECT id, checksum FROM schema_migrations"
  );
  const byId = new Map(applied.rows.map((migration) => [
    migration.id,
    migration
  ]));
  const baseline = byId.get(LEGACY_BASELINE_ID);
  if (!baseline) {
    throw new Error("The control-plane legacy baseline has not been migrated.");
  }
  assertChecksum(baseline, LEGACY_BASELINE_CHECKSUM);
  for (const migration of await sqlMigrations(
    options.directory ?? resolve(import.meta.dirname, "../migrations")
  )) {
    const existing = byId.get(migration.id);
    if (!existing) {
      throw new Error(
        `Control-plane migration ${migration.id} has not been applied.`
      );
    }
    assertChecksum(existing, migration.checksum);
  }
}

async function ensureMigrationLedger(db: DatabaseQueryable): Promise<void> {
  const existing = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
  );
  if (existing.rows[0]) return;
  await db.query(`
    CREATE TABLE schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function establishLegacyBaseline(db: DatabaseQueryable): Promise<void> {
  const applied = await db.query<AppliedMigration>(
    "SELECT id, checksum FROM schema_migrations WHERE id = $1",
    [LEGACY_BASELINE_ID]
  );
  if (applied.rows[0]) {
    assertChecksum(applied.rows[0], LEGACY_BASELINE_CHECKSUM);
    return;
  }
  const existingLegacySchema = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users'`
  );
  if (!existingLegacySchema.rows[0]) {
    await migrateLegacySchema(db);
  }
  await db.query(
    `INSERT INTO schema_migrations (id, checksum)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [LEGACY_BASELINE_ID, LEGACY_BASELINE_CHECKSUM]
  );
}

async function applySqlMigrations(
  connection: DatabaseConnection,
  directory: string
): Promise<void> {
  const migrations = await sqlMigrations(directory);
  const applied = await connection.query<AppliedMigration>(
    "SELECT id, checksum FROM schema_migrations"
  );
  const byId = new Map(applied.rows.map((migration) => [
    migration.id,
    migration
  ]));

  for (const migration of migrations) {
    const { id, sql, checksum } = migration;
    const existing = byId.get(id);
    if (existing) {
      assertChecksum(existing, checksum);
      continue;
    }
    if (sql.trimStart().startsWith(NON_TRANSACTIONAL_DIRECTIVE)) {
      await connection.query(sql);
      await recordMigration(connection, id, checksum);
      continue;
    }
    await connection.query("BEGIN");
    try {
      await connection.query(sql);
      await recordMigration(connection, id, checksum);
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
  }
}

async function sqlMigrations(directory: string): Promise<Array<{
  id: string;
  sql: string;
  checksum: string;
}>> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  const migrations = [];
  for (const filename of entries) {
    const id = filename.slice(0, -4);
    const sql = await readFile(resolve(directory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    migrations.push({ id, sql, checksum });
  }
  return migrations;
}

async function recordMigration(
  db: DatabaseQueryable,
  id: string,
  checksum: string
): Promise<void> {
  await db.query(
    "INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)",
    [id, checksum]
  );
}

function assertChecksum(
  applied: AppliedMigration,
  expected: string
): void {
  if (applied.checksum !== expected) {
    throw new Error(
      `Control-plane migration ${applied.id} changed after it was applied.`
    );
  }
}
