import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool, type DatabaseQueryable } from "../../db.js";
import { ensureColumn, ensureConstraint, ensureNotNullable, ensureNullable } from "../../legacy-schema-helpers.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;

suite("legacy schema helpers with colliding PostgreSQL schemas", () => {
  let admin: pg.Pool | undefined;
  const schemas: string[] = [];
  const pools: DatabasePool[] = [];
  let source: pg.Pool;
  let target: pg.Pool;
  let url: URL;

  const scopedUrl = (schema: string) => {
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    return scoped.toString();
  };
  const newSchema = async () => {
    const schema = `schema_helpers_${randomUUID().replaceAll("-", "")}`;
    await admin!.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };
  const observed = () => {
    const lookups: number[] = [];
    const db: DatabaseQueryable = {
      async query(text, values) {
        const result = await target.query(text, values);
        if (text.includes("information_schema.")) lookups.push(result.rowCount ?? 0);
        return result;
      }
    };
    return { db, lookups };
  };
  const nullable = async (pool: pg.Pool, column: string) => (await pool.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name='schema_helpers_probe' AND column_name=$1`,
    [column]
  )).rows[0]?.is_nullable;

  beforeAll(async () => {
    url = new URL(testUrl!);
    const database = url.pathname.slice(1);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(database)
      || ["postgres", "template0", "template1"].includes(database)) {
      throw new Error("Schema helper tests require a dedicated local test database.");
    }
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    source = new pg.Pool({ connectionString: scopedUrl(await newSchema()), max: 2 });
    pools.push(source);
    await source.query(`CREATE TABLE schema_helpers_probe (
      id integer PRIMARY KEY, nullable_value text, nonnullable_value text NOT NULL, extra text,
      CONSTRAINT probe_constraint CHECK (id > 0));
      INSERT INTO schema_helpers_probe VALUES (1,NULL,'sentinel','sentinel')`);
    target = new pg.Pool({ connectionString: scopedUrl(await newSchema()), max: 2 });
    pools.push(target);
    await target.query(`CREATE TABLE schema_helpers_probe (
      id integer PRIMARY KEY, nullable_value text NOT NULL, nonnullable_value text);
      INSERT INTO schema_helpers_probe VALUES (1,'target','target')`);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (admin) {
      try {
        for (const schema of schemas) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally { await admin.end(); }
    }
  }, 60_000);

  it("adds a missing local column despite the foreign column", async () => {
    const { db, lookups } = observed();
    await ensureColumn(db, "schema_helpers_probe", "extra", "ALTER TABLE schema_helpers_probe ADD COLUMN extra text");
    await ensureColumn(db, "schema_helpers_probe", "extra", "ALTER TABLE schema_helpers_probe ADD COLUMN extra text");
    expect(lookups).toEqual([0, 1]);
    expect((await target.query("SELECT extra FROM schema_helpers_probe")).rows).toEqual([{ extra: null }]);
    expect((await source.query("SELECT extra FROM schema_helpers_probe")).rows).toEqual([{ extra: "sentinel" }]);
  });

  it("drops only the local NOT NULL despite foreign nullable metadata", async () => {
    const { db, lookups } = observed();
    await ensureNullable(db, "schema_helpers_probe", "nullable_value");
    await ensureNullable(db, "schema_helpers_probe", "nullable_value");
    expect(lookups).toEqual([1, 1]);
    expect(await nullable(target, "nullable_value")).toBe("YES");
    expect(await nullable(source, "nullable_value")).toBe("YES");
  });

  it("sets only the local NOT NULL despite foreign nonnullable metadata", async () => {
    const { db, lookups } = observed();
    await ensureNotNullable(db, "schema_helpers_probe", "nonnullable_value");
    await ensureNotNullable(db, "schema_helpers_probe", "nonnullable_value");
    expect(lookups).toEqual([1, 1]);
    expect(await nullable(target, "nonnullable_value")).toBe("NO");
    expect(await nullable(source, "nonnullable_value")).toBe("NO");
  });

  it("adds the local constraint despite a same-named foreign constraint", async () => {
    const { db, lookups } = observed();
    const statement = "ALTER TABLE schema_helpers_probe ADD CONSTRAINT probe_constraint CHECK (id > 0)";
    await ensureConstraint(db, "schema_helpers_probe", "probe_constraint", statement);
    await ensureConstraint(db, "schema_helpers_probe", "probe_constraint", statement);
    expect(lookups).toEqual([0, 1]);
    for (const pool of [source, target]) {
      const constraints = await pool.query(`SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema=current_schema() AND table_name='schema_helpers_probe' AND constraint_name='probe_constraint'`);
      expect(constraints.rows).toEqual([{ constraint_name: "probe_constraint" }]);
    }
    expect((await source.query("SELECT * FROM schema_helpers_probe")).rows).toEqual([
      { id: 1, nullable_value: null, nonnullable_value: "sentinel", extra: "sentinel" }
    ]);
  });

  it("bootstraps parallel fresh schemas without borrowing a migrated schema's columns or ledger", async () => {
    const seed = await createDatabase(scopedUrl(await newSchema()));
    pools.push(seed);
    const freshSchemas = await Promise.all([newSchema(), newSchema()]);
    const fresh = await Promise.all(freshSchemas.map(async (schema) => {
      const pool = await createDatabase(scopedUrl(schema));
      pools.push(pool);
      return pool;
    }));
    const counts: number[] = [];
    for (const pool of [seed, ...fresh]) {
      const columns = await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='connectors' AND column_name='relay_public_key'`);
      expect(columns.rows).toEqual([{ column_name: "relay_public_key" }]);
      const ledger = await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM schema_migrations");
      counts.push(ledger.rows[0]!.count);
    }
    expect(counts[0]).toBeGreaterThan(1);
    expect(counts).toEqual([counts[0], counts[0], counts[0]]);
  }, 60_000);
});
