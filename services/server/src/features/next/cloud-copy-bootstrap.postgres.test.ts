import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { cloudCopyCreateDigest, registerCloudCopyRoutes } from "./cloud-copy-bootstrap.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { collectionDirectory } from "./hosted-routes.js";
import { LogServiceClient } from "./log-service-client.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, parseNextControlPlaneEnv, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, encodeCbor, keyId, type Cbor, type Decoded } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const field = (value: Decoded, key: number) => value instanceof Map ? value.get(key) : undefined;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const ZERO_ACCOUNT = "00".repeat(16);
const tokens = { hosted: "h".repeat(40), escrow: "e".repeat(40), hostedOut: "H".repeat(40), escrowOut: "E".repeat(40) };

describe("cloud-copy bootstrap configuration", () => {
  const base = {
    MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
    MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem",
    MDBASE_NEXT_HOSTED_INTERNAL_TOKEN: tokens.hosted, MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: tokens.escrow
  };
  const on = {
    ...base, MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "1",
    MDBASE_NEXT_HOSTED_SERVICE_URL: "https://hosted.example", MDBASE_NEXT_HOSTED_SERVICE_TOKEN: tokens.hostedOut,
    MDBASE_NEXT_ESCROW_SERVICE_URL: "https://escrow.example", MDBASE_NEXT_ESCROW_SERVICE_TOKEN: tokens.escrowOut
  };
  it("is off by default and complete when on", () => {
    expect(parseNextControlPlaneEnv(base)?.cloudCopyBootstrap).toBeUndefined();
    expect(parseNextControlPlaneEnv(on)?.cloudCopyBootstrap).toEqual({
      hosted: { url: "https://hosted.example", token: tokens.hostedOut }, escrow: { url: "https://escrow.example", token: tokens.escrowOut }
    });
  });
  it("refuses partial, insecure or shared-token configuration", () => {
    expect(() => parseNextControlPlaneEnv({ ...on, MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP: "yes" })).toThrow(/0 or 1/);
    expect(() => parseNextControlPlaneEnv({ ...on, MDBASE_NEXT_ESCROW_SERVICE_URL: "" })).toThrow(/ESCROW_SERVICE_URL/);
    expect(() => parseNextControlPlaneEnv({ ...on, MDBASE_NEXT_HOSTED_SERVICE_URL: "http://hosted.example" })).toThrow(/https/);
    expect(() => parseNextControlPlaneEnv({ ...on, MDBASE_NEXT_HOSTED_SERVICE_TOKEN: tokens.hosted })).toThrow(/all differ/);
    expect(() => parseNextControlPlaneEnv({ ...on, MDBASE_NEXT_ESCROW_SERVICE_TOKEN: tokens.hostedOut })).toThrow(/all differ/);
    expect(() => parseNextControlPlaneEnv({ ...on, MDBASE_NEXT_ESCROW_INTERNAL_TOKEN: "" })).toThrow(/INTERNAL_TOKEN/);
  });
});

function configuration(): NextControlPlaneConfig {
  const root = generateKeyPairSync("ed25519").privateKey;
  const policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  const pem = (key: typeof root) => key.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }),
    serviceTokens: { hosted: tokens.hosted, escrow: tokens.escrow },
    cloudCopyBootstrap: { hosted: { url: "https://hosted.test", token: tokens.hostedOut }, escrow: { url: "https://escrow.test", token: tokens.escrowOut } },
    logService: { url: "http://log.test", tokenIssuerKeyPem: pem(generateKeyPairSync("ed25519").privateKey), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }
  };
}

/** The log service, holding genesis only. */
class Log {
  readonly logs = new Map<string, Buffer>();
  readonly fetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/nonce")) return new Response("ab".repeat(32));
    const frame = decodeCbor(Buffer.from(init!.body as Uint8Array));
    const method = field(frame, 2);
    const params = field(frame, 3)!;
    const id = hex(field(params, 0) as Uint8Array);
    let result: Cbor;
    if (method === "create_log") {
      this.logs.set(id, Buffer.from(field(params, 1) as Uint8Array));
      result = { struct: [[0, 1], [1, chainHash(this.logs.get(id)!)]] };
    } else if (method === "head") {
      result = { struct: [[0, 1], [1, chainHash(this.logs.get(id)!)], [2, 1]] };
    } else if (method === "read") {
      const genesis = this.logs.get(id);
      if (!genesis) return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [3, { struct: [[0, "not_found"]] }]] }));
      result = { struct: [[0, [[1, genesis]]]] };
    } else throw new Error("unexpected log operation");
    return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [2, result]] }), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  };
}

