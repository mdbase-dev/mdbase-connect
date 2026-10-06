import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import {
  accountKeyDeviceDigest, accountKeyEnrolDigest, accountKeyFetchDigest, accountKeyPutDigest, accountKeyRewrapDigest, accountKeyStrictDigest,
  checkBundleShape, recoveryDeviceId, registerAccountKeyRoutes
} from "./account-keys.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { LogServiceClient } from "./log-service-client.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, encodeCbor, keyId, type Cbor, type Decoded } from "./policy-wire.js";
import { privateCreateDigest, registerPrivateCollectionRoutes } from "./private-collections.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const field = (value: Decoded, key: number) => value instanceof Map ? value.get(key) : undefined;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
/** `accountKeyRewrapDigest` of the fixed inputs above; the Rust test pins the same value. */
const REWRAP_VECTOR = "74681c1a46f7d3aefc16a5ad665cc61da891bfcbfba11f02b713831a238f5155";
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);

/** A well-formed AK1 v1 bundle for `keyId` (the server checks shape only). */
function bundleFor(keyIdBytes: Buffer): Buffer {
  return Buffer.from(encodeCbor({ struct: [
    [0, 1], [1, [1, 19456, 3, 1, randomBytes(16)]], [2, randomBytes(24)], [3, randomBytes(48)], [4, keyIdBytes]
  ] } as Cbor));
}

describe("account key bundle shape", () => {
  it("accepts exactly the closed v1 shape for its key id", () => {
    const id = randomBytes(32);
    expect(checkBundleShape(bundleFor(id), id)).toBe(true);
    expect(checkBundleShape(bundleFor(id), randomBytes(32))).toBe(false);
    expect(checkBundleShape(Buffer.alloc(513), id)).toBe(false);
    expect(checkBundleShape(Buffer.from(encodeCbor({ struct: [[0, 2]] } as Cbor)), id)).toBe(false);
  });
  it("pins the rewrap digest the replica signs", () => {
    const d = accountKeyRewrapDigest({ account: "33333333-3333-4333-8333-333333333333", bundle: Buffer.alloc(100, 6), expectedVersion: 3 });
    expect(hex(d)).toBe(REWRAP_VECTOR);
  });
  it("derives recovery device IDs as the replica does", () => {
    const collection = "4c18af2e-b04a-4b77-b83e-493c3695962e";
    const pk = Buffer.alloc(32, 7);
    const tag = Buffer.from("mdbase/v1/recovery-id");
    const h = createHash("sha256").update(Uint8Array.of(tag.length)).update(tag).update(Buffer.from(collection.replaceAll("-", ""), "hex")).update(pk).digest("hex");
    expect(recoveryDeviceId(collection, pk).replaceAll("-", "")).toBe(h.slice(0, 32));
  });
});

function configuration(): NextControlPlaneConfig {
  const root = generateKeyPairSync("ed25519").privateKey;
  const policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  const pem = (key: typeof root) => key.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }),
    serviceTokens: {}, privateBootstrap: true,
    logService: { url: "http://log.test", tokenIssuerKeyPem: pem(generateKeyPairSync("ed25519").privateKey), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }
  };
}

/** The log service: control items per collection, with create, append, head and read. */
class Log {
  readonly logs = new Map<string, Buffer[]>();
  /** Runs once, while the route awaits a read-back. */
  onRead: (() => Promise<void>) | undefined;
  readonly fetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/nonce")) return new Response("ab".repeat(32));
    const frame = decodeCbor(Buffer.from(init!.body as Uint8Array));
    const method = field(frame, 2);
    const params = field(frame, 3)!;
    const id = hex(field(params, 0) as Uint8Array);
    const items = this.logs.get(id);
    const chain = () => chainHash(items![items!.length - 1]!);
    let result: Cbor;
    if (method === "create_log") {
      if (!items) this.logs.set(id, [Buffer.from(field(params, 1) as Uint8Array)]);
      result = { struct: [[0, 1], [1, chainHash(this.logs.get(id)![0]!)]] };
    } else if (method === "head") {
      result = { struct: [[0, items!.length], [1, chain()], [2, 1]] };
    } else if (method === "append") {
      const expect = field(params, 1) as number;
      const prev = Buffer.from(field(params, 2) as Uint8Array);
      if (expect !== items!.length + 1 || !prev.equals(Buffer.from(chain()))) {
        result = { struct: [[0, 1], [1, items!.length], [2, chain()]] };
      } else {
        const added = (field(params, 3) as Uint8Array[]).map((b) => Buffer.from(b));
        items!.push(...added);
        result = { struct: [[0, 0], [1, expect], [2, items!.length]] };
      }
    } else if (method === "read") {
      const hook = this.onRead;
      this.onRead = undefined;
      await hook?.();
      if (!items) return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [3, { struct: [[0, "not_found"]] }]] }));
      const after = field(params, 1) as number;
      const limit = field(params, 2) as number;
      result = { struct: [[0, items.slice(after, after + limit).map((item, i) => [after + i + 1, item])]] };
    } else throw new Error("unexpected log operation");
    return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [2, result]] }), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  };
}

