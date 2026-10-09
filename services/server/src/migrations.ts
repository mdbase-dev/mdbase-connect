import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  backfillLegacyAccountCreationEmailClaims
} from "./account-creation-email-claims.js";
import { retireLegacyContractScopedGrants } from "./legacy-backfills.js";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryable
} from "./database-types.js";
import { bootstrapLegacyBaseline } from "./legacy-baseline.js";

const MIGRATION_LOCK_ID = 1_291_842_019;
// Data-only repair: the schema is usable before it runs, but pre-#531 inventory
// writers can undo it. Keep its published SQL/checksum immutable and execute
// after the corrected server fleet has drained every predecessor instance.
const POST_ROLLOUT_AUTHORITY_REPAIR = "0036_authority_import_source_repair";
const LEGACY_BASELINE_ID = "0000_legacy_baseline";
const LEGACY_BASELINE_CHECKSUM = createHash("sha256")
  .update("mdbase-connect-control-plane-legacy-baseline-v1")
  .digest("hex");
const NON_TRANSACTIONAL_DIRECTIVE = "-- mdbase:no-transaction";
const SKIP_IF_TABLE_DIRECTIVE = "-- mdbase:skip-if-table ";
const SKIP_IF_MISSING_TABLE_DIRECTIVE = "-- mdbase:skip-if-missing-table ";

interface MigrationOptions {
  lock?: boolean;
  /** Only the approved isolated PostgreSQL test factory sets this. */
  isolatedTestSchema?: boolean;
  directory?: string;
}

export interface MigrationEvidence {
  legacyContractScopedGrantsRetired: number;
}

interface AppliedMigration {
  id: string;
  checksum: string;
}

const repairMutationSchema = z.object({
  operationId: z.uuid(),
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000)
});

export async function migrationExecutableSha256(): Promise<string> {
  return createHash("sha256").update(await readFile(import.meta.filename)).digest("hex");
}

/** The release owner must exclude old inventory writers before invocation.
 * Always rerun the canonical repair: a legacy startup may have recorded it
 * before an old inventory writer undid it. Schema readiness is not completion.
 */
