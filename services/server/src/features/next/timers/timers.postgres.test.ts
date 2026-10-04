import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../../db.js";
import { legacyTimerGrantResolver } from "./grants.js";
import { desiredTimer } from "./model.js";
import { lockNamespace, reconcileTimers } from "./store.js";
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
