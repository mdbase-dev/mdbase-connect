import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { buildPolicySnapshot } from "./relay-policy.js";
import { ExactPolicyPublisher } from "./relay-policy-session.js";
import { RelayHub } from "./relay.js";
import { registerGrantRevocationRoute } from "./features/authorizations/grant-revocation-route.js";
import { confirmLocalGrantRevocations, localGrantRevocationStatus, queueLocalGrantRevocations } from "./local-grant-revocation.js";

const databases: DatabasePool[] = [];
const schemaCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.end()));
  await Promise.all(schemaCleanups.splice(0).map((cleanup) => cleanup()));
});

export async function revocationFixture(db: DatabasePool) {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Recovery test')", [id, `${id}@example.test`]);
  await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$1,'Test connector',$2,1)", [id, id]);
  await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$1,$1,$1,'Test collection','0.3.0')", [id]);
  await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'Test app','https://example.test','[]')", [id, id]);
  await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,scope,application_installation_id,application_authorization)
    VALUES($1,$1,$1,$1,'["read"]','{"access":"full_collection","contracts":[]}','test-installation',
    '{"binding":{"protocol_version":4,"contracts":{"semantic_capabilities":1}}}')`, [id]);
  for (const table of ["access_tokens", "refresh_tokens"]) {
    await db.query(`INSERT INTO ${table}(id,token_hash,grant_id,expires_at) VALUES($1,$2,$1,now() + interval '1 day')`, [id, id]);
  }
  return id;
}

async function fixture() {
  let url = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
  if (url) {
    const parsed = new URL(url);
    if (process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL !== "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS"
      || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) {
      throw new Error("A dedicated approved local test database is required");
    }
    const admin = new pg.Pool({ connectionString: url });
    const schema = `revocation_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCleanups.push(async () => { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    url = parsed.toString();
  }
  const db = await createDatabase(url ?? "memory");
  databases.push(db);
  return { db, id: await revocationFixture(db) };
}

export async function exerciseRevocationBarrier(db: DatabasePool, id: string) {
  const old = await buildPolicySnapshot(db, id, 55_000, "1");
  if (!old || !("sequence" in old)) throw new Error("Expected lease snapshot");
  expect(old.grants).toHaveLength(1);
  await queueLocalGrantRevocations(db, id, [id]);
  expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
  for (const table of ["access_tokens", "refresh_tokens"]) {
    expect((await db.query(`SELECT revoked_at FROM ${table} WHERE grant_id=$1`, [id])).rows[0].revoked_at).not.toBeNull();
  }
  const barrier = (await db.query("SELECT revocation_policy_sequence FROM grants WHERE id=$1", [id])).rows[0].revocation_policy_sequence;
  await queueLocalGrantRevocations(db, id, [id]);
  expect((await db.query("SELECT revocation_policy_sequence FROM grants WHERE id=$1", [id])).rows[0].revocation_policy_sequence).toBe(barrier);
  await confirmLocalGrantRevocations(db, id, "1", old.sequence);
  expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
  const newer = await buildPolicySnapshot(db, id, 55_000, "1");
  if (!newer || !("sequence" in newer)) throw new Error("Expected lease snapshot");
  expect(newer.grants).toHaveLength(0);
  await confirmLocalGrantRevocations(db, randomUUID(), "1", newer.sequence);
  await confirmLocalGrantRevocations(db, id, "0", newer.sequence);
  expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
  await confirmLocalGrantRevocations(db, id, "1", newer.sequence);
  expect(await localGrantRevocationStatus(db, id, id)).toBe("revoked");
}

