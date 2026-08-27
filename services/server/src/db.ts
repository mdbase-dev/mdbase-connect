import pg, { type Pool, type PoolConfig } from "pg";
import type { DatabasePool } from "./database-types.js";

export type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryable
} from "./database-types.js";
export * from "./legacy-baseline.js";

export async function openDatabase(
  databaseUrl = process.env.DATABASE_URL
): Promise<DatabasePool> {
  let pool: DatabasePool;
  if (!databaseUrl || databaseUrl === "memory") {
    const { DataType, newDb } = await import("pg-mem");
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    memory.public.registerFunction({
      name: "pg_advisory_xact_lock",
      args: [DataType.integer, DataType.integer],
      returns: DataType.bool,
      implementation: () => true
    });
    memory.public.registerFunction({
      name: "pg_try_advisory_lock",
      args: [DataType.integer, DataType.integer],
      returns: DataType.bool,
      implementation: () => true
    });
    memory.public.registerFunction({
      name: "pg_advisory_unlock",
      args: [DataType.integer, DataType.integer],
      returns: DataType.bool,
      implementation: () => true
    });
    memory.public.registerFunction({
      name: "replace",
      args: [DataType.text, DataType.text, DataType.text],
      returns: DataType.text,
      implementation: (value: string, from: string, to: string) =>
        value.split(from).join(to)
    });
    // pg-mem does not parse PostgreSQL's row-locking clause. Keep production
    // queries intact while letting ordinary in-memory tests exercise their
    // non-concurrent semantics; real locking is covered by the PostgreSQL test.
    memory.public.interceptQueries((sql) => {
      if (!sql.includes("FOR UPDATE SKIP LOCKED")) return null;
      const unlocked = sql.replace(/\s+FOR UPDATE SKIP LOCKED/g, "");
      const cte = unlocked.match(/^\s*WITH candidate AS \(([\s\S]*?)\)\s*UPDATE /);
      if (!cte) return memory.public.many(unlocked);
      const compatible = unlocked
        .replace(/^\s*WITH candidate AS \([\s\S]*?\)\s*(?=UPDATE )/, "")
        .replace("FROM candidate WHERE job.application_id=candidate.application_id",
          `WHERE application_id=(${cte[1]})`)
        .replace(" AS job SET", " SET")
        .replaceAll("job.", "");
      return memory.public.many(compatible);
    });
    const adapter = memory.adapters.createPg();
    pool = new adapter.Pool() as unknown as DatabasePool;
  } else {
    pool = new pg.Pool(postgresPoolConfig(databaseUrl)) as Pool;
  }
  return pool;
}

export function postgresPoolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    application_name: "mdbase-connect-control-plane",
    max: 20,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 30 * 60,
    query_timeout: 20_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000
  };
}

export async function createDatabase(
  databaseUrl = process.env.DATABASE_URL
): Promise<DatabasePool> {
  const pool = await openDatabase(databaseUrl);
  try {
    const { runControlPlaneMigrations } = await import("./migrations.js");
    await runControlPlaneMigrations(pool, {
      lock: Boolean(databaseUrl && databaseUrl !== "memory")
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  return pool;
}
