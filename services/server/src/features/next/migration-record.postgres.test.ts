import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { lock } from "./bootstrap-common.js";
import { recordCollectionDeletionIntent } from "./collection-deletion.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { registerCollectionMigrationRecordRoute } from "./migration-record-routes.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import type { RegisteredDeviceKind } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const ROOT = Buffer.alloc(16, 3);
const TIME = "2026-10-09T00:00:00.123Z";
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);

describePg("native migration record (isolated real PostgreSQL; synthetic acknowledged policy)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_record_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerCollectionMigrationRecordRoute(app, db);
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function identity(kind: RegisteredDeviceKind | null = "desktop") {
    const account = randomUUID(), connector = { id: randomUUID(), user_id: account }, token = randomUUID(), device = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Synthetic','next')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Synthetic',$3)", [connector.id, account, tokenHash(token)]);
    const key = generateKeyPairSync("ed25519").privateKey, signPk = ed25519RawPublicKey(key), kemPk = rawX(), noisePk = rawX();
    if (kind) {
      const challenge = await issueDeviceChallenge(db, connector.id);
      await registerDevice(db, connector, { device_id: device, kind, sign_pk: hex(signPk), kem_pk: hex(kemPk), noise_pk: hex(noisePk), challenge: challenge.challenge,
        sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(challenge.challenge, "hex"), connectorId: connector.id, deviceId: device, signPk, kemPk, noisePk }), key)) });
    }
    return { account, connector, device, kind: kind ?? "desktop", signPk, kemPk, noisePk, headers: { authorization: `Bearer ${token}` } };
  }
  type Who = Awaited<ReturnType<typeof identity>>;
  async function append(collection: string) {
    const seq = Number((await db.query("SELECT count(*)::text AS n FROM next_policy_batches WHERE collection_id=$1", [collection])).rows[0].n) + 1;
    const batch = (await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,$2,$3,$4,$2,'appended',now()) RETURNING id", [collection, seq, Buffer.alloc(32), Buffer.from([seq])])).rows[0].id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$1 WHERE collection_id=$2 AND batch_id IS NULL", [batch, collection]);
  }
  async function fixture(owner?: Who, readers?: Who[], cutOver = true) {
    owner ??= await identity();
    readers ??= [owner];
    const collection = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'[test] Synthetic','mdbase')", [collection, owner.account]);
    await registerNextCollection(db, { collectionId: collection, ownerUserId: owner.account, runtime: "next", sync: "cloud_copy", rootKeyId: ROOT,
      ops: [{ op: "genesis", owner: owner.account, root: ROOT, state: "cloud-copy" },
        { op: "member-set", account: owner.account, role: "owner" },
        ...readers.filter(reader => reader.account !== owner.account).map(reader => ({ op: "member-set" as const, account: reader.account, role: "editor" as const })),
        ...readers.map(reader => ({ op: "device-enrol" as const, device: reader.device, account: reader.account, kind: reader.kind,
          signPublicKey: reader.signPk, kemPublicKey: reader.kemPk, noisePublicKey: reader.noisePk }))] });
    await append(collection);
    if (cutOver) await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest,cutover_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [collection, owner.account, "9007199254740993", "9223372036854775806", "9223372036854775807", "a".repeat(64), TIME]);
    return { collection, owner };
  }
  const get = (collection: string, who: Who, headers = who.headers) => app.inject({ method: "GET", url: `/v1/next/collections/${collection}/migration-record`, headers });
  const denied = async (collection: string, who: Who, status = 404) => {
    const response = await get(collection, who);
    expect(response.statusCode, response.body).toBe(status); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain('"s_final"');
    if (status === 404) expect(response.json()).toEqual({ error: { code: "not_found", message: "Collection not found." } });
  };

  it.each(["desktop", "cli"] as const)("returns precisely eight bare fields and lossless decimal sequences to a current %s", async kind => {
    const who = await identity(kind), f = await fixture(who);
    const before = (await db.query("SELECT count(*)::text AS n FROM next_device_challenges WHERE connector_id=$1", [who.connector.id])).rows;
    const response = await get(f.collection, who);
    expect(response.statusCode, response.body).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ collection_id: f.collection, legacy_collection_id: f.collection, ids_preserved: true,
      s_final: "9007199254740993", cutover_seq: "9223372036854775806", barrier_f: "9223372036854775807", final_digest: "a".repeat(64), cutover_at: TIME });
    expect((await db.query("SELECT count(*)::text AS n FROM next_device_challenges WHERE connector_id=$1", [who.connector.id])).rows).toEqual(before);
  });
  it("uses the actual owner's ledger for a currently enrolled cross-account member", async () => {
    const owner = await identity(), member = await identity("cli"), f = await fixture(owner, [owner, member]);
    const response = await get(f.collection, member);
    expect(response.statusCode, response.body).toBe(200); expect(response.json().collection_id).toBe(f.collection);
  });
  it("returns authorized absence409, but unauthorized and nonexistent404 with identical bodies", async () => {
    const owner = await identity(), foreign = await identity(), f = await fixture(owner, [owner], false);
    const absent = await get(f.collection, owner);
    expect(absent.statusCode).toBe(409); expect(absent.json().error.code).toBe("not_cut_over");
    await denied(f.collection, foreign); await denied(randomUUID(), owner);
    expect((await get(f.collection, foreign)).body).toBe((await get(randomUUID(), owner)).body);
  });
  it.each(["mobile", "app-runtime", null] as const)("does not admit an ordinary connector lacking a current native desktop/CLI identity: %s", async kind => {
    const who = await identity(kind), f = await fixture(who); await denied(f.collection, who);
  });
  it("never substitutes session, application, service or migration credentials for the ordinary connector bearer", async () => {
    const f = await fixture();
    for (const token of ["synthetic-session", "synthetic-app", "synthetic-service", "synthetic-migration"]) {
      const result = await get(f.collection, f.owner, { authorization: `Bearer ${token}` });
      expect(result.statusCode).toBe(401); expect(result.headers["cache-control"]).toBe("no-store"); expect(result.body).not.toContain('"s_final"');
    }
  });
  it.each(["mobile", "app-runtime"] as const)("does not admit a dedicated %s installation credential", async kind => {
    const who = await identity(kind), f = await fixture(who), token = randomUUID();
    await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash)
      VALUES($1,$2,$3,$4,'synthetic','https://synthetic.example.test',$5,$6,$7,$8,$9)`,
      [randomUUID(), who.connector.id, who.device, randomUUID(), kind, who.signPk, who.kemPk, who.noisePk, tokenHash(token)]);
    const response = await get(f.collection, who, { authorization: `Bearer ${token}` });
    expect(response.statusCode).toBe(401); expect(response.body).not.toContain('"s_final"');
  });
  it.each(["legacy", "suspended", "revoked"] as const)("refuses a caller that is no longer current: %s", async mode => {
    const f = await fixture();
    if (mode === "legacy") await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [f.owner.account]);
    if (mode === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.owner.account]);
    if (mode === "revoked") await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.owner.connector.id]);
    await denied(f.collection, f.owner, mode === "legacy" ? 404 : 401);
  });
  it("rechecks the original bearer after preflight instead of accepting only its connector ID", async () => {
    const f = await fixture(), connect = db.connect.bind(db);
    const hook = vi.spyOn(db, "connect").mockImplementationOnce(async () => {
      await db.query("UPDATE connectors SET token_hash=$2 WHERE id=$1", [f.owner.connector.id, tokenHash(randomUUID())]);
      return connect();
    });
    try { await denied(f.collection, f.owner); } finally { hook.mockRestore(); }
  });
  it.each(["left-sync", "shadow", "private", "owner-suspended", "hosted-owner", "transferred"] as const)("refuses a noncurrent collection: %s", async mode => {
    const owner = await identity(), member = await identity(), f = await fixture(owner, [owner, member]);
    if (mode === "left-sync") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    if (mode === "shadow") await db.query("UPDATE next_collections SET runtime='shadow' WHERE collection_id=$1", [f.collection]);
    if (mode === "private") await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [f.collection]);
    if (mode === "owner-suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [owner.account]);
    if (mode === "hosted-owner") await db.query("UPDATE hosted_collections SET user_id=$2 WHERE id=$1", [f.collection, member.account]);
    if (mode === "transferred") await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [f.collection]);
    await denied(f.collection, member);
  });
  it("revalidates an owner change after discovery before publishing any ledger metadata", async () => {
    const f = await fixture(), replacement = await identity(), connect = db.connect.bind(db);
    const hook = vi.spyOn(db, "connect").mockImplementationOnce(async () => {
      const client = await connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql === "SELECT owner_user_id FROM next_collections WHERE collection_id=$1") {
            await db.query("UPDATE next_collections SET owner_user_id=$2 WHERE collection_id=$1", [f.collection, replacement.account]);
            await db.query("UPDATE hosted_collections SET user_id=$2 WHERE id=$1", [f.collection, replacement.account]);
          }
          return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    try { await denied(f.collection, f.owner); } finally { hook.mockRestore(); }
  });
  it("returns content-free503 on actual account-lock contention, without retry or publication", async () => {
    const f = await fixture(), blocker = await db.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.owner.account]);
      const response = await get(f.collection, f.owner);
      expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe("busy");
      expect(response.headers["cache-control"]).toBe("no-store"); expect(response.body).not.toContain('"s_final"');
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });
  it.each(["pending", "lost", "wrong-key", "wrong-account", "revoked"] as const)("requires the exact current acknowledged enrollment: %s", async mode => {
    const f = await fixture();
    if (mode === "pending") await db.query("UPDATE next_policy_batches SET state='sending' WHERE collection_id=$1", [f.collection]);
    if (mode === "lost") await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE collection_id=$1", [f.collection]);
    if (mode === "wrong-key") await db.query("UPDATE next_devices SET kem_pk=$2 WHERE id=$1", [f.owner.device, rawX()]);
    if (mode === "wrong-account") await db.query("UPDATE next_policy_outbox SET ops=jsonb_set(ops,'{ops,2,account}',$2::jsonb) WHERE collection_id=$1", [f.collection, JSON.stringify(randomUUID())]);
    if (mode === "revoked") await queueNextPolicy(db, f.collection, [{ op: "device-revoke", device: f.owner.device }]);
    await denied(f.collection, f.owner);
  });
  it.each([false, true])("denies membership removal before acknowledgement, including lost batch=%s", async lost => {
    const f = await fixture(); await queueNextPolicy(db, f.collection, [{ op: "member-remove", account: f.owner.account }]);
    if (lost) { await append(f.collection); await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE collection_id=$1 AND seq=2", [f.collection]); }
    await denied(f.collection, f.owner);
  });
  it("denies permanent deletion intent and never emits a cached liveness permission", async () => {
    const f = await fixture(), client = await db.connect();
    try { await client.query("BEGIN"); await lock(client, f.collection); await recordCollectionDeletionIntent(client, f.collection, f.owner.account); await client.query("COMMIT"); }
    finally { client.release(); }
    await denied(f.collection, f.owner);
  });
  it("fails closed on malformed stored metadata instead of publishing an invalid200", async () => {
    const f = await fixture(); await db.query("UPDATE next_migration_collections SET final_digest='invalid' WHERE collection_id=$1", [f.collection]);
    await denied(f.collection, f.owner, 500);
  });
});
