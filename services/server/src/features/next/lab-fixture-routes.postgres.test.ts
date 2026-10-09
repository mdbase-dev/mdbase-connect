import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { parseLabFixtureConfig } from "./lab-fixture-config.js";
import { labFixtureDigest, registerLabFixtureRoutes } from "./lab-fixture-routes.js";
import { LogServiceClient } from "./log-service-client.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, verifyCert, certFromJson, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, encodeCbor, keyId, type Cbor, type Decoded } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const adminToken = "unit-test-fixture-admin-credential-not-a-secret";
const field = (value: Decoded, key: number) => value instanceof Map ? value.get(key) : undefined;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function configuration(): NextControlPlaneConfig {
  const root = generateKeyPairSync("ed25519").privateKey;
  const policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  const pem = (key: typeof root) => key.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }), serviceTokens: {},
    logService: { url: "http://log.test", tokenIssuerKeyPem: pem(generateKeyPairSync("ed25519").privateKey), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }
  };
}

class FixtureLog {
  readonly logs = new Map<string, Buffer>();
  unavailable = false;
  deleteCalls = 0;
  failCreateAfterCommit = false;
  failDeleteAfterCommit = false;
  readonly quotas = new Map<string, number[]>();
  readonly fetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/nonce")) return new Response("ab".repeat(32));
    if (this.unavailable) throw new TypeError("service unavailable");
    const frame = decodeCbor(Buffer.from(init!.body as Uint8Array));
    const method = field(frame, 2);
    const params = field(frame, 3)!;
    const id = hex(field(params, 0) as Uint8Array);
    let result: Cbor;
    if (method === "create_log") {
      const genesis = Buffer.from(field(params, 1) as Uint8Array);
      if (this.logs.has(id) && !this.logs.get(id)!.equals(genesis)) {
        return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [3, { struct: [[0, "invalid"], [1, "exists"]] }]] }));
      }
      this.logs.set(id, genesis);
      if (this.failCreateAfterCommit) throw new TypeError("create outcome unknown");
      result = { struct: [[0, 1], [1, chainHash(genesis)]] };
    } else if (method === "head") {
      const genesis = this.logs.get(id);
      if (!genesis) throw new TypeError("log unavailable");
      result = { struct: [[0, 1], [1, chainHash(genesis)], [2, 1]] };
    } else if (method === "read") {
      const genesis = this.logs.get(id);
      if (!genesis) return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [3, { struct: [[0, "not_found"]] }]] }));
      result = { struct: [[0, [[1, genesis]]]] };
    } else if (method === "set_quota") {
      this.quotas.set(id, field(params, 1) as number[]);
      result = { struct: [] };
    } else if (method === "delete_log") {
      this.deleteCalls += 1;
      this.logs.delete(id);
      if (this.failDeleteAfterCommit) throw new TypeError("delete outcome unknown");
      result = { struct: [] };
    } else throw new Error("unexpected fixture operation");
    return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [2, result]] }), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  };
}

describe("LAB fixture hard configuration boundary", () => {
  it("is absent without a separate credential", () => expect(parseLabFixtureConfig({})).toBeUndefined());
  it.each(["production", "staging", "dev", undefined])("refuses fixture configuration in %s", (environment) => {
    expect(() => parseLabFixtureConfig({ MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_CONNECT_ENVIRONMENT: environment, PUBLIC_URL: "https://connect-lab.mdbase.dev", MDBASE_NEXT_LAB_FIXTURE_ADMIN_TOKEN: adminToken })).toThrow(/fixed LAB/);
  });
  it("refuses a non-LAB origin, missing control plane, or short credential", () => {
    const env = { MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_CONNECT_ENVIRONMENT: "lab", PUBLIC_URL: "https://connect-lab.mdbase.dev", MDBASE_NEXT_LAB_FIXTURE_ADMIN_TOKEN: adminToken };
    expect(() => parseLabFixtureConfig({ ...env, PUBLIC_URL: "https://connect.mdbase.dev" })).toThrow(/fixed LAB/);
    expect(() => parseLabFixtureConfig({ ...env, MDBASE_NEXT_CONTROL_PLANE: "0" })).toThrow(/control plane/);
    expect(() => parseLabFixtureConfig({ ...env, MDBASE_NEXT_LAB_FIXTURE_ADMIN_TOKEN: "short" })).toThrow(/32 bytes/);
    expect(parseLabFixtureConfig(env)).toEqual({ adminToken });
  });
});

