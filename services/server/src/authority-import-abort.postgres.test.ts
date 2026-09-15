import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { finishAuthorityImportAbort } from "./features/authority-transfer/lifecycle.js";
import { buildApp } from "./app.js";
import { audit } from "./platform/audit-events.js";
import { tokenHash } from "./security.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { recoverAccountImportCancellation } from "./features/authority-transfer/account-cancellation.js";

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
    return { id: transferId, hosted_collection_id: hostedId, next_authority_epoch: 2, connectorId, userId, token };
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

  it("uses existing cancellation proof or the new provider fence for legacy expiry", async () => {
    const cancelled = await fixture();
    const expired = await fixture();
    for (const f of [cancelled, expired]) {
      await audit(db, f.userId, "authority_transfer.requested", f.id, {
        connector_id: f.connectorId, collection_id: f.hosted_collection_id,
        direction: "to_hosted", authority_epoch: f.next_authority_epoch
      });
    }
    const connection = await db.connect();
    try {
      // Execute the old cleanup transaction, intentionally without the new
      // receipt helper. The FK cascade removes both transfers; only explicit
      // cancellation committed a terminal audit event.
      await connection.query("BEGIN");
      await connection.query("UPDATE authority_transfers SET state='cancelled' WHERE id=$1", [cancelled.id]);
      await audit(connection, cancelled.userId, "authority_transfer.cancelled", cancelled.id, {
        collection_id: cancelled.hosted_collection_id, direction: "to_hosted"
      });
      await connection.query("DELETE FROM hosted_collections WHERE id=$1", [cancelled.hosted_collection_id]);
      await connection.query("UPDATE authority_transfers SET state='expired' WHERE id=$1", [expired.id]);
      await connection.query("DELETE FROM hosted_collections WHERE id=$1", [expired.hosted_collection_id]);
      await connection.query("COMMIT");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    for (const f of [cancelled, expired]) {
      expect((await db.query("SELECT id FROM authority_transfers WHERE id=$1", [f.id])).rows).toHaveLength(0);
      expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(0);
    }
    let providerCalls = 0;
    const { app } = await buildApp({
      db, devAuth: true, hostedCollections: true,
      hostedProvider: { url: "https://provider.example", reconcileAuthorityImportCancellation: async () => {}, abortAuthorityImport: async () => {
        providerCalls += 1;
        throw new Error("[test] Historical provider record is unavailable");
      } } as unknown as HostedProviderClient
    });
    try {
      const retry = (id: string, token: string) => app.inject({
        method: "DELETE", url: `/v1/connectors/authority-transfers/${id}`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect((await retry(cancelled.id, expired.token)).statusCode).toBe(404);
      expect((await retry(expired.id, expired.token)).statusCode).toBe(200);
      const recovered = await Promise.all([retry(cancelled.id, cancelled.token), retry(cancelled.id, cancelled.token)]);
      expect(recovered.map((response) => response.statusCode)).toEqual([200, 200]);
      expect((await db.query("SELECT connector_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [cancelled.id])).rows).toEqual([{ connector_id: cancelled.connectorId }]);
      expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [expired.id])).rows).toHaveLength(1);
      await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [cancelled.connectorId]);
      expect((await retry(cancelled.id, cancelled.token)).statusCode).toBe(401);
      expect(providerCalls).toBe(0);
    } finally {
      await app.close();
    }
  });

  async function recoveryFixture() {
    const f = await fixture();
    await audit(db, f.userId, "authority_transfer.requested", f.id, {
      connector_id: f.connectorId, collection_id: f.hosted_collection_id, direction: "to_hosted", authority_epoch: 2
    });
    const current = { id: randomUUID(), user_id: f.userId };
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1,$2,'[test] Replacement',$3)", [current.id, current.user_id, tokenHash(randomUUID())]);
    return { ...f, current };
  }

  it("recovers revoked and deleted registrations only after exact provider fencing", async () => {
    for (const missing of [false, true]) {
      const f = await recoveryFixture();
      if (missing) {
        await db.query("DELETE FROM connectors WHERE id=$1", [f.connectorId]);
        await db.query("DELETE FROM hosted_collections WHERE id=$1", [f.hosted_collection_id]);
      } else await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.connectorId]);
      let calls = 0;
      const provider = { reconcileAuthorityImportCancellation: async (...args: unknown[]) => {
        expect(args).toEqual([f.id, f.hosted_collection_id, 2]); calls++;
      } } as unknown as HostedProviderClient;
      expect(await recoverAccountImportCancellation(db, provider, f.current, f.id)).toBe(true);
      expect(calls).toBe(1);
      expect((await db.query("SELECT connector_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toEqual([{ connector_id: f.current.id }]);
      expect((await db.query("SELECT id FROM authority_transfers WHERE id=$1", [f.id])).rows).toHaveLength(0);
      expect(await recoverAccountImportCancellation(db, provider, f.current, f.id)).toBe(true);
    }
  });

  it("rejects live original registrations, different accounts, malformed history and activation", async () => {
    const f = await recoveryFixture();
    const provider = { reconcileAuthorityImportCancellation: async () => { throw new Error("must not call provider"); } } as unknown as HostedProviderClient;
    await expect(recoverAccountImportCancellation(db, provider, f.current, f.id)).rejects.toThrow("Revoke the original");
    expect(await recoverAccountImportCancellation(db, provider, { id: f.current.id, user_id: randomUUID() }, f.id)).toBe(false);
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.connectorId]);
    await db.query("UPDATE hosted_collections SET authority_state='active' WHERE id=$1", [f.hosted_collection_id]);
    expect(await recoverAccountImportCancellation(db, provider, f.current, f.id)).toBe(false);
    await db.query("UPDATE hosted_collections SET authority_state='importing' WHERE id=$1", [f.hosted_collection_id]);
    await db.query("UPDATE authority_transfers SET state='activating' WHERE id=$1", [f.id]);
    await expect(recoverAccountImportCancellation(db, provider, f.current, f.id)).rejects.toThrow("entered activation");
    await db.query("UPDATE audit_events SET metadata='{}' WHERE subject_id=$1", [f.id]);
    expect(await recoverAccountImportCancellation(db, provider, f.current, f.id)).toBe(false);
    expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(0);
  });

  it("keeps recovery pending on provider failure and serializes a concurrent activation reservation", async () => {
    const f = await recoveryFixture();
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.connectorId]);
    const unavailable = { reconcileAuthorityImportCancellation: async () => { throw new Error("provider unavailable"); } } as unknown as HostedProviderClient;
    await expect(recoverAccountImportCancellation(db, unavailable, f.current, f.id)).rejects.toThrow("provider unavailable");
    expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts WHERE transfer_id=$1", [f.id])).rows).toHaveLength(0);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const provider = { reconcileAuthorityImportCancellation: async () => { enter(); await released; } } as unknown as HostedProviderClient;
    const recovering = recoverAccountImportCancellation(db, provider, f.current, f.id);
    await entered;
    let activationFinished = false;
    const activation = db.query("UPDATE authority_transfers SET state='activating' WHERE id=$1 AND state='prepared'", [f.id]).then(result => { activationFinished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(activationFinished).toBe(false);
    release();
    expect(await recovering).toBe(true);
    expect((await activation).rowCount).toBe(0);
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
