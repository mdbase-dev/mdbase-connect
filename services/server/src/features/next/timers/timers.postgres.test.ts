import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../../db.js";
import { legacyTimerGrantResolver } from "./grants.js";
import { desiredTimer, TimerError } from "./model.js";
import { lookupTimerReceipt, recordTimerReconcile } from "./receipts.js";
import { cancelTimer, lockNamespace, reconcileTimers } from "./store.js";
import { TimerWorker, notificationsConsumer } from "./worker.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const schema = `next_timers_test_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let db: DatabasePool;

const CRITERION = {
  id: "task.reminder",
  event: MDBASE_TIMER_FIRED_CONTRACT,
  presentation: { title: "Task reminder" }
};

suite("timer service on PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Timer tests require a dedicated local test database.");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function grant(): Promise<string> {
    const userId = randomUUID();
    const connectorId = randomUUID();
    const collectionId = randomUUID();
    const applicationId = randomUUID();
    const grantId = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'User')", [userId, `${userId}@example.test`]);
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, 'Computer', $3)", [connectorId, userId, randomUUID()]);
    await db.query(
      `INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version, enabled)
       VALUES ($1, $2, $3, $4, 'Tasks', '0.3.0', true)`,
      [collectionId, userId, connectorId, randomUUID()]
    );
    await db.query(
      `INSERT INTO applications (id, canonical_identity, manifest_version, name, homepage, redirect_uris, notifications)
       VALUES ($1, $2, 1, 'TaskNotes', 'https://tasknotes.example/', '[]'::jsonb, $3::jsonb)`,
      [applicationId, `bundle:test:${applicationId}`, JSON.stringify({ criteria: [CRITERION] })]
    );
    await db.query(
      `INSERT INTO grants (id, user_id, application_id, collection_id, operations, scope,
         application_origin, notification_criteria, application_authorization, application_installation_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, '{"contracts":[]}'::jsonb, 'https://tasknotes.example', $6::jsonb,
               '{"binding":{"protocol_version":4}}'::jsonb, $7)`,
      [grantId, userId, applicationId, collectionId, JSON.stringify(["reconcile_timers"]), JSON.stringify([CRITERION]), randomUUID()]
    );
    return grantId;
  }

  function operation(at = Date.now()): string {
    const time = at.toString(16).padStart(12, "0");
    const random = randomUUID();
    return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15, 18)}-8${random.slice(20, 23)}-${random.slice(24)}`;
  }

  async function transaction<T>(body: (connection: Awaited<ReturnType<DatabasePool["connect"]>>) => Promise<T>): Promise<T> {
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      const result = await body(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally { connection.release(); }
  }

  async function recoveryFixture() {
    const grantId = await grant();
    const termsDigest = createHash("sha256").update(`synthetic-consent:${grantId}`).digest();
    const desired = [desiredTimer({ id: "original", fire_at: new Date(Date.now() + 3_600_000).toISOString() })];
    const input = { operationId: operation(), expectedRevision: 0, criterionId: "task.reminder", desired };
    const authority = async () => ({ grant: (await legacyTimerGrantResolver.resolve(db, grantId))!, termsDigest });
    const run = (request = input, namespace = "receipts", digest = termsDigest) => transaction(connection =>
      recordTimerReconcile(connection, grantId, namespace, request,
        async () => ({ ...(await authority()), termsDigest: digest }),
        current => reconcileTimers(connection, current, namespace, request.criterionId, request.desired)));
    return { grantId, termsDigest, desired, input, authority, run };
  }

  it("recovers the original committed receipt after an intervening cancellation without rearming", async () => {
    const f = await recoveryFixture();
    const original = await f.run();
    await transaction(async connection => {
      await lockNamespace(connection, f.grantId, "receipts");
      await reconcileTimers(connection, (await f.authority()).grant, "receipts", "task.reminder", []);
    });
    expect(await f.run()).toEqual(original);
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", f.input.operationId, await f.authority())).toEqual(original);
    const timer = await db.query("SELECT status, generation FROM next_timers WHERE grant_id = $1", [f.grantId]);
    expect(timer.rows.map(row => ({ ...row, generation: Number(row.generation) }))).toEqual([{ status: "cancelled", generation: 1 }]);
    const state = await db.query("SELECT intent_revision FROM next_timer_namespace_intents WHERE grant_id = $1", [f.grantId]);
    expect(Number(state.rows[0].intent_revision)).toBe(2);
  });

  it("deduplicates concurrent identical operations in actual PostgreSQL transactions", async () => {
    const f = await recoveryFixture();
    const [a, b] = await Promise.all([f.run(), f.run()]);
    expect(a).toEqual(b);
    const rows = await db.query("SELECT count(*) FROM next_timer_operation_receipts WHERE grant_id = $1", [f.grantId]);
    expect(Number(rows.rows[0].count)).toBe(1);
    expect(a.committed_revision).toBe(1);
  });

  it("rejects reuse with changed desired body, namespace, revision or consent", async () => {
    const f = await recoveryFixture();
    await f.run();
    await expect(f.run({ ...f.input, desired: [] })).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(f.run(f.input, "foreign")).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(f.run({ ...f.input, expectedRevision: 1 })).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(f.run(f.input, "receipts", Buffer.alloc(32, 1))).rejects.toMatchObject({ code: "operation_conflict" });
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", f.input.operationId, await f.authority())).not.toBeNull();
  });

  it("rejects a delayed first application after a newer namespace intent", async () => {
    const f = await recoveryFixture();
    await f.run({ ...f.input, operationId: operation(), desired: [] });
    await expect(f.run()).rejects.toMatchObject({ code: "operation_conflict" });
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", f.input.operationId, await f.authority())).toBeNull();
    const timer = await db.query("SELECT count(*) FROM next_timers WHERE grant_id = $1", [f.grantId]);
    expect(Number(timer.rows[0].count)).toBe(0);
  });

  it("a no-op legacy cancellation also fences a delayed original snapshot", async () => {
    const f = await recoveryFixture();
    await transaction(async connection => {
      await lockNamespace(connection, f.grantId, "receipts");
      expect(await cancelTimer(connection, (await f.authority()).grant, "receipts", "original")).toBe(false);
    });
    await expect(f.run()).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("rolls back both mutation and receipt when current authority expires before commit", async () => {
    const f = await recoveryFixture();
    let reads = 0;
    await expect(transaction(connection => recordTimerReconcile(connection, f.grantId, "receipts", f.input,
      async () => {
        if (++reads === 2) throw new TimerError(401, "unauthenticated", "Synthetic authority expired.");
        return f.authority();
      }, current => reconcileTimers(connection, current, "receipts", f.input.criterionId, f.desired)))).rejects.toMatchObject({ statusCode: 401 });
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", f.input.operationId, await f.authority())).toBeNull();
    const timer = await db.query("SELECT count(*) FROM next_timers WHERE grant_id = $1", [f.grantId]);
    expect(Number(timer.rows[0].count)).toBe(0);
  });

  it("never admits expired missing UUIDv7 identities or writes during missing lookup", async () => {
    const f = await recoveryFixture();
    const oldId = operation(Date.now() - 8 * 24 * 60 * 60_000);
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", oldId, await f.authority())).toBeNull();
    await expect(f.run({ ...f.input, operationId: oldId })).rejects.toMatchObject({ code: "operation_not_admitted", details: {
      reason: "operation_clock_window", admission: "not_admitted", operation_outcome: "unknown"
    } });
    const namespaces = await db.query("SELECT count(*) FROM next_timer_namespace_intents WHERE grant_id = $1", [f.grantId]);
    expect(Number(namespaces.rows[0].count)).toBe(0);
  });

  it("retains historical lookup beyond admission and never re-admits an identity after expiry cleanup", async () => {
    const f = await recoveryFixture();
    const original = await f.run();
    const oldId = operation(Date.now() - 8 * 24 * 60 * 60_000);
    await db.query("UPDATE next_timer_operation_receipts SET operation_id = $2, committed_at = $3 WHERE grant_id = $1",
      [f.grantId, oldId, new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()]);
    // Fixture simulates passage of time. Lookup must not enforce new-admission
    // clock windows or delete an otherwise retained historical receipt.
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", oldId, await f.authority())).toEqual({ ...original, operation_id: oldId });
    const retained = await db.query("SELECT count(*) FROM next_timer_operation_receipts WHERE grant_id = $1", [f.grantId]);
    expect(Number(retained.rows[0].count)).toBe(1);
    await f.run({ ...f.input, operationId: operation(), expectedRevision: 1, desired: [] });
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", oldId, await f.authority())).toBeNull();
    await expect(f.run({ ...f.input, operationId: oldId, expectedRevision: 2 })).rejects.toMatchObject({ code: "operation_not_admitted" });
    const timer = await db.query("SELECT status, generation FROM next_timers WHERE grant_id = $1", [f.grantId]);
    expect(timer.rows.map(row => ({ ...row, generation: Number(row.generation) }))).toEqual([{ status: "cancelled", generation: 1 }]);
  });

  it("rejects oversized receipt metadata before invoking the timer mutator", async () => {
    const f = await recoveryFixture();
    let mutated = false;
    const desired = Array.from({ length: 10_000 }, (_, i) => ({ ...f.desired[0], id: `timer-${i}` }));
    await expect(transaction(connection => recordTimerReconcile(connection, f.grantId, "receipts", { ...f.input, desired },
      f.authority, async () => { mutated = true; throw new Error("Unexpected mutation."); }))).rejects.toMatchObject({ statusCode: 413 });
    expect(mutated).toBe(false);
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", f.input.operationId, await f.authority())).toBeNull();
  });

  it("a different authenticated grant cannot read another grant's receipt", async () => {
    const f = await recoveryFixture();
    await f.run();
    const other = await recoveryFixture();
    expect(await lookupTimerReceipt(db, other.grantId, "receipts", f.input.operationId, await other.authority())).toBeNull();
  });

  it("projects closed metadata, not timer data, into the original receipt", async () => {
    const f = await recoveryFixture();
    const original = await transaction(connection => recordTimerReconcile(connection, f.grantId, "receipts", f.input,
      f.authority, async current => {
        const result = await reconcileTimers(connection, current, "receipts", f.input.criterionId, f.desired);
        result.timers[0].data = { synthetic_private_body: "never-copy" };
        return result;
      }));
    expect(original.result.timers[0]).not.toHaveProperty("data");
    const row = await db.query("SELECT result_metadata::text AS body FROM next_timer_operation_receipts WHERE grant_id = $1", [f.grantId]);
    expect(row.rows[0].body).not.toContain("never-copy");
    expect(row.rows[0].body).not.toContain("synthetic_private_body");
  });

  it("denies an unresolved PRIVATE grant before performing any receipt mutation", async () => {
    const f = await recoveryFixture();
    let mutated = false;
    await expect(transaction(connection => recordTimerReconcile(connection, f.grantId, "receipts", f.input,
      async () => ({ ...(await f.authority()), grant: { ...(await f.authority()).grant, state: "e2e", usable: false } }),
      async () => { mutated = true; throw new Error("Unexpected mutation."); }))).rejects.toMatchObject({ statusCode: 403 });
    expect(mutated).toBe(false);
    expect(await lookupTimerReceipt(db, f.grantId, "receipts", f.input.operationId, await f.authority())).toBeNull();
  });

  it("fires each due generation exactly once across concurrent workers", async () => {
    const grantId = await grant();
    const resolved = (await legacyTimerGrantResolver.resolve(db, grantId))!;
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await lockNamespace(connection, grantId, "ns");
      await reconcileTimers(connection, resolved, "ns", "task.reminder",
        Array.from({ length: 50 }, (_, i) => desiredTimer({ id: `t${i}`, fire_at: new Date(Date.now() - 1_000).toISOString() })));
      await connection.query("COMMIT");
    } finally {
      connection.release();
    }
    const workers = Array.from({ length: 4 }, () => new TimerWorker(db, [notificationsConsumer(() => undefined)]));
    await Promise.all(workers.map((worker) => worker.tick()));
    await Promise.all(workers.map((worker) => worker.tick()));
    const events = await db.query<{ count: string }>("SELECT count(*) FROM next_timer_events WHERE grant_id = $1", [grantId]);
    expect(Number(events.rows[0].count)).toBe(50);
    const signals = await db.query<{ count: string }>("SELECT count(*) FROM notification_signals WHERE grant_id = $1", [grantId]);
    expect(Number(signals.rows[0].count)).toBe(50);
  });

  it("demonstrates why repeating a desired snapshot is not original receipt recovery", async () => {
    const grantId = await grant();
    const resolved = (await legacyTimerGrantResolver.resolve(db, grantId))!;
    const desired = [desiredTimer({ id: "original", fire_at: new Date(Date.now() + 3_600_000).toISOString() })];
    const run = async (timers: typeof desired) => {
      const connection = await db.connect();
      try {
        await connection.query("BEGIN");
        await lockNamespace(connection, grantId, "uncertain");
        const result = await reconcileTimers(connection, resolved, "uncertain", "task.reminder", timers);
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    };
    // Treat the first committed HTTP response as lost. Another intent then cancels
    // its timer. Reissuing the old body is a NEW effect, not recovering that reply.
    const original = await run(desired);
    expect(original.timers[0]).toMatchObject({ status: "scheduled", generation: 1 });
    expect((await run([])).cancelled_ids).toEqual(["original"]);
    const replayed = await run(desired);
    expect(replayed.timers[0]).toMatchObject({ status: "scheduled", generation: 2 });
    expect(replayed).not.toEqual(original);
    expect(replayed.cancelled_ids).toEqual([]);
  });

  it("serializes concurrent reconciles of one namespace", async () => {
    const grantId = await grant();
    const resolved = (await legacyTimerGrantResolver.resolve(db, grantId))!;
    const run = async (ids: string[]) => {
      const connection = await db.connect();
      try {
        await connection.query("BEGIN");
        await lockNamespace(connection, grantId, "ns");
        const result = await reconcileTimers(connection, resolved, "ns", "task.reminder",
          ids.map((id) => desiredTimer({ id, fire_at: new Date(Date.now() + 3_600_000).toISOString() })));
        await connection.query("COMMIT");
        return result;
      } finally {
        connection.release();
      }
    };
    await Promise.all([run(["a", "b"]), run(["b", "c"]), run(["c", "d"])]);
    const active = await db.query<{ timer_id: string }>(
      "SELECT timer_id FROM next_timers WHERE grant_id = $1 AND status = 'scheduled' ORDER BY timer_id",
      [grantId]
    );
    // Exactly one reconcile's set survives: the last one to take the lock.
    expect([["a", "b"], ["b", "c"], ["c", "d"]]).toContainEqual(active.rows.map((row) => row.timer_id));
  });
});
