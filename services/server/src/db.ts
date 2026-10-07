import { randomUUID } from "node:crypto";
import pg, { type PoolConfig } from "pg";
import type {
  DatabaseConnection, DatabasePool, DatabaseQueryable
} from "./database-types.js";

export type { DatabaseConnection, DatabasePool, DatabaseQueryable };

export async function openDatabase(
  databaseUrl = process.env.DATABASE_URL
): Promise<DatabasePool> {
  let pool: DatabasePool;
  if (!databaseUrl || databaseUrl === "memory") {
    const { DataType, newDb } = await import("pg-mem");
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    // Schema compatibility only for the fixed timer namespace CHECK; real
    // PostgreSQL tests qualify constraints and transaction/lock semantics.
    memory.public.registerOperator({
      operator: "~", left: DataType.text, right: DataType.text, returns: DataType.bool,
      implementation: (value: string, pattern: string) => {
        if (pattern !== "^[A-Za-z0-9._-]{1,64}$") throw new Error("Unsupported memory regex constraint.");
        return value.length >= 1 && value.length <= 64 && !/[^A-Za-z0-9._-]/u.test(value);
      }
    });
    memory.public.registerFunction({
      name: "pg_advisory_xact_lock",
      args: [DataType.integer],
      returns: DataType.bool,
      implementation: () => true
    });
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
      name: "octet_length",
      args: [DataType.bytea],
      returns: DataType.integer,
      implementation: (value: Uint8Array) => value.length
    });
    // Scalar schema function only; real PostgreSQL tests qualify the CHECK.
    // pg-mem does not distinguish SQL NULL from JSON null for this argument.
    memory.public.registerFunction({
      name: "jsonb_typeof",
      args: [DataType.jsonb],
      returns: DataType.text,
      implementation: (value: unknown) => value === null ? "null"
        : Array.isArray(value) ? "array" : typeof value
    });
    memory.public.registerFunction({
      name: "octet_length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => Buffer.byteLength(value, "utf8")
    });
    memory.public.registerFunction({
      name: "clock_timestamp",
      returns: DataType.timestamptz,
      impure: true,
      implementation: () => new Date()
    });
    memory.public.registerFunction({
      name: "gen_random_uuid",
      returns: DataType.uuid,
      impure: true,
      implementation: () => randomUUID()
    });
    memory.public.registerFunction({
      name: "replace",
      args: [DataType.text, DataType.text, DataType.text],
      returns: DataType.text,
      implementation: (value: string, from: string, to: string) =>
        value.split(from).join(to)
    });
    // pg-mem cannot execute this one PostgreSQL locking CTE. Recognize its
    // private marker and preserve equivalent single-process test semantics.
    memory.public.interceptQueries((sql) => {
      // pg-mem does not use PostgreSQL's automatic CHECK name. Name ONLY the
      // original fixed device-kind CHECK so migration0055 replaces it exactly,
      // without editing historical SQL/checksums or weakening either constraint.
      if (sql.includes("CREATE TABLE next_devices (") && sql.includes("kind text NOT NULL CHECK (kind IN ('desktop', 'cli'))")) {
        return memory.public.many(sql.replace("kind text NOT NULL CHECK (kind IN ('desktop', 'cli'))", "kind text NOT NULL CONSTRAINT next_devices_kind_check CHECK (kind IN ('desktop', 'cli'))"));
      }
      if (sql.trimStart().startsWith("/* mdbase:timer-authority-current:v1 */")) {
        // pg-mem accepts FOR SHARE but not its OF alias list. It cannot qualify
        // locks/currentness; real PostgreSQL HTTP wait/revocation tests do that.
        const aliases = /\s+FOR SHARE OF (?:tok, g, u|g, u)\s*;?$/u;
        if (!aliases.test(sql)) throw new Error("Unexpected timer authority locking shape.");
        return memory.public.many(sql.replace("/* mdbase:timer-authority-current:v1 */", "").replace(aliases, " FOR SHARE"));
      }
      const marker = "/* mdbase:application-reconciliation-claim:v1 */";
      if (!sql.trimStart().startsWith(marker)) return null;
      const lockClause = /\s+FOR UPDATE SKIP LOCKED/g;
      if ([...sql.matchAll(lockClause)].length !== 1) {
        throw new Error("The marked reconciliation claim has an unexpected locking shape.");
      }
      const unlocked = sql.replace(lockClause, "");
      const cte = unlocked.match(/^\s*\/\*[^*]+\*\/\s*WITH candidate AS \(([\s\S]*?)\)\s*UPDATE /);
      const join = "FROM candidate WHERE job.application_id=candidate.application_id";
      if (!cte || !unlocked.includes(join)) {
        throw new Error("The marked reconciliation claim cannot be adapted for pg-mem.");
      }
      const compatible = unlocked
        .replace(/^\s*\/\*[^*]+\*\/\s*WITH candidate AS \([\s\S]*?\)\s*(?=UPDATE )/, "")
        .replace(join, `WHERE application_id=(${cte[1]})`)
        .replace(" AS job SET", " SET")
        .replaceAll("job.", "");
      return memory.public.many(compatible);
    });
    const adapter = memory.adapters.createPg();
    pool = new adapter.Pool() as unknown as DatabasePool;
  } else {
    const postgres = new pg.Pool(postgresPoolConfig(databaseUrl));
    // pg-pool owns errors while a client is idle, but removes its listener on
    // checkout. A disconnect between queries (e.g. during provider I/O inside
    // a transaction) would otherwise be an unhandled EventEmitter error and
    // kill the process. pg still rejects queries and discards broken clients;
    // these listeners contain/report the event, never retry or claim success.
    postgres.on("error", reportDatabaseConnectionFailure);
    postgres.on("acquire", (client) => {
      client.on("error", reportDatabaseConnectionFailure);
    });
    postgres.on("release", (_error, client) => {
      client.removeListener("error", reportDatabaseConnectionFailure);
    });
    pool = {
      query: postgres.query.bind(postgres),
      end: () => postgres.end(),
      async connect() {
        const client = await postgres.connect();
        let failed = false;
        return {
          async query(text, values) {
            try {
              return await client.query(text, values);
            } catch (error) {
              // A fatal query response can precede the socket's error/close
              // event. Do not return that client to the pool in this window.
              // Discard on any query failure, even if ROLLBACK later succeeds.
              failed = true;
              throw error;
            }
          },
          release: () => client.release(failed)
        };
      }
    };
  }
  return pool;
}

function reportDatabaseConnectionFailure(error: Error): void {
  // Never log the error object: pg can attach the client, credentials, SQL,
  // and database details. Keep the observed incident distinguishable using
  // only an owned classification, not arbitrary server error fields.
  console.warn("privacy-safe Connect metric", {
    metric: "database_connection_failure",
    failure_class: (error as { code?: unknown }).code === "25P03"
      ? "idle_transaction_timeout"
      : "connection_failure"
  });
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
