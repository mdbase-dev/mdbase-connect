import pg, { type PoolConfig } from "pg";
import type {
  DatabaseConnection, DatabasePool, DatabaseQueryable
} from "./database-types.js";

export type { DatabaseConnection, DatabasePool, DatabaseQueryable };

export async function openDatabase(
  databaseUrl = process.env.DATABASE_URL, ssl?: PoolConfig["ssl"]
): Promise<DatabasePool> {
  let pool: DatabasePool;
  if (!databaseUrl || databaseUrl === "memory") {
    pool = await (await import("./memory-database.js")).openMemoryDatabase();
  } else {
    const postgres = new pg.Pool(postgresPoolConfig(databaseUrl, ssl));
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
          async query(text, values, queryTimeoutMs) {
            try {
              if (queryTimeoutMs === undefined) return await client.query(text, values);
              const query = { text, values, query_timeout: queryTimeoutMs };
              return await client.query(query);
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

export function postgresPoolConfig(connectionString: string, ssl?: PoolConfig["ssl"]): PoolConfig {
  return {
    connectionString,
    ...(ssl === undefined ? {} : { ssl }),
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
