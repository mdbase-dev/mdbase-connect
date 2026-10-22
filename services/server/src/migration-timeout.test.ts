import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase, postgresPoolConfig, type DatabasePool } from "./db.js";
import { runControlPlaneMigrations } from "./migrations.js";

const validationId = "0071_validate_native_background_grants";

async function fixture(id: string, sql: string, run: (db: DatabasePool, directory: string, calls: Array<{ text: string; timeout?: number }>) => Promise<void>) {
  const target = fileURLToPath(new URL("../../../target/", import.meta.url));
  await mkdir(target, { recursive: true });
  const directory = await mkdtemp(`${target}migration-timeout-`);
  const db = await openDatabase("memory");
  const connect = db.connect.bind(db), calls: Array<{ text: string; timeout?: number }> = [];
  db.connect = async () => {
    const connection = await connect(), query = connection.query.bind(connection);
    connection.query = (text, values, timeout) => {
      calls.push({ text, timeout });
      return query(text, values, timeout);
    };
    return connection;
  };
  try {
    await writeFile(`${directory}/${id}.sql`, sql);
    await run(db, directory, calls);
  } finally { await db.end(); await rm(directory, { recursive: true, force: true }); }
}

describe("the single bounded background-validation migration", () => {
  it("sets a transaction-local server limit and matching client limit only for that file's SQL", async () => {
    const sql = "-- mdbase:query-timeout-ms 600000\nCREATE TABLE bounded_validation(id integer PRIMARY KEY);\n";
    await fixture(validationId, sql, async (db, directory, calls) => {
      await runControlPlaneMigrations(db, { directory });
      const index = calls.findIndex(call => call.text === sql);
      expect(calls.slice(index - 2, index + 1)).toEqual([
        { text: "BEGIN", timeout: undefined },
        { text: "SET LOCAL statement_timeout = 600000", timeout: undefined },
        { text: sql, timeout: 600000 }
      ]);
      expect(calls.filter(call => call.timeout !== undefined)).toEqual([{ text: sql, timeout: 600000 }]);
      expect(calls.at(-1)?.text).not.toContain("SET LOCAL");
      expect(calls.some(call => call.text === "COMMIT")).toBe(true);
      const count = calls.length;
      await runControlPlaneMigrations(db, { directory });
      expect(calls.slice(count).some(call => call.timeout !== undefined || call.text.startsWith("SET LOCAL"))).toBe(false);
    });
    expect(postgresPoolConfig("postgres://example.test/mdbase")).toMatchObject({ query_timeout: 20_000, statement_timeout: 15_000, lock_timeout: 5_000 });
  });

  it("leaves ordinary migration queries on the original timeout policy", async () => {
    await fixture("0072_synthetic_ordinary", "CREATE TABLE ordinary_migration(id integer PRIMARY KEY);", async (db, directory, calls) => {
      await runControlPlaneMigrations(db, { directory });
      expect(calls.every(call => call.timeout === undefined)).toBe(true);
      expect(calls.some(call => call.text.startsWith("SET LOCAL"))).toBe(false);
    });
  });

  it.each([
    [validationId, "600001"], [validationId, "20000"], [validationId, "-1"],
    [validationId, "Infinity"], [validationId, "600000.0"], ["0072_wrong_file", "600000"]
  ])("rejects an invalid or misplaced timeout before executing %s (%s)", async (id, value) => {
    await fixture(id, `-- mdbase:query-timeout-ms ${value}\nCREATE TABLE invalid_timeout(id integer);`, async (db, directory, calls) => {
      await expect(runControlPlaneMigrations(db, { directory })).rejects.toThrow("Invalid bounded migration query timeout");
      expect(calls.some(call => call.text.includes("CREATE TABLE invalid_timeout"))).toBe(false);
      expect((await db.query("SELECT 1 FROM schema_migrations WHERE id=$1", [id])).rowCount).toBe(0);
    });
  });

  it("rejects duplicate directives and a nontransactional timeout", async () => {
    for (const header of [
      "-- mdbase:query-timeout-ms 600000\n-- mdbase:query-timeout-ms 600000\n",
      "-- mdbase:no-transaction\n-- mdbase:query-timeout-ms 600000\n"
    ]) {
      await fixture(validationId, `${header}CREATE TABLE invalid_timeout(id integer);`, async (db, directory, calls) => {
        await expect(runControlPlaneMigrations(db, { directory })).rejects.toThrow(/migration.*(directive|timeout)/i);
        expect(calls.some(call => call.text.includes("CREATE TABLE invalid_timeout"))).toBe(false);
      });
    }
  });
});
