import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const schema = `timer_origin_schema_${randomUUID().replaceAll("-", "")}`;
const grant = randomUUID();
let admin: pg.Pool;
let db: pg.Pool;

// SQL-only qualification: no runtime importer, flip or native authority claims.
suite("0074 legacy timer origin schema on isolated PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Schema tests require a dedicated local test database.");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = new pg.Pool({ connectionString: url.toString() });
    // Minimal FK parent; use the actual immutable timer-table DDL, not a mock.
    await db.query("CREATE TABLE grants(id uuid PRIMARY KEY)");
    await db.query("INSERT INTO grants(id) VALUES($1)", [grant]);
    await db.query(await readFile(new URL("../../../../migrations/0045_next_timers.sql", import.meta.url), "utf8"));
    await db.query(`INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at,data)
      VALUES($1,'test','existing','reminder','2030-01-01T00:00:00Z','{"task":"original"}'::jsonb)`, [grant]);
    await db.query(await readFile(new URL("../../../../migrations/0074_next_timer_legacy_import_origin.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => {
    await db?.end();
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  it("leaves pre-existing timers unchanged with nullable native origin", async () => {
    const row = (await db.query("SELECT generation,status,data,legacy_import_origin FROM next_timers WHERE timer_id='existing'")).rows[0];
    expect(row).toEqual({ generation: "1", status: "scheduled", data: { task: "original" }, legacy_import_origin: null });
    const column = (await db.query("SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='next_timers' AND column_name='legacy_import_origin'", [schema])).rows[0];
    expect(column).toEqual({ is_nullable: "YES", column_default: null });
  });
  it("accepts content-free origin and exact nanoseconds alongside floored operational times", async () => {
    const origin = { namespace: "connect-hosted:test:notifications", id: "old", runtime_id: "scoped:old", generation: "7", status: "fired",
      subject_sha256: "c".repeat(64), source_uri_sha256: "d".repeat(64),
      fire_at: "2030-01-01T00:00:00.123456789Z", record_sha256: "a".repeat(64),
      exact_timestamps: { fire_at: "2030-01-01T00:00:00.123456789Z", fired_at: "2030-01-01T00:00:01.999999999Z" } };
    await db.query(`INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at,generation,status,fired_at,legacy_import_origin)
      VALUES($1,'test','imported','reminder','2030-01-01T00:00:00.123456Z',7,'fired','2030-01-01T00:00:01.999999Z',$2::jsonb)`, [grant, JSON.stringify(origin)]);
    const row = (await db.query(`SELECT legacy_import_origin,data,
      to_char(fire_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due
      FROM next_timers WHERE timer_id='imported'`)).rows[0];
    expect(row.legacy_import_origin).toEqual(origin);
    expect(row.data).toBeNull();
    expect(row.due).toBe("2030-01-01T00:00:00.123456Z");
  });
  it("rejects non-object JSON including JSON null without changing existing rows", async () => {
    for (const value of ["null", "[]", "1", "true", '"text"']) {
      await expect(db.query("UPDATE next_timers SET legacy_import_origin=$1::jsonb WHERE timer_id='existing'", [value])).rejects.toMatchObject({ code: "23514", constraint: "next_timers_legacy_import_origin_object" });
    }
    expect((await db.query("SELECT legacy_import_origin FROM next_timers WHERE timer_id='existing'")).rows[0].legacy_import_origin).toBeNull();
  });
  it.each([
    ["unknown data key", { data: null }],
    ["raw subject", { subject: "private record name" }],
    ["raw source URI", { source_uri: "private record path" }],
    ["malformed digest", { record_sha256: "G".repeat(64) }],
    ["short digest", { record_sha256: "a".repeat(63) }],
    ["numeric digest", { record_sha256: 123 }],
    ["null digest", { record_sha256: null }],
    ["false erasure", { data_erased: false }],
    ["null erasure", { data_erased: null }],
    ["string erasure", { data_erased: "true" }],
    ["unknown timestamp key", { exact_timestamps: { subject: "private" } }],
    ["timestamp array", { exact_timestamps: [] }],
    ["null timestamp object", { exact_timestamps: null }],
    ["numeric timestamp", { exact_timestamps: { fire_at: 123 } }],
    ["null timestamp", { exact_timestamps: { fired_at: null } }],
    ["boolean timestamp", { exact_timestamps: { created_at: true } }],
    ["invalid subject digest", { subject_sha256: "z".repeat(64) }],
    ["null subject digest", { subject_sha256: null }],
    ["invalid source digest", { source_uri_sha256: "a".repeat(63) }],
    ["numeric source digest", { source_uri_sha256: 123 }],
    ["oversized object", { id: "x".repeat(2048) }],
    ["multibyte byte cap", { id: "🧠".repeat(512) }]
  ] as const)("rejects %s", async (_name, fields) => {
    await expect(db.query("UPDATE next_timers SET legacy_import_origin=$1::jsonb WHERE timer_id='existing'", [JSON.stringify({ record_sha256: "a".repeat(64), ...fields })])).rejects.toMatchObject({ code: "23514", constraint: "next_timers_legacy_import_origin_shape" });
  });
  it("requires the digest even when optional fields are absent", async () => {
    await expect(db.query("UPDATE next_timers SET legacy_import_origin='{}'::jsonb WHERE timer_id='existing'")).rejects.toMatchObject({ code: "23514", constraint: "next_timers_legacy_import_origin_shape" });
  });
  it("allows erasure metadata without restoring data or changing the original digest", async () => {
    await db.query("UPDATE next_timers SET legacy_import_origin=$1::jsonb WHERE timer_id='existing'", [JSON.stringify({ record_sha256: "b".repeat(64) })]);
    await db.query("UPDATE next_timers SET data=NULL,legacy_import_origin=jsonb_set(legacy_import_origin,'{data_erased}','true'::jsonb) WHERE timer_id='existing'");
    const row = (await db.query("SELECT data,legacy_import_origin FROM next_timers WHERE timer_id='existing'")).rows[0];
    expect(row).toEqual({ data: null, legacy_import_origin: { record_sha256: "b".repeat(64), data_erased: true } });
  });
});
