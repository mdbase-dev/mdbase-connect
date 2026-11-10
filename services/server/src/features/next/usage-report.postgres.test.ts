import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAuthAdminCommand } from "../../auth-admin.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { pruneUsageHistory } from "../usage/usage-report.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;

describePg("usage report on PostgreSQL", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("dedicated local test Postgres only");
    schema = `usage_report_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("counts a native grant, its deleted collection's exclusion and expired activity days", async () => {
    const user = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Person')", [user, `${user}@example.test`]);
    const connector = randomUUID();
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, 'Laptop', $3)", [connector, user, randomUUID()]);
    const key = Buffer.alloc(32, 1);
    await db.query(
      `INSERT INTO next_devices (id, connector_id, user_id, kind, sign_pk, kem_pk, noise_pk)
       VALUES ($1, $2, $3, 'desktop', $4, $4, $4)`,
      [randomUUID(), connector, user, key]
    );
    const collection = async () => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO next_collections (collection_id, owner_user_id, runtime, sync, root_key_id)
         VALUES ($1, $2, 'next', 'private', $3)`,
        [id, user, Buffer.alloc(16, 2)]
      );
      return id;
    };
    const kept = await collection();
    const deleted = await collection();
    await db.query(
      `INSERT INTO next_collection_deletion_facts (collection_id, deletion_id, lifecycle_epoch, authority)
       VALUES ($1, $2, 1, 'cp-intent')`,
      [deleted, randomUUID()]
    );
    await db.query("INSERT INTO next_collection_activity (collection_id, last_active_on) VALUES ($1, CURRENT_DATE)", [kept]);
    await db.query(
      `INSERT INTO device_activity_days (connector_id, day)
       VALUES ($1, CURRENT_DATE), ($1, CURRENT_DATE - 500)`,
      [connector]
    );
    const application = randomUUID();
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, family_identity, distribution, name, homepage, redirect_uris)
       VALUES ($1, $2, $2, 'portable', 'Tasks', '', '[]'::jsonb)`,
      [application, `bundle:${application}`]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, next_collection_id, next_collection_sync, operations,
          application_authorization, application_installation_id, activated_at)
       VALUES ($1, $2, $3, $4, 'private', '[]'::jsonb,
         '{"binding":{"protocol_version":5}}'::jsonb, $5, now())`,
      [randomUUID(), user, application, kept, randomUUID()]
    );

    const report = await runAuthAdminCommand(
      ["usage", "report", "--days", "30"],
      { db, defaultRegistrationMode: "closed" }
    ) as Record<string, any>;

    expect(report.activation.all_accounts).toEqual({
      accounts: 1, paired_computer: 1, collection: 1, grant: 1, active_in_window: 1
    });
    expect(report.collections.native).toMatchObject({ total: 1, private: 1, active_in_window: 1 });
    expect(report.transport_users_in_window.native).toMatchObject({ desktop: 1 });
    expect(report.applications[0]).toMatchObject({ name: "Tasks", native_active_grants: 1, local_active_grants: 0 });

    expect((await pruneUsageHistory(db)).device_activity_days).toBe(1);
    const left = await db.query("SELECT 1 FROM device_activity_days WHERE connector_id = $1", [connector]);
    expect(left.rows.length).toBe(1);
  });
});
