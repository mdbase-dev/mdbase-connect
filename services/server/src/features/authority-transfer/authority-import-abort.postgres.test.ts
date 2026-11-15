import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { repairAuthorityImportSources } from "../../migrations.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { finishAuthorityImportAbort } from "./lifecycle.js";
import { buildApp } from "../../app.js";
import { tokenHash } from "../../security.js";
import type { HostedProviderClient } from "../hosted/hosted-provider.js";

const repairChecksum = createHash("sha256").update(await readFile(new URL(
  "../../../migrations/0036_authority_import_source_repair.sql", import.meta.url
))).digest("hex");
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
    const token = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, '[test] Owner')", [userId, `${userId}@example.test`]);
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, '[test] Computer', $3)", [connectorId, userId, tokenHash(token)]);
    await db.query(
      `INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version)
       VALUES ($1, $2, $3, $4, '[test] Local', '0.3.0')`,
      [localId, userId, connectorId, hostedId]
    );
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template, authority_state, authority_epoch)
       VALUES ($1, $2, '[test] Import', 'mdbase', 'importing', 2)`, [hostedId, userId]
    );
    await db.query(
      `INSERT INTO authority_transfers (id, user_id, hosted_collection_id, local_collection_id, direction, state, expires_at, next_authority_epoch)
       VALUES ($1, $2, $3, $4, 'to_hosted', 'prepared', now() + interval '1 hour', 2)`,
      [transferId, userId, hostedId, localId]
    );
    return { id: transferId, hosted_collection_id: hostedId, next_authority_epoch: 2, localId, connectorId, userId, token };
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

  async function transferApp(f: Awaited<ReturnType<typeof fixture>>) {
    const { app } = await buildApp({
      db, hostedCollections: true,
      hostedProvider: { url: "https://provider.example", upsertAccount: async () => ({}) } as unknown as HostedProviderClient
    });
    const headers = { authorization: `Bearer ${f.token}` };
    return {
      app,
      sync: () => app.inject({
        method: "POST", url: "/v1/connectors/sync", headers,
        payload: { inventory_revision: 1, collections: [{
          id: f.hosted_collection_id, display_name: "[test] Local", spec_version: "0.3.0", enabled: true, contracts: []
        }] }
      })
    };
  }

  it("rolls back data, ledger and receipt if the durable audit cannot be written", async () => {
    const f = await fixture();
    const operationId = randomUUID();
    await db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false WHERE id=$1", [f.localId]);
    await db.query("DELETE FROM schema_migrations WHERE id='0036_authority_import_source_repair'");
    await db.query("ALTER TABLE audit_events ADD CONSTRAINT reject_repair_audit CHECK (event_type <> 'authority.import_sources.repaired') NOT VALID");
    try {
      await expect(repairAuthorityImportSources(db, {
        operationId, actor: "postgres-test", reason: "predecessor writers drained"
      }, "a".repeat(40), repairChecksum)).rejects.toThrow(/reject_repair_audit/);
      expect((await db.query("SELECT authority_state,authority_epoch FROM collections WHERE id=$1", [f.localId])).rows)
        .toEqual([{ authority_state: "candidate", authority_epoch: "2" }]);
      expect((await db.query("SELECT id FROM schema_migrations WHERE id='0036_authority_import_source_repair'")).rows).toHaveLength(0);
      expect((await db.query("SELECT id FROM audit_events WHERE subject_id=$1", [operationId])).rows).toHaveLength(0);
    } finally {
      await db.query("ALTER TABLE audit_events DROP CONSTRAINT reject_repair_audit");
    }
  });

  it("takes the same account lock as inventory before repairing source rows", async () => {
    const f = await fixture();
    await db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false WHERE id=$1", [f.localId]);
    const blocker = await db.connect();
    let pending: ReturnType<typeof repairAuthorityImportSources> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.userId]);
      pending = repairAuthorityImportSources(db, {
        operationId: randomUUID(), actor: "postgres-test", reason: "predecessor writers drained"
      }, "a".repeat(40), repairChecksum);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const locks = await db.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM users%'"
        );
        if (locks.rows.length > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect((await db.query("SELECT authority_state FROM collections WHERE id=$1", [f.localId])).rows)
        .toEqual([{ authority_state: "candidate" }]);
      await blocker.query("ROLLBACK");
      expect((await pending).repaired_sources).toBeGreaterThanOrEqual(1);
      const t = await transferApp(f);
      try {
        expect((await t.sync()).statusCode).toBe(200);
        expect((await db.query("SELECT authority_state,authority_epoch FROM collections WHERE id=$1", [f.localId])).rows)
          .toEqual([{ authority_state: "active", authority_epoch: "1" }]);
      } finally { await t.app.close(); }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (pending) await pending;
    }
  });
});
