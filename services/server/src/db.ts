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
      // pg-mem cannot execute PL/pgSQL triggers. Schema-only compatibility:
      // the real Postgres grant-policy suite qualifies every revocation hook,
      // including raw bulk SQL and cascading deletes (never pg-mem).
      // Only migration0062's schema prefix is adapted; no trigger/currentness
      // authority is emulated. Its real PostgreSQL suite is mandatory.
      const archiveTrigger = "-- mdbase:next-migration-archive-triggers:v1";
      if (sql.includes(archiveTrigger)) return memory.public.many(
        sql.slice(0, sql.indexOf(archiveTrigger)).replace("DEFAULT date_trunc('milliseconds', clock_timestamp())", "DEFAULT now()")
      );
      // pg-mem cannot execute this UPDATE FROM self-join. Empty fixture schemas
      // need only the column; populated backfills require real PostgreSQL.
      const nameBackfill = "-- mdbase:next-display-name-backfill:v1";
      if (sql.includes(nameBackfill)) {
        const result = memory.public.many(sql.slice(0, sql.indexOf(nameBackfill)));
        if (memory.public.one("SELECT count(*) AS n FROM next_collections").n !== 0) {
          throw new Error("Populated collection-name backfill requires PostgreSQL.");
        }
        return result;
      }
      const grantTrigger = "-- mdbase:next-grant-revoke-trigger:v1";
      if (sql.includes(grantTrigger)) return memory.public.many(sql.slice(0, sql.indexOf(grantTrigger)));
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
    // pg-mem's pg adapter stringifies Buffer parameters as UTF-8 SQL literals:
    // bytes can be lost, and random backslashes can crash its escape-string lexer.
    // Hex parameters retain every byte; decode is confined to this memory adapter.
    memory.public.registerFunction({
      name: "decode", args: [DataType.text, DataType.text], returns: DataType.bytea,
      implementation: (value: string, format: string) => {
        if (format !== "hex" || !/^(?:[0-9a-f]{2})*$/u.test(value)) throw new Error("Unsupported memory bytea encoding.");
        return Buffer.from(value, "hex");
      }
    });
    const adapter = memory.adapters.createPg();
    pool = new adapter.Pool() as unknown as DatabasePool;
    const query = pool.query.bind(pool);
    pool.query = (text, values) => {
      if (!values?.some(Buffer.isBuffer)) return query(text, values);
      const encoded = values.map(value => Buffer.isBuffer(value) ? value.toString("hex") : value);
      const sql = text.replace(/\$(\d+)/gu, (parameter, index: string) =>
        Buffer.isBuffer(values[Number(index) - 1]) ? `decode(${parameter},'hex')` : parameter);
      return query(sql, encoded);
    };
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

/** Test schemas share a DB, not a migration ledger. Keep normal startup on the
 * production-wide lock; only approved Vitest URLs with a private search_path
 * select schema-scoped locking. No new runtime configuration is introduced.
 */
function isolatedPostgresTest(databaseUrl: string | undefined): boolean {
  if (process.env.VITEST !== "true" || process.env.NODE_ENV !== "test"
    || process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL !== "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS"
    || !databaseUrl || !process.env.MDBASE_CONNECT_TEST_DATABASE_URL) return false;
  try {
    const actual = new URL(databaseUrl), approved = new URL(process.env.MDBASE_CONNECT_TEST_DATABASE_URL);
    const schema = /^-csearch_path=([A-Za-z_][A-Za-z0-9_]*)$/.exec(actual.searchParams.get("options") ?? "")?.[1];
    if (!schema || schema === "public" || schema === "information_schema" || schema.startsWith("pg_")) return false;
    if (!["postgres:", "postgresql:"].includes(approved.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(approved.hostname) || !/test/i.test(approved.pathname)
      || approved.searchParams.has("options") || actual.searchParams.getAll("options").length !== 1) return false;
    actual.searchParams.delete("options");
    for (const url of [actual, approved]) url.searchParams.sort();
    return actual.href === approved.href;
  } catch { return false; }
}

export async function createDatabase(
  databaseUrl = process.env.DATABASE_URL
): Promise<DatabasePool> {
  const pool = await openDatabase(databaseUrl);
  try {
    const { runControlPlaneMigrations } = await import("./migrations.js");
    await runControlPlaneMigrations(pool, {
      lock: Boolean(databaseUrl && databaseUrl !== "memory"),
      isolatedTestSchema: isolatedPostgresTest(databaseUrl)
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
  return pool;
}
