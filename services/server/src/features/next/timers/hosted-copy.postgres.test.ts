import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseQueryable } from "../../../database-types.js";
import { readHostedLegacyTimers, type HostedLegacyTimerCursor } from "./hosted-copy.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const time = "2030-01-01T12:13:14.123456Z";
const nano = "2030-01-01T12:13:14.123456789Z";
const grant = "20000000-0000-4000-8000-000000000002";

suite("hosted timer source real PostgreSQL (synthetic schema2 rows, not native migration)", () => {
  let admin: pg.Pool, writer: pg.Pool, reader: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Dedicated local test PostgreSQL required");
    }
    schema = `timer_source_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    writer = new pg.Pool({ connectionString: url.toString(), max: 2 });
    // Physical columns used by the SELECT, matching provider migrations and
    // runtime schema2. Never instantiate PostgresRuntimeStore or its migrations.
    await writer.query(`
      CREATE TABLE hosted_provider_collections(id uuid PRIMARY KEY, state text NOT NULL,
        legacy_migration_id uuid, legacy_migration_started_at timestamptz, head bigint NOT NULL);
      CREATE TABLE mdbase_runtime_schema(singleton boolean PRIMARY KEY CHECK(singleton), version integer NOT NULL);
      INSERT INTO mdbase_runtime_schema VALUES(TRUE,2);
      CREATE TABLE mdbase_runtime_timers(namespace text NOT NULL,id text NOT NULL,generation bigint NOT NULL,
        status text NOT NULL,fire_at timestamptz NOT NULL,lease_worker text,lease_token text,
        lease_expires_at timestamptz,record_json jsonb NOT NULL,PRIMARY KEY(namespace,id));
      CREATE TABLE mdbase_runtime_runs(namespace text NOT NULL,id text NOT NULL,status text NOT NULL,
        lease_worker text,lease_token text,lease_expires_at timestamptz,record_json jsonb,PRIMARY KEY(namespace,id));
      CREATE TABLE hosted_provider_runtime_outbox(collection_id uuid NOT NULL,processed_at timestamptz,
        lease_token text,leased_until timestamptz);
      CREATE TABLE hosted_provider_replicas(id uuid PRIMARY KEY,collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id));
      CREATE TABLE hosted_provider_mutation_journal(replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id),state text NOT NULL,
        lease_expires_at timestamptz);
    `);
    url.searchParams.set("options", `-csearch_path=${schema} -cdefault_transaction_read_only=on`);
    reader = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 60_000);
  afterAll(async () => {
    await reader?.end(); await writer?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function fixture(count = 1, size = 0) {
    const collection = randomUUID(), migration = randomUUID();
    const namespace = `connect-hosted:${collection}:notifications`;
    await writer.query("INSERT INTO hosted_provider_collections VALUES($1,'migrating',$2,$3,7)", [collection, migration, time]);
    const records = Array.from({ length: count }, (_, index) => {
      const timer_id = `timer-${String(index).padStart(4, "0")}`;
      const id = `connect:${grant}:reminders:timer.${Buffer.from(timer_id).toString("hex")}`;
      const status = ["scheduled", "fired", "cancelled"][index % 3]!;
      return { id, generation: 7, status, fire_at: nano, created_at: nano, updated_at: nano,
        fired_at: status === "fired" ? nano : null,
        event_contract: { id: "test/timer", version: "1", digest: `sha256:${"a".repeat(64)}` },
        event_source: { application: "original", implementation: "timer", version: "1" },
        source_uri: "app:test", subject: timer_id,
        data: { grant_id: grant, namespace: "reminders", timer_id, criterion_id: "reminder", data: { text: "x".repeat(size), n: 0.1 } } };
    });
    for (const record of records) {
      // SQL representation floors, raw JSON retains original RFC3339 nanos.
      await writer.query("INSERT INTO mdbase_runtime_timers(namespace,id,generation,status,fire_at,record_json) VALUES($1,$2,7,$3,$4,$5::jsonb)",
        [namespace, record.id, record.status, time, JSON.stringify(record)]);
    }
    const replica = randomUUID();
    await writer.query("INSERT INTO hosted_provider_replicas VALUES($1,$2)", [replica, collection]);
    return { collection, migration, namespace, records, replica };
  }
  const source = () => reader as unknown as DatabaseQueryable;
  it("runs SELECT-only complete C-keyset paging in one read-only snapshot, including all statuses/nanos", async () => {
    const f = await fixture(130, 300);
    const client = await reader.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
      let cursor: HostedLegacyTimerCursor | null = null;
      const seen: string[] = [];
      do {
        const page = await readHostedLegacyTimers(client as unknown as DatabaseQueryable, f.collection, cursor);
        expect(page.timers.length).toBeLessThanOrEqual(64);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(48 * 1024);
        for (const timer of page.timers) {
          expect(timer.fire_at).toBe(nano); expect(timer.created_at).toBe(nano);
          expect(timer.generation).toBe("7"); expect(typeof timer.record_json).toBe("string");
          expect(JSON.parse(timer.record_json).id).toBe(timer.runtime_id);
        }
        if (page.nextCursor) expect(page.nextCursor.runtime_id).toBe(page.timers.at(-1)!.runtime_id);
        seen.push(...page.timers.map(timer => timer.runtime_id)); cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(f.records.map(record => record.id)); expect(new Set(seen).size).toBe(130);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("requires a real empty original point and refuses unsupported schema/fence or drift", async () => {
    const f = await fixture(0);
    expect((await readHostedLegacyTimers(source(), f.collection)).timers).toEqual([]);
    await writer.query("UPDATE mdbase_runtime_schema SET version=1");
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
    await writer.query("UPDATE mdbase_runtime_schema SET version=2");
    const g = await fixture(65);
    const page = await readHostedLegacyTimers(source(), g.collection);
    expect(page.nextCursor).not.toBeNull();
    await writer.query("UPDATE hosted_provider_collections SET head=head+1 WHERE id=$1", [g.collection]);
    await expect(readHostedLegacyTimers(source(), g.collection, page.nextCursor)).rejects.toThrow("original fence changed");
    await writer.query("UPDATE hosted_provider_collections SET state='active' WHERE id=$1", [f.collection]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
  });
  it("refuses expired timer claims and firing, without settling or touching them", async () => {
    const f = await fixture();
    await writer.query("UPDATE mdbase_runtime_timers SET lease_token='synthetic',lease_expires_at='2000-01-01T00:00:00Z' WHERE namespace=$1", [f.namespace]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("lease");
    expect((await writer.query("SELECT lease_token FROM mdbase_runtime_timers WHERE namespace=$1", [f.namespace])).rows[0].lease_token).toBe("synthetic");
    await writer.query("UPDATE mdbase_runtime_timers SET lease_token=NULL,lease_expires_at=NULL,status='firing' WHERE namespace=$1", [f.namespace]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("unsettled status");
  });
  it("does not drain unfinished, UNKNOWN, failed or expired/succeeded-leased runs", async () => {
    const f = await fixture();
    for (const status of ["running", "unknown", "failed", "succeeded"]) {
      await writer.query("INSERT INTO mdbase_runtime_runs VALUES($1,$2,$3,NULL,$4,$5)",
        [f.namespace, status, status, status === "succeeded" ? "synthetic" : null, status === "succeeded" ? "2000-01-01T00:00:00Z" : null]);
      await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
      await writer.query("DELETE FROM mdbase_runtime_runs WHERE namespace=$1", [f.namespace]);
    }
    await writer.query("INSERT INTO mdbase_runtime_runs VALUES('other-original-namespace','foreign','unknown',NULL,NULL,NULL)");
    expect((await readHostedLegacyTimers(source(), f.collection)).timers).toHaveLength(1);
  });
  it("treats only an unleased failed run with resolved attempts as settled, like the provider drain", async () => {
    const f = await fixture();
    const record = (active: number | null, statuses: string[]) =>
      JSON.stringify({ active_attempt: active, attempts: statuses.map(status => ({ invocation_id: "x", status })) });
    const run = (status: string, lease: string | null, json: string | null) => writer.query(
      "INSERT INTO mdbase_runtime_runs VALUES($1,'run',$2,NULL,$3,NULL,$4::jsonb)", [f.namespace, status, lease, json]);
    for (const [status, lease, json] of [
      ["failed", "synthetic", record(null, ["failed"])], ["failed", null, record(0, ["failed"])],
      ["failed", null, record(null, ["dispatching"])], ["failed", null, record(null, ["indeterminate"])],
      ["failed", null, JSON.stringify({ active_attempt: null })], ["failed", null, null],
      ["indeterminate", null, record(null, ["failed"])], ["FAILED", null, record(null, ["failed"])],
    ] as const) {
      await run(status, lease, json);
      await expect(readHostedLegacyTimers(source(), f.collection), `${status} ${lease} ${json}`).rejects.toThrow("source fence/schema/drain unavailable");
      await writer.query("DELETE FROM mdbase_runtime_runs WHERE namespace=$1", [f.namespace]);
    }
    for (const json of [record(null, []), record(null, ["succeeded", "failed"])]) {
      await run("failed", null, json);
      expect((await readHostedLegacyTimers(source(), f.collection)).timers).toHaveLength(1);
      await writer.query("DELETE FROM mdbase_runtime_runs WHERE namespace=$1", [f.namespace]);
    }
  });
  it("keeps paging across the cutover move to migrated on the same run, never another run", async () => {
    const f = await fixture(65);
    const first = await readHostedLegacyTimers(source(), f.collection);
    expect(first.nextCursor).not.toBeNull();
    await writer.query("UPDATE hosted_provider_collections SET state='migrated' WHERE id=$1", [f.collection]);
    const rest = await readHostedLegacyTimers(source(), f.collection, first.nextCursor);
    expect([...first.timers, ...rest.timers].map(timer => timer.runtime_id)).toEqual(f.records.map(record => record.id));
    await writer.query("UPDATE hosted_provider_collections SET legacy_migration_id=$2 WHERE id=$1", [f.collection, randomUUID()]);
    await expect(readHostedLegacyTimers(source(), f.collection, first.nextCursor)).rejects.toThrow("original fence changed");
    for (const state of ["active", "deleted", "MIGRATED"]) {
      await writer.query("UPDATE hosted_provider_collections SET state=$2 WHERE id=$1", [f.collection, state]);
      await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
    }
  });
  it("refuses pending/expired outbox and live in-flight mutation work", async () => {
    const f = await fixture();
    await writer.query("INSERT INTO hosted_provider_runtime_outbox VALUES($1,NULL,NULL,NULL)", [f.collection]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
    await writer.query("UPDATE hosted_provider_runtime_outbox SET processed_at=now(),leased_until='2000-01-01T00:00:00Z' WHERE collection_id=$1", [f.collection]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
    await writer.query("DELETE FROM hosted_provider_runtime_outbox WHERE collection_id=$1", [f.collection]);
    for (const state of ["claimed", "prepared"]) {
      await writer.query("INSERT INTO hosted_provider_mutation_journal VALUES($1,$2,now()+interval '1 minute')", [f.replica, state]);
      await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("source fence/schema/drain unavailable");
      await writer.query("DELETE FROM hosted_provider_mutation_journal WHERE replica_id=$1", [f.replica]);
    }
    // Provider H6 settlement: expired claimed/prepared rows cannot apply while
    // fenced and applied rows are already in head; both are retained evidence.
    await writer.query(`INSERT INTO hosted_provider_mutation_journal VALUES($1,'claimed',now()-interval '1 minute'),
      ($1,'prepared',now()-interval '1 minute'),($1,'applied',now()+interval '1 minute'),($1,'applied',NULL)`, [f.replica]);
    expect((await readHostedLegacyTimers(source(), f.collection)).fence.collection_id).toBe(f.collection);
    await writer.query("DELETE FROM hosted_provider_mutation_journal WHERE replica_id=$1", [f.replica]);
  });
  it("checks physical SQL generation/schedule against raw record, and never transports oversized records", async () => {
    const f = await fixture();
    await writer.query("UPDATE mdbase_runtime_timers SET generation=8 WHERE namespace=$1", [f.namespace]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("SQL/record/wrapper disagreement");
    await writer.query("UPDATE mdbase_runtime_timers SET generation=7,fire_at=fire_at+interval '1 microsecond' WHERE namespace=$1", [f.namespace]);
    await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toThrow("SQL/record/wrapper disagreement");
    const big = await fixture(1, 48 * 1024);
    await expect(readHostedLegacyTimers(source(), big.collection)).rejects.toThrow("missing or oversized original raw record");
  });
  it("fails closed on missing runtime storage without initializing it", async () => {
    const f = await fixture();
    await writer.query("ALTER TABLE mdbase_runtime_schema RENAME TO original_schema_retained");
    try {
      await expect(readHostedLegacyTimers(source(), f.collection)).rejects.toMatchObject({ code: "42P01" });
      expect((await writer.query("SELECT to_regclass('mdbase_runtime_schema') AS name")).rows[0].name).toBeNull();
    } finally { await writer.query("ALTER TABLE original_schema_retained RENAME TO mdbase_runtime_schema"); }
  });
});
