import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { ensureDevelopmentEntitlement } from "../account/entitlements.js";
import { AuthenticationPolicyStore } from "../../authentication-policy.js";
import { RelayHub } from "../../relay.js";
import { tokenHash } from "../../security.js";
import { registerAccountOverviewRoute } from "../account/me-routes.js";
import { confirmLocalGrantRevocations, localGrantRevocationStatus, queueLocalGrantRevocations } from "../../local-grant-revocation.js";
import { FakeLogService, certify } from "../../../test/policy-log.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { LogServiceClient } from "./log-service-client.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { PolicyEmitter, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { recoverLostPolicy } from "./policy-recovery.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

describePostgres("grant revocation append confirmation (real Postgres)", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const signer = certify(generateKeyPairSync("ed25519").privateKey, generateKeyPairSync("ed25519").privateKey, Date.now());
  const issuer = generateKeyPairSync("ed25519").privateKey;
  const service = new FakeLogService(ed25519RawPublicKey(issuer));
  const client = new LogServiceClient({ url: "http://log.test",
    tokenIssuerKeyPem: issuer.export({ format: "pem", type: "pkcs8" }).toString(),
    transportKeyPem: generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  }, service.fetch);
  const emitters: PolicyEmitter[] = [];

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Grant revocation tests require a dedicated local test database.");
    }
    schema = `grant_revocation_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    service.beforeAppend = undefined;
    service.failNextAppend = false;
    service.refuseNextAppend = false;
    service.dropNextResponse = false;
    for (const emitter of emitters.splice(0)) await emitter.close();
  });
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function fixture(target: "private" | "cloud_copy" | "migrated" = "private") {
    const id = await localGrantFixture(db);
    await ensureDevelopmentEntitlement(db, id);
    const sync = target === "cloud_copy" ? "cloud_copy" : "private";
    await registerNextCollection(db, { collectionId: id, ownerUserId: id, runtime: "next", rootKeyId: signer.cert.root, sync,
      ops: [{ op: "genesis", owner: id, root: signer.cert.root, state: sync === "private" ? "e2e" : "cloud-copy" },
        { op: "member-set", account: id, role: "owner" }] });
    if (target !== "migrated") await db.query(
      "UPDATE grants SET collection_id = NULL, next_collection_id = $1, next_collection_sync = $2 WHERE id = $1", [id, sync]
    );
    const logGrant = randomUUID();
    await db.query("INSERT INTO next_grant_bindings(grant_id, collection_id, log_grant_id, terms_digest) VALUES($1,$1,$2,$3)",
      [id, logGrant, Buffer.alloc(32)]);
    await queueNextPolicy(db, id, [{ op: "grant", grant: logGrant, installation: randomUUID(), appId: "app", account: id,
      capabilities: ["collection.read"], clientPublicKey: Buffer.alloc(32, 9) }]);
    const emitter = new PolicyEmitter(db, client, signer);
    emitters.push(emitter);
    await emitter.drainCollection(id);
    return { id, logGrant, emitter, log: service.logs.get(id.replaceAll("-", ""))! };
  }

  const status = (id: string) => localGrantRevocationStatus(db, id, id);
  const revoke = (id: string) => queueLocalGrantRevocations(db, id, [id]);
  const confirmation = async (id: string) => (await db.query("SELECT revocation_confirmed_at FROM grants WHERE id=$1", [id])).rows[0]!.revocation_confirmed_at;

  async function accountStatus(id: string) {
    const token = randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',1,now()+interval '1 day')",
      [randomUUID(), id, tokenHash(token)]);
    const app = Fastify();
    await app.register(cookie);
    registerAccountOverviewRoute(app, { db, relay: new RelayHub(db), publicUrl: "http://localhost",
      authenticationPolicy: new AuthenticationPolicyStore(db, "open") });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: `mdbase_session=${token}` } });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().grants.find((grant: { id: string }) => grant.id === id).revocation_status;
    } finally { await app.close(); }
  }

  it.each(["private", "cloud_copy", "migrated"] as const)("keeps queued %s revocation pending until its exact log UUID appends", async target => {
    const { id, emitter } = await fixture(target);
    await revoke(id);
    expect(await status(id)).toBe("revoking");
    expect(await accountStatus(id)).toBe("revoking");
    await confirmLocalGrantRevocations(db, id, "1", Number.MAX_SAFE_INTEGER);
    expect(await status(id)).toBe("revoking");
    await emitter.drainCollection(id);
    expect(await status(id)).toBe("revoked");
    expect(await accountStatus(id)).toBe("revoked");
    const batch = (await db.query("SELECT appended_at FROM next_policy_batches WHERE collection_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0]!;
    expect(await confirmation(id)).toEqual(batch.appended_at);
    await revoke(id);
    await emitter.drainCollection(id);
    expect(await confirmation(id)).toEqual(batch.appended_at);
  });

  it("leaves refused policy parked and unconfirmed", async () => {
    const { id, emitter } = await fixture();
    await revoke(id);
    service.refuseNextAppend = true;
    await expect(emitter.drainCollection(id)).rejects.toThrow();
    expect(await status(id)).toBe("revoking");
    expect((await db.query("SELECT state FROM next_policy_batches WHERE collection_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0]!.state).toBe("parked");
    expect(await emitter.drainCollection(id)).toBe(0);
    expect(await confirmation(id)).toBeNull();
  });

  it.each([false, true])("confirms only after exact-byte retry (unknown landed: %s)", async landed => {
    const { id, emitter, log } = await fixture();
    await revoke(id);
    if (landed) service.dropNextResponse = "append";
    else service.failNextAppend = true;
    await expect(emitter.drainCollection(id)).rejects.toThrow();
    expect(await status(id)).toBe("revoking");
    const batch = (await db.query("SELECT item FROM next_policy_batches WHERE collection_id=$1 AND state='sending'", [id])).rows[0]!;
    await emitter.drainCollection(id);
    expect(log.at(-1)).toEqual(batch.item);
    expect(await status(id)).toBe("revoked");
  });

  it("does not confirm head-moved bytes before the rebuilt revoke lands", async () => {
    const { id, emitter, log } = await fixture();
    await revoke(id);
    service.failNextAppend = true;
    await expect(emitter.drainCollection(id)).rejects.toThrow();
    const old = (await db.query("SELECT id,item FROM next_policy_batches WHERE collection_id=$1 AND state='sending'", [id])).rows[0]!;
    log.push(Buffer.from("a0", "hex"));
    const append = client.append.bind(client);
    const observed: string[] = [];
    vi.spyOn(client, "append").mockImplementation(async (...args) => {
      observed.push(await status(id));
      const result = await append(...args);
      observed.push(await status(id));
      return result;
    });
    await emitter.drainCollection(id);
    expect(observed).toEqual(["revoking", "revoking", "revoking", "revoking"]);
    expect((await db.query("SELECT 1 FROM next_policy_batches WHERE id=$1", [old.id])).rows).toEqual([]);
    expect(log.at(-1)).not.toEqual(old.item);
    expect(await status(id)).toBe("revoked");
  });

  it("does not confirm a different bound UUID or a later queued revocation", async () => {
    const { id, emitter, logGrant } = await fixture();
    await queueNextPolicy(db, id, [{ op: "grant-revoke", grant: randomUUID() }]);
    service.failNextAppend = true;
    await expect(emitter.drainCollection(id)).rejects.toThrow();
    await revoke(id);
    const append = client.append.bind(client);
    let attempts = 0;
    vi.spyOn(client, "append").mockImplementation(async (...args) => {
      expect(await status(id)).toBe("revoking");
      attempts += 1;
      return append(...args);
    });
    await emitter.drainCollection(id);
    expect(attempts).toBe(2);
    expect(await status(id)).toBe("revoked");
    expect((await db.query("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0]!.ops.ops)
      .toEqual([{ op: "grant-revoke", grant: logGrant }]);
  });

  it("rolls back append recording when confirmation fails, then retries the landed bytes", async () => {
    const { id, emitter } = await fixture();
    await revoke(id);
    await db.query(`CREATE FUNCTION reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'confirmation failed'; END $$`);
    await db.query(`CREATE TRIGGER reject_confirmation BEFORE UPDATE OF revocation_confirmed_at ON grants
      FOR EACH ROW EXECUTE FUNCTION reject_confirmation()`);
    try {
      await expect(emitter.drainCollection(id)).rejects.toThrow("confirmation failed");
      expect(await status(id)).toBe("revoking");
      expect((await db.query("SELECT state FROM next_policy_batches WHERE collection_id=$1 ORDER BY id DESC LIMIT 1", [id])).rows[0]!.state).toBe("sending");
    } finally {
      await db.query("DROP TRIGGER reject_confirmation ON grants");
      await db.query("DROP FUNCTION reject_confirmation()");
    }
    await emitter.drainCollection(id);
    expect(await status(id)).toBe("revoked");
  });

  it("appends revokes after application cascade deletion without a grant row", async () => {
    const { id, emitter } = await fixture();
    await db.query("DELETE FROM applications WHERE id=$1", [id]);
    expect((await db.query("SELECT 1 FROM grants WHERE id=$1", [id])).rows).toEqual([]);
    expect(await emitter.drainCollection(id)).toBe(1);
  });

  it("completes a native revocation that has no active binding, but not a repeated pending one", async () => {
    const pending = await fixture();
    await revoke(pending.id);
    await revoke(pending.id);
    expect(await status(pending.id)).toBe("revoking");

    const { id } = await fixture();
    await db.query("DELETE FROM next_grant_bindings WHERE grant_id=$1", [id]);
    await revoke(id);
    expect(await status(id)).toBe("revoked");
  });

  it("lets a connector confirm a grant restored to its legacy target after its log revoke appended", async () => {
    const { id, emitter, logGrant } = await fixture("migrated");
    await db.query("UPDATE next_grant_bindings SET active=false WHERE grant_id=$1", [id]);
    await queueNextPolicy(db, id, [{ op: "grant-revoke", grant: logGrant }]);
    await emitter.drainCollection(id);
    await revoke(id);
    expect(await status(id)).toBe("revoking");
    await confirmLocalGrantRevocations(db, id, "1", Number.MAX_SAFE_INTEGER);
    expect(await status(id)).toBe("revoked");
  });

  it("keeps earlier revocation outcomes: appended and unbound complete, unappended pending", async () => {
    const appended = await fixture();
    await revoke(appended.id);
    await appended.emitter.drainCollection(appended.id);
    const unbound = await fixture();
    await db.query("DELETE FROM next_grant_bindings WHERE grant_id=$1", [unbound.id]);
    await revoke(unbound.id);
    const queued = await fixture();
    await revoke(queued.id);
    await db.query("UPDATE grants SET revocation_confirmed_at=NULL WHERE id = ANY($1::uuid[])", [[appended.id, unbound.id]]);

    await db.query(await readFile(new URL("../../../migrations/0096_grant_revocation_append_confirmation.sql", import.meta.url), "utf8"));
    expect([await status(appended.id), await status(unbound.id), await status(queued.id)]).toEqual(["revoked", "revoked", "revoking"]);
  });

  it.each([false, true])("loss recovery confirms only exact landed sending bytes (landed: %s)", async landed => {
    const { id, emitter, log } = await fixture();
    await queueNextPolicy(db, id, [{ op: "freeze", frozen: false }]);
    await emitter.drainCollection(id);
    await revoke(id);
    if (landed) service.dropNextResponse = "append";
    else service.failNextAppend = true;
    await expect(emitter.drainCollection(id)).rejects.toThrow();
    log[1] = Buffer.from("a0", "hex");
    expect(await recoverLostPolicy(db, client, id)).toBe(1);
    expect(await status(id)).toBe(landed ? "revoked" : "revoking");
    if (!landed) expect(await confirmation(id)).toBeNull();
  });
});