describePg("account keys", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const config = configuration();
  const log = new Log();
  const client = new LogServiceClient(config.logService, log.fetch);
  const app = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Account key tests require dedicated local test Postgres.");
    schema = `account_keys_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    const emitter = new PolicyEmitter(db, client, loadPolicySigner(config, Date.now()));
    await app.register(cookie);
    registerPrivateCollectionRoutes(app, { db, next: config, emitter, log: client });
    registerAccountKeyRoutes(app, { db, next: config, emitter, log: client, rateLimitSecret: "account-key-test-rate-limit-secret-32-bytes" });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  const proofKeys = new Map<string, ReturnType<typeof generateKeyPairSync>["privateKey"]>();
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
    // The account's proof key (derived from R by clients); one per account here.
    const proof = proofKeys.get(user) ?? generateKeyPairSync("ed25519").privateKey;
    proofKeys.set(user, proof);
    return { connector, device, key, proof, headers: { authorization: `Bearer ${token}` } };
  }
  type Who = Awaited<ReturnType<typeof identity>>;
  const challenge = async (who: Who) => (await issueDeviceChallenge(db, who.connector.id)).challenge;

  async function fetchKey(who: Who) {
    const c = await challenge(who);
    const sig = hex(sign(null, accountKeyFetchDigest({ challenge: Buffer.from(c, "hex"), connector: who.connector.id, device: who.device, account: who.connector.user_id }), who.key));
    return app.inject({ method: "GET", url: "/v1/next/account-key", headers: { ...who.headers, "x-mdbase-device-id": who.device, "x-mdbase-challenge": c, "x-mdbase-signature": sig } });
  }
  async function put(who: Who, expected: number, id: Buffer, bundle = bundleFor(id), opts: { proof?: "none" | "wrong" } = {}) {
    const c = await challenge(who);
    const sig = hex(sign(null, accountKeyPutDigest({
      challenge: Buffer.from(c, "hex"), connector: who.connector.id, device: who.device, account: who.connector.user_id, expectedVersion: expected, keyId: id, bundle
    }), who.key));
    const signer = opts.proof === "wrong" ? generateKeyPairSync("ed25519").privateKey : who.proof;
    const proof_sig = hex(sign(null, accountKeyRewrapDigest({ account: who.connector.user_id, bundle, expectedVersion: expected }), signer));
    return app.inject({ method: "PUT", url: "/v1/next/account-key", headers: who.headers, payload: {
      device_id: who.device, challenge: c, sig, expected_version: expected, key_id: hex(id), bundle: hex(bundle),
      proof_pk: hex(ed25519RawPublicKey(who.proof)), ...(opts.proof === "none" ? {} : { proof_sig })
    } });
  }
  async function strict(who: Who, expected: number) {
    const c = await challenge(who);
    const sig = hex(sign(null, accountKeyStrictDigest({
      challenge: Buffer.from(c, "hex"), connector: who.connector.id, device: who.device, account: who.connector.user_id, expectedVersion: expected
    }), who.key));
    return app.inject({ method: "POST", url: "/v1/next/account-key/strict", headers: who.headers, payload: { device_id: who.device, challenge: c, sig, expected_version: expected } });
  }
  async function createPrivate(who: Who) {
    const collection = randomUUID();
    const c = await challenge(who);
    const digest = privateCreateDigest({ challenge: Buffer.from(c, "hex"), connector: who.connector.id, device: who.device, collection });
    const res = await app.inject({ method: "POST", url: "/v1/next/collections/private", headers: who.headers, payload: {
      collection_id: collection, device_id: who.device, challenge: c, sig: hex(sign(null, digest, who.key))
    } });
    expect(res.statusCode, res.body).toBe(200);
    return collection;
  }
  async function enrolRecovery(who: Who, collection: string, opts: { badPop?: boolean; wrongId?: boolean } = {}) {
    const rkey = generateKeyPairSync("ed25519").privateKey;
    const signPk = ed25519RawPublicKey(rkey);
    const kemPk = rawX();
    const recovery = opts.wrongId ? randomUUID() : recoveryDeviceId(collection, signPk);
    const c = await challenge(who);
    const ch = Buffer.from(c, "hex");
    const sig = hex(sign(null, accountKeyDeviceDigest({ challenge: ch, connector: who.connector.id, device: who.device, collection, recoveryDevice: recovery, signPk, kemPk }), who.key));
    const popKey = opts.badPop ? generateKeyPairSync("ed25519").privateKey : rkey;
    const pop = hex(sign(null, accountKeyEnrolDigest({ challenge: ch, collection, recoveryDevice: recovery, account: who.connector.user_id, signPk, kemPk }), popKey));
    const res = await app.inject({ method: "POST", url: `/v1/next/collections/${collection}/private/account-key-device`, headers: who.headers, payload: {
      device_id: who.device, challenge: c, sig, recovery_device: recovery, sign_pk: hex(signPk), kem_pk: hex(kemPk), pop
    } });
    return { res, recovery, signPk, kemPk };
  }
  const opsOf = (item: Buffer | Uint8Array) => field(decodeCbor(field(decodeCbor(Buffer.from(item)), 11) as Uint8Array), 3) as Decoded[];
  const lastOps = (collection: string) => {
    const items = log.logs.get(collection.replaceAll("-", ""))!;
    return opsOf(items[items.length - 1]!);
  };

  it("stores, re-wraps and returns the bundle; rotation needs strict first", async () => {
    const who = await identity();
    expect((await fetchKey(who)).json()).toEqual({ mode: "none", version: 0 });
    const id = randomBytes(32);
    const first = await put(who, 0, id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const bundle = bundleFor(id);
    expect((await put(who, 1, id, bundle)).json()).toMatchObject({ mode: "password", version: 2 });
    const got = (await fetchKey(who)).json();
    expect(got).toEqual({ mode: "password", version: 2, key_id: hex(id), bundle: hex(bundle) });
    expect((await put(who, 1, id)).json().error.code).toBe("version_conflict");
    // Replacing a bundle needs proof of R, not only a signed-in device.
    expect((await put(who, 2, id, bundleFor(id), { proof: "none" })).json().error.code).toBe("account_key_proof_required");
    expect((await put(who, 2, id, bundleFor(id), { proof: "wrong" })).json().error.code).toBe("account_key_proof_required");
    expect((await put(who, 2, randomBytes(32))).json().error.code).toBe("rotate_requires_strict");
    expect((await put(who, 2, id, Buffer.alloc(40))).statusCode).toBe(400);
    // Another account sees nothing of it.
    expect((await fetchKey(await identity())).json()).toEqual({ mode: "none", version: 0 });
  });

  it("serializes concurrent first writes: exactly one creates, none overwrites", async () => {
    const who = await identity();
    const sibling = await identity(who.connector.user_id);
    const [a, b] = [randomBytes(32), randomBytes(32)];
    const results = await Promise.all([put(who, 0, a), put(sibling, 0, b)]);
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok.length, results.map((r) => r.body).join(" | ")).toBe(1);
    expect(results.find((r) => r.statusCode !== 200)!.json().error.code).toBe("version_conflict");
    const winner = ok[0]!.json().key_id;
    expect((await fetchKey(who)).json().key_id).toBe(winner);
  });

  it("needs a fresh device proof bound to the request", async () => {
    const who = await identity();
    const c = await challenge(who);
    const res = await app.inject({ method: "GET", url: "/v1/next/account-key", headers: who.headers });
    expect(res.statusCode).toBe(400);
    const wrong = hex(sign(null, accountKeyFetchDigest({ challenge: Buffer.from(c, "hex"), connector: who.connector.id, device: who.device, account: randomUUID() }), who.key));
    const bad = await app.inject({ method: "GET", url: "/v1/next/account-key", headers: { ...who.headers, "x-mdbase-device-id": who.device, "x-mdbase-challenge": c, "x-mdbase-signature": wrong } });
    expect(bad.statusCode).toBe(403);
    // A put proof for one bundle does not store another.
    const id = randomBytes(32);
    const c2 = await challenge(who);
    const sig = hex(sign(null, accountKeyPutDigest({
      challenge: Buffer.from(c2, "hex"), connector: who.connector.id, device: who.device, account: who.connector.user_id, expectedVersion: 0, keyId: id, bundle: bundleFor(id)
    }), who.key));
    const swapped = await app.inject({ method: "PUT", url: "/v1/next/account-key", headers: who.headers, payload: {
      device_id: who.device, challenge: c2, sig, expected_version: 0, key_id: hex(id), bundle: hex(bundleFor(id)),
      proof_pk: hex(ed25519RawPublicKey(who.proof))
    } });
    expect(swapped.statusCode).toBe(403);
  });

  it("serves status without the bundle and without spending the fetch budget", async () => {
    const who = await identity();
    const id = randomBytes(32);
    await put(who, 0, id);
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/next/account-key/status", headers: who.headers });
      expect(res.json()).toEqual({ mode: "password", version: 1, key_id: hex(id) });
    }
    expect((await fetchKey(who)).statusCode).toBe(200);
  });

  it("rate-limits fetches per account across devices", async () => {
    const who = await identity();
    const sibling = await identity(who.connector.user_id);
    for (let i = 0; i < 10; i++) expect((await fetchKey(i % 2 ? who : sibling)).statusCode).toBe(200);
    const blocked = await fetchKey(who);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await fetchKey(await identity())).statusCode).toBe(200);
  });

  it("enrols the account's recovery device for a private collection, with possession of its key", async () => {
    const who = await identity();
    const collection = await createPrivate(who);
    expect((await enrolRecovery(who, collection)).res.json().error.code).toBe("no_account_key");
    await put(who, 0, randomBytes(32));
    expect((await enrolRecovery(who, collection, { wrongId: true })).res.statusCode).toBe(400);
    expect((await enrolRecovery(who, collection, { badPop: true })).res.statusCode).toBe(403);
    const ok = await enrolRecovery(who, collection);
    expect(ok.res.statusCode, ok.res.body).toBe(200);
    expect(ok.res.json()).toMatchObject({ collection_id: collection, device_id: ok.recovery });
    const [op] = lastOps(collection);
    expect(field(op!, 0)).toBe(2); // device-enrol
    expect(hex(field(op!, 1) as Uint8Array)).toBe(ok.recovery.replaceAll("-", ""));
    expect(hex(field(op!, 2) as Uint8Array)).toBe(who.connector.user_id.replaceAll("-", ""));
    expect(field(op!, 3)).toBe(6); // recovery
    expect(hex(field(op!, 5) as Uint8Array)).toBe(hex(ok.kemPk));
    expect(hex(field(op!, 6) as Uint8Array)).toBe("00".repeat(32));
    // Another account's device may not enrol into this account's collection.
    const stranger = await identity();
    await put(stranger, 0, randomBytes(32));
    expect((await enrolRecovery(stranger, collection)).res.json().error.code).toBe("not_member");
  });

  it("strict mode drops the bundle, revokes the account's recovery devices and refuses new ones", async () => {
    const who = await identity();
    const collection = await createPrivate(who);
    await put(who, 0, randomBytes(32));
    const { recovery } = await enrolRecovery(who, collection);
    const res = await strict(who, 1);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ mode: "strict", version: 2, revocations: [{ collection_id: collection, device_id: recovery }] });
    const [op] = lastOps(collection);
    expect(field(op!, 0)).toBe(3); // device-revoke
    expect(hex(field(op!, 1) as Uint8Array)).toBe(recovery.replaceAll("-", ""));
    expect((await fetchKey(who)).json()).toEqual({ mode: "strict", version: 2 });
    expect((await enrolRecovery(who, collection)).res.json().error.code).toBe("strict_mode");
    // Leaving strict mode is setup again, with a new key.
    expect((await put(who, 2, randomBytes(32))).json()).toMatchObject({ mode: "password", version: 3 });
    expect((await strict(who, 2)).json().error.code).toBe("version_conflict");
  });
});