/** Both deployments: one device per collection and kind, returned again on retry. */
class Deployments {
  readonly devices = new Map<string, Record<string, string>>();
  calls = 0;
  failing: "down" | "wrong-kind" | undefined;
  readonly fetch: typeof fetch = async (input, init) => {
    this.calls += 1;
    const url = new URL(String(input));
    const kind = url.hostname === "hosted.test" ? "hosted" : "escrow";
    expect(url.pathname).toBe("/internal/v1/service-devices");
    expect(new Headers(init!.headers).get("authorization")).toBe(`Bearer ${kind === "hosted" ? tokens.hostedOut : tokens.escrowOut}`);
    if (this.failing === "down") throw new TypeError("unavailable");
    const { collection } = JSON.parse(String(init!.body)) as { collection: string };
    const key = `${kind}/${collection}`;
    if (!this.devices.has(key)) {
      this.devices.set(key, {
        kind, device_id: randomUUID(), sign_pk: hex(ed25519RawPublicKey(generateKeyPairSync("ed25519").privateKey)), kem_pk: hex(rawX()),
        noise_pk: kind === "escrow" ? "00".repeat(32) : hex(rawX()), wrapped_keys: Buffer.from(`sealed ${key}`).toString("base64"),
        kms_key_arn: `arn:aws:kms:eu-west-1:000000000000:key/${kind}`
      });
    }
    const device = this.devices.get(key)!;
    return new Response(JSON.stringify(this.failing === "wrong-kind" ? { ...device, kind: kind === "hosted" ? "escrow" : "hosted" } : device));
  };
}