export async function repairAuthorityImportSources(
  db: DatabasePool,
  mutation: unknown,
  sourceRevision: string,
  expectedChecksum: string
): Promise<{
  operation_id: string;
  source_revision: string;
  migration_id: string;
  checksum: string;
  executable_sha256: string;
  repaired_sources: number;
}> {
  const input = repairMutationSchema.parse(mutation);
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new Error("Authority repair requires an exact runtime revision.");
  }
  const migration = (await sqlMigrations(
    resolve(import.meta.dirname, "../migrations")
  )).find(({ id }) => id === POST_ROLLOUT_AUTHORITY_REPAIR);
  if (!migration) throw new Error("Canonical authority source repair is missing.");
  const { sql, checksum } = migration;
  if (checksum !== expectedChecksum) {
    throw new Error("Authority source repair SQL does not match the qualified candidate.");
  }
  const executableSha256 = await migrationExecutableSha256();
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    await assertControlPlaneMigrationsCurrent(connection);
    // Match inventory and authority transitions' account -> source lock order.
    await connection.query(
      `SELECT id FROM users
       WHERE id IN (
         SELECT user_id FROM authority_transfers
         WHERE direction = 'to_hosted'
           AND state IN ('requested', 'prepared', 'activating')
       ) ORDER BY id FOR UPDATE`
    );
    const result = await connection.query(sql);
    const repairedSources = result.rowCount;
    if (repairedSources === null || !Number.isSafeInteger(repairedSources) || repairedSources < 0) {
      throw new Error("Authority repair did not return an update count.");
    }
    await connection.query(
      `INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [POST_ROLLOUT_AUTHORITY_REPAIR, checksum]
    );
    const output = {
      operation_id: input.operationId, source_revision: sourceRevision,
      migration_id: POST_ROLLOUT_AUTHORITY_REPAIR, checksum,
      executable_sha256: executableSha256, repaired_sources: repairedSources
    };
    await connection.query(
      `INSERT INTO audit_events
         (id, user_id, event_type, subject_id, metadata)
       VALUES ($1, NULL, 'authority.import_sources.repaired', $2, $3::jsonb)`,
      [randomUUID(), input.operationId,
        JSON.stringify({ ...output, actor: input.actor, reason: input.reason })]
    );
    await connection.query("COMMIT");
    return output;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export async function runControlPlaneMigrations(
  pool: DatabasePool,
  options: MigrationOptions = {}
): Promise<MigrationEvidence> {
  const connection = await pool.connect();
  let legacyContractScopedGrantsRetired = 0;
  const lockParameters = [MIGRATION_LOCK_ID];
  let lockArguments = "$1";
  let lockAcquired = false;
  try {
    if (options.lock) {
      if (options.isolatedTestSchema) {
        const schema = (await connection.query<{ schema: string | null }>(
          "SELECT current_schema() AS schema"
        )).rows[0]?.schema;
        if (!schema || schema === "public" || schema === "information_schema" || schema.startsWith("pg_")) {
          throw new Error("Isolated migration locks require a private test schema.");
        }
        // PostgreSQL's two-int lock namespace is separate from the production
        // bigint lock. Hash the actual schema, not an unvalidated URL hint.
        lockParameters.push(createHash("sha256").update(schema).digest().readInt32BE(0));
        lockArguments = "$1::integer, $2::integer";
      }
      await connection.query(`SELECT pg_advisory_lock(${lockArguments})`, lockParameters);
      lockAcquired = true;
    }
    await ensureMigrationLedger(connection);
    await establishLegacyBaseline(connection);
    await applySqlMigrations(
      connection,
      options.directory ?? resolve(import.meta.dirname, "../migrations")
    );
    if (await tableExists(connection, "application_reconciliation_jobs")) {
      legacyContractScopedGrantsRetired = await retireLegacyContractScopedGrants(
        connection
      );
    }
    if (await tableExists(connection, "account_creation_email_claims")) {
      await backfillLegacyAccountCreationEmailClaims(connection);
    }
  } finally {
    if (lockAcquired) {
      await connection
        .query(`SELECT pg_advisory_unlock(${lockArguments})`, lockParameters)
        .catch(() => undefined);
    }
    connection.release();
  }
  return { legacyContractScopedGrantsRetired };
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
      if (migration.id === POST_ROLLOUT_AUTHORITY_REPAIR) continue;
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
     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`
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
     WHERE table_schema = current_schema() AND table_name = 'users'`
  );
  if (!existingLegacySchema.rows[0]) {
    await bootstrapLegacyBaseline(db);
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
    if (id === POST_ROLLOUT_AUTHORITY_REPAIR) continue;
    const skipIfTable = migrationDirectiveValue(
      sql,
      SKIP_IF_TABLE_DIRECTIVE
    );
    if (skipIfTable && await tableExists(connection, skipIfTable)) {
      await recordMigration(connection, id, checksum);
      continue;
    }
    const skipIfMissingTable = migrationDirectiveValue(
      sql,
      SKIP_IF_MISSING_TABLE_DIRECTIVE
    );
    if (
      skipIfMissingTable
      && !(await tableExists(connection, skipIfMissingTable))
    ) {
      await recordMigration(connection, id, checksum);
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

function migrationDirectiveValue(
  sql: string,
  directive: string
): string | undefined {
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("--")) break;
    if (trimmed.startsWith(directive)) {
      const value = trimmed.slice(directive.length).trim();
      if (!/^[a-z][a-z0-9_]*$/.test(value)) {
        throw new Error(`Invalid migration directive: ${trimmed}`);
      }
      return value;
    }
  }
  return undefined;
}

async function tableExists(
  db: DatabaseQueryable,
  tableName: string
): Promise<boolean> {
  const existing = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1`,
    [tableName]
  );
  return Boolean(existing.rows[0]);
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