describePg("LAB disposable fixture provisioning", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const config = configuration();
  const service = new FixtureLog();
  const log = new LogServiceClient(config.logService, service.fetch);
  let emitter: PolicyEmitter;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Fixture tests require dedicated local test Postgres.");
    schema = `lab_fixture_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    emitter = new PolicyEmitter(db, log, loadPolicySigner(config, Date.now()));
    registerLabFixtureRoutes(app, { db, config: { adminToken }, next: config, environment: "lab", publicUrl: "https://connect-lab.mdbase.dev", emitter, log });
  }, 60_000);
  afterEach(async () => {
    await db.query("TRUNCATE next_lab_fixtures, next_collections CASCADE");
    service.logs.clear();
    service.quotas.clear();
    service.deleteCalls = 0;
    service.failCreateAfterCommit = false;
    service.failDeleteAfterCommit = false;
    service.unavailable = false;
  });
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function identity() {
    const connector = { id: randomUUID(), user_id: randomUUID() };
    const token = randomUUID();
    const device = randomUUID();
    const key = generateKeyPairSync("ed25519").privateKey;
    const signPk = ed25519RawPublicKey(key);
    const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    const kemPk = rawX(); const noisePk = rawX();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Fixture Owner')", [connector.user_id, `${connector.user_id}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Fixture connector',$3)", [connector.id, connector.user_id, tokenHash(token)]);
    const registration = await issueDeviceChallenge(db, connector.id);
    await registerDevice(db, connector, {
      device_id: device, kind: "desktop", sign_pk: hex(signPk), kem_pk: hex(kemPk), noise_pk: hex(noisePk), challenge: registration.challenge,
      sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(registration.challenge, "hex"), connectorId: connector.id, deviceId: device, signPk, kemPk, noisePk }), key))
    }, tokenHash(token));
    return { connector, device, key, signPk, token, headers: { authorization: `Bearer ${token}`, "x-mdbase-lab-admin": adminToken } };
  }
  async function proof(who: Awaited<ReturnType<typeof identity>>, fixture: string, action: "provision" | "delete" = "provision") {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    return { fixture_id: fixture, device_id: who.device, challenge, sig: hex(sign(null, labFixtureDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: who.device, fixture, action }), who.key)), ...(action === "provision" ? { label: "[test] local-unit-run" } : {}) };
  }
  const provision = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: "/internal/v1/next/lab/fixtures/provision", headers, payload });
  const destroy = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: "/internal/v1/next/lab/fixtures/delete", headers, payload });

  it("requires both ordinary identity and a separate admin credential", async () => {
    const who = await identity(); const payload = await proof(who, randomUUID());
    expect((await provision({ authorization: who.headers.authorization }, payload)).statusCode).toBe(403);
    expect((await provision({ "x-mdbase-lab-admin": adminToken }, payload)).statusCode).toBe(401);
    expect((await provision({ ...who.headers, "x-mdbase-lab-admin": who.token }, payload)).statusCode).toBe(403);
    expect((await provision({ ...who.headers, "x-mdbase-lab-admin": "wrong" }, payload)).statusCode).toBe(403);
  });
  it("creates real-signed private genesis/enrol and only a matching scoped token", async () => {
    const who = await identity(); const fixture = randomUUID();
    const response = await provision(who.headers, await proof(who, fixture));
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.state).toBe("e2e"); expect(result.head.seq).toBe(1);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(verifyCert(certFromJson(result.policy_cert), Buffer.from(result.root_public_key, "hex"))).toBe(true);
    const payload = decodeCbor(field(decodeCbor(Buffer.from(result.genesis.item, "hex")), 11) as Uint8Array);
    const ops = field(payload, 3) as Decoded[];
    expect(ops.map((op) => field(op, 0))).toEqual([1, 4, 2]);
    expect(Buffer.from(field(ops[2]!, 4) as Uint8Array).equals(Buffer.from(who.signPk))).toBe(true);
    const claims = decodeCbor(Buffer.from(result.device.token.split(".")[0], "hex"));
    expect(hex(field(claims, 1) as Uint8Array)).toBe(who.device.replaceAll("-", ""));
    expect(hex(field(claims, 5) as Uint8Array)).toBe(fixture.replaceAll("-", ""));
    expect(result.device.expires_at).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    expect(service.quotas.get(fixture.replaceAll("-", ""))).toEqual([16 * 1024 * 1024, 5, 256 * 1024, 10]);
    expect(Object.keys(result)).not.toContain("private_key");
  });
  it("retries immutable specifications once with fresh proof; replay and changed label fail", async () => {
    const who = await identity(); const fixture = randomUUID(); const payload = await proof(who, fixture);
    expect((await provision(who.headers, payload)).statusCode).toBe(200);
    expect((await provision(who.headers, payload)).statusCode).toBe(403);
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(200);
    expect(service.logs.size).toBe(1);
    expect((await provision(who.headers, { ...await proof(who, fixture), label: "[test] changed-run" })).statusCode).toBe(409);
    expect((await db.query("SELECT 1 FROM next_policy_batches")).rows).toHaveLength(1);
  });
  it("refuses signature, action, key/connector, label and expired challenge substitutions", async () => {
    const who = await identity(); const fixture = randomUUID();
    const tampered = { ...await proof(who, fixture), fixture_id: randomUUID() };
    expect((await provision(who.headers, tampered)).statusCode).toBe(403);
    expect((await destroy(who.headers, await proof(who, fixture))).statusCode).toBe(403);
    const foreign = await identity();
    expect((await provision(foreign.headers, await proof(who, fixture))).statusCode).toBe(403);
    expect((await provision(who.headers, { ...await proof(who, fixture), label: "ordinary collection" })).statusCode).toBe(400);
    const expired = await proof(who, fixture);
    await db.query("UPDATE next_device_challenges SET expires_at = now() - interval '1 second' WHERE challenge = $1", [Buffer.from(expired.challenge, "hex")]);
    expect((await provision(who.headers, expired)).statusCode).toBe(403);
  });
  it("does not mint or adopt after unknown service outcomes; exact ownership remains retryable", async () => {
    const who = await identity(); const fixture = randomUUID(); service.unavailable = true;
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(503);
    expect((await db.query("SELECT 1 FROM next_lab_fixtures WHERE ready_at IS NULL")).rows).toHaveLength(1);
    service.unavailable = false;
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(200);
  });
  it("retains a not-ready reservation when external genesis differs", async () => {
    const who = await identity(); const fixture = randomUUID();
    const external = Buffer.from("unrelated genesis");
    service.logs.set(fixture.replaceAll("-", ""), external);
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(503);
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(503);
    expect(service.deleteCalls).toBe(0);
    expect(service.logs.get(fixture.replaceAll("-", ""))).toEqual(external);
    expect(service.quotas.size).toBe(0);
    expect((await db.query("SELECT 1 FROM next_collections")).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM next_lab_fixtures WHERE deleted_at IS NULL AND ready_at IS NULL")).rows).toHaveLength(1);
  });
  it("does not delete an unverified reservation when the external log is missing", async () => {
    const who = await identity(); const fixture = randomUUID(); service.unavailable = true;
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(503);
    service.unavailable = false;
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(503);
    expect(service.deleteCalls).toBe(0);
    expect((await db.query("SELECT 1 FROM next_lab_fixtures WHERE deleted_at IS NULL")).rows).toHaveLength(1);
  });
  it("verifies committed bytes after unknown creation and retains an unknown deletion for retry", async () => {
    const who = await identity(); const fixture = randomUUID(); service.failCreateAfterCommit = true;
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(503);
    expect((await db.query("SELECT state FROM next_policy_batches")).rows[0]!.state).toBe("sending");
    service.failCreateAfterCommit = false; service.failDeleteAfterCommit = true;
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(503);
    expect(service.deleteCalls).toBe(1); expect(service.logs.size).toBe(0);
    expect((await db.query("SELECT state FROM next_policy_batches")).rows[0]!.state).toBe("appended");
    expect((await db.query("SELECT 1 FROM next_lab_fixtures WHERE ready_at IS NULL AND deleted_at IS NULL")).rows).toHaveLength(1);
    service.failDeleteAfterCommit = false;
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(204);
    expect(service.deleteCalls).toBe(1); // Confirmed missing: no second privileged delete.
    expect((await db.query("SELECT 1 FROM next_collections")).rows).toHaveLength(0);
  });
  it("rechecks exact external ownership even for a previously ready fixture", async () => {
    const who = await identity(); const fixture = randomUUID();
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(200);
    const external = Buffer.from("different immutable genesis");
    service.logs.set(fixture.replaceAll("-", ""), external);
    service.quotas.clear();
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(503);
    expect(service.quotas.size).toBe(0);
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(503);
    expect(service.deleteCalls).toBe(0);
    expect(service.logs.get(fixture.replaceAll("-", ""))).toEqual(external);
  });
  it("canonicalizes fixture and device UUID text without changing proof bytes", async () => {
    const who = await identity(); const fixture = randomUUID();
    const body = { ...await proof(who, fixture.toUpperCase()), device_id: who.device.toUpperCase() };
    const response = await provision(who.headers, body);
    expect(response.statusCode).toBe(200);
    expect(response.json().fixture_id).toBe(fixture);
    expect(response.json().device.device_id).toBe(who.device);
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(200);
    expect((await destroy(who.headers, { ...await proof(who, fixture.toUpperCase(), "delete"), device_id: who.device.toUpperCase() })).statusCode).toBe(204);
  });
  it("serializes uppercase fixture deletion with canonical collection emission", async () => {
    const who = await identity(); const fixture = randomUUID();
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(200);
    const lock = await db.connect();
    let response: Awaited<ReturnType<typeof destroy>> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 20261004))", [fixture]);
      const deletion = destroy(who.headers, await proof(who, fixture.toUpperCase(), "delete")).then((value) => { response = value; return value; });
      await expect.poll(async () => (await db.query("SELECT 1 FROM next_lab_fixtures WHERE fixture_id = $1 AND deleting_at IS NOT NULL", [fixture])).rows.length).toBe(1);
      await expect.poll(async () => (await db.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
         AND classid = ((hashtextextended($1, 20261004) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended($1, 20261004) & 4294967295)::oid`, [fixture]
      )).rows.length).toBe(1);
      expect(response === undefined).toBe(true);
      expect(service.deleteCalls).toBe(0);
      // The holder is the emitter's collection-wide lock domain. Only its release
      // permits deletion; then the retained outbox and collection disappear together.
      await lock.query("COMMIT");
      expect((await deletion).statusCode).toBe(204);
      expect(service.logs.size).toBe(0);
      expect((await db.query("SELECT 1 FROM next_policy_batches")).rows).toHaveLength(0);
      expect(await emitter.drainCollection(fixture)).toBe(0);
      expect(service.logs.size).toBe(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  });
  it("bounds fixture quota and expired fixture renewal", async () => {
    const who = await identity(); const first = randomUUID();
    expect((await provision(who.headers, await proof(who, first))).statusCode).toBe(200);
    expect((await provision(who.headers, await proof(who, randomUUID()))).statusCode).toBe(200);
    expect((await provision(who.headers, await proof(who, randomUUID()))).statusCode).toBe(429);
    await db.query("UPDATE next_lab_fixtures SET expires_at = now() - interval '1 second' WHERE fixture_id = $1", [first]);
    expect((await provision(who.headers, await proof(who, first))).statusCode).toBe(409);
  });
  it("cleans up exact creator-owned fixtures, retains tombstones, and refuses unrelated objects", async () => {
    const who = await identity(); const fixture = randomUUID(); const other = await identity();
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(200);
    expect((await destroy(other.headers, await proof(other, fixture, "delete"))).statusCode).toBe(404);
    expect((await destroy(who.headers, await proof(who, randomUUID(), "delete"))).statusCode).toBe(404);
    service.unavailable = true;
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(503);
    expect((await db.query("SELECT 1 FROM next_collections")).rows).toHaveLength(1);
    service.unavailable = false;
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(204);
    expect(service.logs.size).toBe(0);
    expect((await db.query("SELECT 1 FROM next_collections")).rows).toHaveLength(0);
    expect((await destroy(who.headers, await proof(who, fixture, "delete"))).statusCode).toBe(204);
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(409);
  });
  it("never adopts an existing non-fixture collection", async () => {
    const who = await identity(); const fixture = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','private',$3)", [fixture, who.connector.user_id, Buffer.from(config.policyCert.root_key_id, "hex")]);
    expect((await provision(who.headers, await proof(who, fixture))).statusCode).toBe(409);
    expect((await db.query("SELECT 1 FROM next_lab_fixtures")).rows).toHaveLength(0);
  });
  it("refuses revoked connector and suspended-account provisioning", async () => {
    const who = await identity(); const body = await proof(who, randomUUID());
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [who.connector.user_id]);
    expect((await provision(who.headers, body)).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at = NULL WHERE id = $1", [who.connector.user_id]);
    await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [who.connector.id]);
    expect((await provision(who.headers, body)).statusCode).toBe(401);
  });
});