describe("truthful local revocation", () => {
  it.skipIf(!process.env.MDBASE_CONNECT_TEST_DATABASE_URL)("PostgreSQL serializes revocation behind an in-flight snapshot cut", async () => {
    const { db, id } = await fixture();
    const snapshotLocked = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    const revocationIssued = Promise.withResolvers<number>();
    let firstConnection = true;
    const wrapped: DatabasePool = {
      query: db.query.bind(db), end: async () => {},
      async connect() {
        const connection = await db.connect();
        const snapshot = firstConnection;
        firstConnection = false;
        return {
          release: () => connection.release(),
          async query(text, parameters) {
            if (!snapshot && text.startsWith("UPDATE connectors SET policy_sequence")) {
              const result = await connection.query("SELECT pg_backend_pid() AS pid");
              revocationIssued.resolve(result.rows[0].pid);
            }
            const result = await connection.query(text, parameters);
            if (snapshot && text.includes("RETURNING policy_sequence, now()")) {
              snapshotLocked.resolve();
              await releaseSnapshot.promise;
            }
            return result;
          }
        };
      }
    };
    const snapshot = buildPolicySnapshot(wrapped, id, 55_000, "1");
    await snapshotLocked.promise;
    const revocation = queueLocalGrantRevocations(wrapped, id, [id]);
    try {
      const pid = await revocationIssued.promise;
      const deadline = Date.now() + 4_000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await db.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(blocked).toBe(true);
      releaseSnapshot.resolve();
      const old = await snapshot;
      await revocation;
      expect(old?.grants).toHaveLength(1);
      await confirmLocalGrantRevocations(db, id, "1", (old as { sequence: number }).sequence);
      expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
      const fresh = await buildPolicySnapshot(db, id, 55_000, "1");
      expect(fresh?.grants).toHaveLength(0);
      await confirmLocalGrantRevocations(db, id, "1", (fresh as { sequence: number }).sequence);
      expect(await localGrantRevocationStatus(db, id, id)).toBe("revoked");
    } finally {
      releaseSnapshot.resolve();
      await Promise.allSettled([snapshot, revocation]);
    }
  });
  it("requires a post-revocation policy barrier from the exact connector generation", async () => {
    const { db, id } = await fixture();
    await exerciseRevocationBarrier(db, id);
  });

  it.each(["single", "batch"])("%s offline API retains Revoking across repeated requests", async (mode) => {
    const { db, id } = await fixture();
    const relay = new RelayHub(db);
    const app = Fastify();
    registerGrantRevocationRoute(app, { db, relay, tailscaleAuth: true, drainProviderRevocations: async () => {} });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({
          method: mode === "single" ? "DELETE" : "POST",
          url: mode === "single" ? `/v1/grants/${id}` : "/v1/grants/revoke-batch",
          headers: { "tailscale-user-login": `${id}@example.test` },
          ...(mode === "single" ? {} : { payload: { grant_ids: [id] } })
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject(mode === "single"
          ? { revocation_status: "revoking" } : { results: [{ grant_id: id, status: "revoking" }] });
      }
    } finally { await app.close(); await relay.close(); }
  });

  it("publisher never confirms mismatched or legacy acknowledgements", async () => {
    const { db, id } = await fixture();
    await queueLocalGrantRevocations(db, id, [id]);
    const authority = { connectorId: id, generation: "1", isStillCurrent: () => true };
    const publisher = new ExactPolicyPublisher(db, 55_000, async () => "1", () => true);
    await expect(publisher.push(authority, async (message) => ({
      type: "policy_applied", protocol_version: 1, request_id: message.request_id, revision: "wrong", ok: true
    }))).rejects.toThrow();
    expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
    const legacy = new ExactPolicyPublisher(db, 55_000, async () => "1", () => true, "legacy_ack_v0");
    const ack = async (message: { request_id: string; revision: string }) => ({ type: "policy_applied", protocol_version: 1, request_id: message.request_id, revision: message.revision, ok: true });
    await legacy.push(authority, ack);
    expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
    await publisher.push(authority, ack);
    expect(await localGrantRevocationStatus(db, id, id)).toBe("revoked");
  });

  it("binds historical revocation to the first new snapshot rather than an older ack", async () => {
    const { db, id } = await fixture();
    const old = await buildPolicySnapshot(db, id, 55_000, "1");
    await db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [id]);
    await confirmLocalGrantRevocations(db, id, "1", (old as { sequence: number }).sequence);
    expect(await localGrantRevocationStatus(db, id, id)).toBe("revoking");
    const fresh = await buildPolicySnapshot(db, id, 55_000, "1");
    await confirmLocalGrantRevocations(db, id, "1", (fresh as { sequence: number }).sequence);
    expect(await localGrantRevocationStatus(db, id, id)).toBe("revoked");
  });
});