describePg("cloud-copy bootstrap", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const config = configuration();
  const log = new Log();
  const deployments = new Deployments();
  const client = new LogServiceClient(config.logService, log.fetch);
  const app = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Bootstrap tests require dedicated local test Postgres.");
    schema = `cloud_copy_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    const emitter = new PolicyEmitter(db, client, loadPolicySigner(config, Date.now()));
    registerCloudCopyRoutes(app, { db, next: config, emitter, log: client, fetchImpl: deployments.fetch });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function identity(user = randomUUID()) {
    const connector = { id: randomUUID(), user_id: user };
    const token = randomUUID();
    const device = randomUUID();
    const key = generateKeyPairSync("ed25519").privateKey;
    const signPk = ed25519RawPublicKey(key);
    const kemPk = rawX(); const noisePk = rawX();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner') ON CONFLICT DO NOTHING", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Daemon',$3)", [connector.id, user, tokenHash(token)]);
    const registration = await issueDeviceChallenge(db, connector.id);
    await registerDevice(db, connector, {
      device_id: device, kind: "desktop", sign_pk: hex(signPk), kem_pk: hex(kemPk), noise_pk: hex(noisePk), challenge: registration.challenge,
      sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(registration.challenge, "hex"), connectorId: connector.id, deviceId: device, signPk, kemPk, noisePk }), key))
    });
    return { connector, device, key, signPk, headers: { authorization: `Bearer ${token}` } };
  }
  type Who = Awaited<ReturnType<typeof identity>>;
  async function proof(who: Who, collection: string) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const digest = cloudCopyCreateDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: who.device, collection });
    return { collection_id: collection, device_id: who.device, challenge, sig: hex(sign(null, digest, who.key)) };
  }
  const create = (who: Who, payload: unknown) => app.inject({ method: "POST", url: "/v1/next/collections/cloud-copy", headers: who.headers, payload });
  const registered = async (collection: string) => (await db.query("SELECT 1 FROM next_collections WHERE collection_id = $1", [collection])).rows.length === 1;

  it("enrols the owner's device and both service devices in a cloud-copy genesis", async () => {
    const who = await identity(); const collection = randomUUID();
    const response = await create(who, await proof(who, collection));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const result = response.json();
    expect(result).toMatchObject({ collection_id: collection, state: "cloud-copy", owner_account: who.connector.user_id, head: { seq: 1 } });
    const hosted = deployments.devices.get(`hosted/${collection}`)!;
    const escrow = deployments.devices.get(`escrow/${collection}`)!;
    expect(result.rekey_recipients).toEqual([who.device, hosted.device_id, escrow.device_id]);
    expect(result.service_devices).toEqual([hosted, escrow].map(({ wrapped_keys: _w, kms_key_arn: _k, ...visible }) => visible));
    expect(response.body).not.toContain(hosted.wrapped_keys);

    const payload = decodeCbor(field(decodeCbor(Buffer.from(result.genesis.item, "hex")), 11) as Uint8Array);
    const ops = field(payload, 3) as Decoded[];
    expect(ops.map((op) => field(op, 0))).toEqual([1, 4, 2, 2, 2]);
    expect(field(ops[0]!, 3)).toBe(1); // cloud-copy
    const enrols = ops.slice(2).map((op) => ({ device: hex(field(op, 1) as Uint8Array), account: hex(field(op, 2) as Uint8Array), kind: field(op, 3), sign: hex(field(op, 4) as Uint8Array), noise: hex(field(op, 6) as Uint8Array) }));
    expect(enrols).toEqual([
      { device: who.device.replaceAll("-", ""), account: who.connector.user_id.replaceAll("-", ""), kind: 0, sign: hex(who.signPk), noise: expect.any(String) },
      { device: hosted.device_id!.replaceAll("-", ""), account: ZERO_ACCOUNT, kind: 4, sign: hosted.sign_pk, noise: hosted.noise_pk },
      { device: escrow.device_id!.replaceAll("-", ""), account: ZERO_ACCOUNT, kind: 5, sign: escrow.sign_pk, noise: "00".repeat(32) }
    ]);
    const claims = decodeCbor(Buffer.from(result.device.token.split(".")[0], "hex"));
    expect(field(claims, 0)).toBe(0);
    expect(hex(field(claims, 1) as Uint8Array)).toBe(who.device.replaceAll("-", ""));
    expect(hex(field(claims, 5) as Uint8Array)).toBe(collection.replaceAll("-", ""));
    expect((await collectionDirectory(db, [collection]))[0]!.state).toBe("standard");
    const stored = await db.query<{ kind: string; wrapped_keys: Buffer }>("SELECT kind, wrapped_keys FROM next_service_devices WHERE collection_id = $1 ORDER BY kind", [collection]);
    expect(stored.rows.map((row) => [row.kind, row.wrapped_keys.toString("base64")])).toEqual([["escrow", escrow.wrapped_keys], ["hosted", hosted.wrapped_keys]]);
  });

  it("answers a retry from the enrolled device without generating again", async () => {
    const who = await identity(); const collection = randomUUID();
    const first = (await create(who, await proof(who, collection))).json();
    const calls = deployments.calls;
    const again = await create(who, await proof(who, collection));
    expect(again.statusCode, again.body).toBe(200);
    expect(deployments.calls).toBe(calls);
    expect(again.json().service_devices).toEqual(first.service_devices);
    expect(again.json().genesis).toEqual(first.genesis);
  });

  it("refuses other devices, other owners and existing private collections", async () => {
    const who = await identity(); const collection = randomUUID();
    expect((await create(who, await proof(who, collection))).statusCode).toBe(200);
    const sibling = await identity(who.connector.user_id);
    expect((await create(sibling, await proof(sibling, collection))).statusCode).toBe(409);
    const stranger = await identity();
    expect((await create(stranger, await proof(stranger, collection))).statusCode).toBe(409);
    const priv = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next','private',$3)", [priv, who.connector.user_id, Buffer.from(config.policyCert.root_key_id, "hex")]);
    const calls = deployments.calls;
    expect((await create(who, await proof(who, priv))).statusCode).toBe(409);
    expect(deployments.calls).toBe(calls);
  });

  it("refuses a local collection that belongs to someone else", async () => {
    const owner = await identity(); const who = await identity(); const collection = randomUUID();
    await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$2,$3,$4,'Theirs','0.3.0')`,
      [randomUUID(), owner.connector.user_id, owner.connector.id, collection]);
    expect((await create(who, await proof(who, collection))).statusCode).toBe(409);
    expect(await registered(collection)).toBe(false);
  });

  it("needs a fresh signed proof", async () => {
    const who = await identity(); const collection = randomUUID();
    const payload = await proof(who, collection);
    expect((await app.inject({ method: "POST", url: "/v1/next/collections/cloud-copy", payload })).statusCode).toBe(401);
    expect((await create(who, { ...payload, collection_id: randomUUID() })).statusCode).toBe(403);
    expect((await create(who, { ...payload, sig: "00" })).statusCode).toBe(400);
    expect((await create(who, payload)).statusCode).toBe(200);
    expect((await create(who, payload)).statusCode).toBe(403);
  });

  it("registers nothing when a deployment fails, and a later retry succeeds", async () => {
    const who = await identity(); const collection = randomUUID();
    for (const failing of ["down", "wrong-kind"] as const) {
      deployments.failing = failing;
      const response = await create(who, await proof(who, collection));
      expect(response.statusCode).toBe(503);
      expect(await registered(collection)).toBe(false);
    }
    deployments.failing = undefined;
    expect((await create(who, await proof(who, collection))).statusCode).toBe(200);
  });
});
