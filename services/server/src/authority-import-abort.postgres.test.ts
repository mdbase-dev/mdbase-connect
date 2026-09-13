import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { finishAuthorityImportAbort } from "./features/authority-transfer/lifecycle.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const schema = `authority_abort_test_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let db: DatabasePool;

suite("authority import abort receipts on PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Abort receipt tests require a dedicated local test database.");
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

  async function fixture() {
    const userId = randomUUID();
    const connectorId = randomUUID();
    const localId = randomUUID();
    const hostedId = randomUUID();
    const transferId = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, '[test] Owner')", [userId, `${userId}@example.test`]);
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, '[test] Computer', $3)", [connectorId, userId, randomUUID()]);
    await db.query(
      `INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version)
       VALUES ($1, $2, $3, $4, '[test] Local', '0.3.0')`,
      [localId, userId, connectorId, hostedId]
    );
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template, authority_state)
       VALUES ($1, $2, '[test] Import', 'mdbase', 'importing')`, [hostedId, userId]
    );
    await db.query(
      `INSERT INTO authority_transfers (id, user_id, hosted_collection_id, local_collection_id, direction, state, expires_at, next_authority_epoch)
       VALUES ($1, $2, $3, $4, 'to_hosted', 'prepared', now() + interval '1 hour', 2)`,
      [transferId, userId, hostedId, localId]
    );
    return { id: transferId, hosted_collection_id: hostedId, next_authority_epoch: 2, connectorId };
  }

  it("commits cleanup and its acknowledgement together, surviving the cascading delete", async () => {
    const f = await fixture();
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      expect(await finishAuthorityImportAbort(connection, f, "cancelled")).toBe(true);
      expect((await connection.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(1);
      expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(0);
      await connection.query("ROLLBACK");
      expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "prepared" }]);
      expect((await db.query("SELECT id FROM hosted_collections WHERE id=$1", [f.hosted_collection_id])).rows).toHaveLength(1);
      await connection.query("BEGIN");
      expect(await finishAuthorityImportAbort(connection, f, "cancelled")).toBe(true);
      await connection.query("COMMIT");
      expect((await db.query("SELECT id FROM authority_transfers WHERE id=$1", [f.id])).rows).toHaveLength(0);
      expect((await db.query("SELECT id FROM hosted_collections WHERE id=$1", [f.hosted_collection_id])).rows).toHaveLength(0);
      expect((await db.query("SELECT connector_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toEqual([{ connector_id: f.connectorId }]);
      await db.query("DELETE FROM connectors WHERE id=$1", [f.connectorId]);
      expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(0);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });

  it("does not issue a receipt or delete the hosted target when activation wins", async () => {
    const f = await fixture();
    const activation = await db.connect();
    const expiry = await db.connect();
    try {
      await activation.query("BEGIN");
      await activation.query("UPDATE authority_transfers SET state='activating' WHERE id=$1", [f.id]);
      await expiry.query("BEGIN");
      const aborted = finishAuthorityImportAbort(expiry, f, "expired");
      await activation.query("COMMIT");
      expect(await aborted).toBe(false);
      await expiry.query("ROLLBACK");
      expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "activating" }]);
      expect((await db.query("SELECT id FROM hosted_collections WHERE id=$1", [f.hosted_collection_id])).rows).toHaveLength(1);
      expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(0);
    } finally {
      await activation.query("ROLLBACK");
      await expiry.query("ROLLBACK");
      activation.release();
      expiry.release();
    }
  });
});
