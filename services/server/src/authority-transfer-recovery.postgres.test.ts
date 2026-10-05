import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { buildApp } from "./app.js";
import { HostedProviderResponseError, type HostedProviderClient } from "./hosted-provider.js";
import { recoverExpiredAuthorityTransfers } from "./features/authority-transfer/lifecycle.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const schema = `transfer_recovery_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let db: DatabasePool;

suite("authority transfer recovery fences on PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Recovery tests require a dedicated local test database.");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterEach(async () => {
    await db.query("DROP FUNCTION IF EXISTS suppress_expiry() CASCADE");
    await db.query("DELETE FROM users");
  });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture(direction: "to_hosted" | "to_local" = "to_hosted") {
    const userId = randomUUID(), connectorId = randomUUID(), localId = randomUUID();
    const hostedId = randomUUID(), id = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, '[test] Recovery owner')", [userId, `${userId}@example.test`]);
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, '[test] Recovery computer', $3)", [connectorId, userId, randomUUID()]);
    await db.query(`INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version, authority_state)
      VALUES ($1, $2, $3, $4, '[test] Recovery source', '0.3.0', $5)`,
    [localId, userId, connectorId, hostedId, direction === "to_hosted" ? "active" : "candidate"]);
    await db.query(`INSERT INTO hosted_collections (id, user_id, display_name, template, authority_state, authority_epoch)
      VALUES ($1, $2, '[test] Recovery target', 'mdbase', $3, $4)`,
    [hostedId, userId, direction === "to_hosted" ? "importing" : "transferring", direction === "to_hosted" ? 2 : 1]);
    await db.query(`INSERT INTO authority_transfers (id, user_id, hosted_collection_id, local_collection_id, direction, state, expires_at, next_authority_epoch)
      VALUES ($1, $2, $3, $4, $5, 'prepared', now() - interval '1 hour', 2)`,
    [id, userId, hostedId, localId, direction]);
    return { id, userId, hostedId, localId };
  }

  function provider() {
    const abortAuthorityImport = vi.fn(async () => {});
    const abortAuthorityTransfer = vi.fn(async () => {});
    const expireAuthorityImport = vi.fn(async () => {});
    const expireAuthorityTransfer = vi.fn(async () => {});
    return { abortAuthorityImport, abortAuthorityTransfer, expireAuthorityImport, expireAuthorityTransfer };
  }

  // Observe the real unlocked discovery SELECT, not a sleep or simulated lock.
  function discoveryBarrier() {
    const selected = Promise.withResolvers<void>();
    const observed: DatabasePool = {
      ...db,
      async query(text, values) {
        const result = await db.query(text, values);
        if (text.includes("FROM authority_transfers") && text.includes("expires_at <= now()")) selected.resolve();
        return result;
      }
    };
    return { observed, selected: selected.promise };
  }

  it.each(["renewal", "activation"])("revalidates a %s committed after discovery before calling the provider", async (race) => {
    const f = await fixture();
    const p = provider();
    const owner = await db.connect();
    let recovery: Promise<void> | undefined;
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.userId]);
      await owner.query(race === "renewal"
        ? "UPDATE authority_transfers SET expires_at=now()+interval '1 hour' WHERE id=$1"
        : "UPDATE authority_transfers SET state='activating' WHERE id=$1", [f.id]);
      const barrier = discoveryBarrier();
      recovery = recoverExpiredAuthorityTransfers(barrier.observed, p as unknown as HostedProviderClient);
      await barrier.selected;
      await owner.query("COMMIT");
      await recovery;
      expect(p.abortAuthorityImport).not.toHaveBeenCalled();
      expect(p.expireAuthorityImport).not.toHaveBeenCalled();
      expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows)
        .toEqual([{ state: race === "activation" ? "activating" : "prepared" }]);
      expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts")).rows).toEqual([]);
      expect((await db.query("SELECT authority_state FROM collections WHERE id=$1", [f.localId])).rows)
        .toEqual([{ authority_state: "active" }]);
    } finally {
      await owner.query("ROLLBACK");
      owner.release();
      await recovery?.catch(() => {});
    }
  });

  it("preserves an unpublished provider renewal and never falls back to ordinary cancellation", async () => {
    const f = await fixture();
    const p = provider();
    p.expireAuthorityImport.mockRejectedValue(new HostedProviderResponseError(409, "authority_import_not_expired", "[test] Renewed provider deadline."));
    await recoverExpiredAuthorityTransfers(db, p as unknown as HostedProviderClient);
    expect(p.expireAuthorityImport).toHaveBeenCalledWith(f.id, f.hostedId, 2);
    expect(p.abortAuthorityImport).not.toHaveBeenCalled();
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "prepared" }]);
    expect((await db.query("SELECT transfer_id FROM authority_import_abort_receipts")).rows).toEqual([]);
  });

  it("cannot restore metadata or retire a replacement promotion after another sweep wins", async () => {
    const f = await fixture("to_local");
    const p = provider();
    const owner = await db.connect();
    let recovery: Promise<void> | undefined;
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.userId]);
      await owner.query("UPDATE authority_transfers SET state='expired' WHERE id=$1", [f.id]);
      await owner.query(`INSERT INTO authority_transfers (id, user_id, hosted_collection_id, direction, state, expires_at, next_authority_epoch)
        VALUES ($1, $2, $3, 'to_local', 'prepared', now()+interval '1 hour', 2)`, [randomUUID(), f.userId, f.hostedId]);
      const barrier = discoveryBarrier();
      recovery = recoverExpiredAuthorityTransfers(barrier.observed, p as unknown as HostedProviderClient);
      await barrier.selected;
      await owner.query("COMMIT");
      await recovery;
      expect(p.abortAuthorityTransfer).not.toHaveBeenCalled();
      expect((await db.query("SELECT authority_state FROM collections WHERE id=$1", [f.localId])).rows).toEqual([{ authority_state: "candidate" }]);
      expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [f.hostedId])).rows).toEqual([{ authority_state: "transferring" }]);
    } finally {
      await owner.query("ROLLBACK");
      owner.release();
      await recovery?.catch(() => {});
    }
  });

  it("cleans only the winning expired promotion and its exact account candidates", async () => {
    const f = await fixture("to_local");
    const foreign = await fixture("to_local");
    await db.query("UPDATE authority_transfers SET expires_at=now()+interval '1 hour' WHERE id=$1", [foreign.id]);
    await db.query("UPDATE collections SET local_id=$2 WHERE id=$1", [foreign.localId, f.hostedId]);
    const p = provider();
    await recoverExpiredAuthorityTransfers(db, p as unknown as HostedProviderClient);
    expect(p.expireAuthorityTransfer).toHaveBeenCalledWith(f.id, f.hostedId, 2);
    expect(p.abortAuthorityTransfer).not.toHaveBeenCalled();
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "expired" }]);
    expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [f.hostedId])).rows).toEqual([{ authority_state: "active" }]);
    expect((await db.query("SELECT authority_state, enabled FROM collections WHERE id=$1", [f.localId])).rows).toEqual([{ authority_state: "retired", enabled: false }]);
    expect((await db.query("SELECT authority_state FROM collections WHERE id=$1", [foreign.localId])).rows).toEqual([{ authority_state: "candidate" }]);
  });

  it("does not restore or retire when the actual conditional UPDATE returns zero rows", async () => {
    const f = await fixture("to_local");
    await db.query(`CREATE FUNCTION suppress_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state='expired' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await db.query("CREATE TRIGGER suppress_expiry BEFORE UPDATE OF state ON authority_transfers FOR EACH ROW EXECUTE FUNCTION suppress_expiry()");
    await recoverExpiredAuthorityTransfers(db, provider() as unknown as HostedProviderClient);
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "prepared" }]);
    expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [f.hostedId])).rows).toEqual([{ authority_state: "transferring" }]);
    expect((await db.query("SELECT authority_state FROM collections WHERE id=$1", [f.localId])).rows).toEqual([{ authority_state: "candidate" }]);
  });

  it("bounds every pass including requested/approved expiry instead of a global final UPDATE", async () => {
    for (let i = 0; i < 26; i++) {
      const f = await fixture("to_local");
      await db.query("UPDATE authority_transfers SET state='requested' WHERE id=$1", [f.id]);
    }
    await recoverExpiredAuthorityTransfers(db);
    expect((await db.query("SELECT count(*)::int AS count FROM authority_transfers WHERE state='expired'")).rows).toEqual([{ count: 25 }]);
    expect((await db.query("SELECT count(*)::int AS count FROM authority_transfers WHERE state='requested'")).rows).toEqual([{ count: 1 }]);
    await recoverExpiredAuthorityTransfers(db);
    expect((await db.query("SELECT count(*)::int AS count FROM authority_transfers WHERE state='expired'")).rows).toEqual([{ count: 26 }]);
  });

  it("account overview reads do not invoke provider expiry or cancellation", async () => {
    const f = await fixture();
    const p = provider();
    const { app } = await buildApp({ db, devAuth: true, hostedCollections: true,
      hostedProvider: p as unknown as HostedProviderClient, publicUrl: "http://connect.test" });
    try {
      const session = await app.inject({ method: "POST", url: "/v1/dev/session",
        payload: { name: "[test] Recovery owner", email: `${f.userId}@example.test` } });
      expect(session.statusCode, session.body).toBe(200);
      const cookie = String(session.headers["set-cookie"]).split(";")[0];
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
      expect(me.statusCode, me.body).toBe(200);
      expect(p.abortAuthorityImport).not.toHaveBeenCalled();
      expect(p.expireAuthorityImport).not.toHaveBeenCalled();
      expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "prepared" }]);
    } finally { await app.close(); }
  });

  it("retains current state on an unsupported provider expiry operation", async () => {
    const f = await fixture();
    const p = provider();
    p.expireAuthorityImport.mockRejectedValue(new HostedProviderResponseError(404, "not_found", "[test] Old provider."));
    await expect(recoverExpiredAuthorityTransfers(db, p as unknown as HostedProviderClient)).rejects.toThrow();
    expect(p.abortAuthorityImport).not.toHaveBeenCalled();
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.id])).rows).toEqual([{ state: "prepared" }]);
  });
});
