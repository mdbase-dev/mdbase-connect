import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { LogServiceClient } from "./log-service-client.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, parseNextControlPlaneEnv, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, encodeCbor, keyId, type Cbor, type Decoded, type PolicyOp } from "./policy-wire.js";
import { privateCreateDigest, privateDeviceEnrolDigest, registerPrivateCollectionRoutes } from "./private-collections.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const field = (value: Decoded, key: number) => value instanceof Map ? value.get(key) : undefined;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);

describe("private bootstrap configuration", () => {
  const base = {
    MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_NEXT_ROOT_PUBLIC_KEY: "00".repeat(32), MDBASE_NEXT_POLICY_SIGNING_KEY: "pem", MDBASE_NEXT_POLICY_KEY_CERT: "{}",
    MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example", MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: "pem", MDBASE_NEXT_LOG_TRANSPORT_KEY: "pem"
  };
  it("is off by default, on with 1, and refuses anything else", () => {
    expect(parseNextControlPlaneEnv(base)?.privateBootstrap).toBeUndefined();
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "0" })?.privateBootstrap).toBeUndefined();
    expect(parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "1" })?.privateBootstrap).toBe(true);
    expect(() => parseNextControlPlaneEnv({ ...base, MDBASE_NEXT_PRIVATE_BOOTSTRAP: "yes" })).toThrow(/0 or 1/);
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

describePg("private collections", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const config = configuration();
  const log = new Log();
  const client = new LogServiceClient(config.logService, log.fetch);
  const app = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Private collection tests require dedicated local test Postgres.");
    schema = `private_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    const emitter = new PolicyEmitter(db, client, loadPolicySigner(config, Date.now()));
    await app.register(cookie);
    registerPrivateCollectionRoutes(app, { db, next: config, emitter, log: client });
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
  async function createProof(who: Who, collection: string) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const digest = privateCreateDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: who.device, collection });
    return { collection_id: collection, device_id: who.device, challenge, sig: hex(sign(null, digest, who.key)) };
  }
  async function enrolProof(who: Who, collection: string, commit: string) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const digest = privateDeviceEnrolDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: who.device, collection, sasCommit: Buffer.from(commit, "hex") });
    return { device_id: who.device, challenge, sig: hex(sign(null, digest, who.key)), sas_commit: commit };
  }
  const create = (who: Who, payload: unknown) => app.inject({ method: "POST", url: "/v1/next/collections/private", headers: who.headers, payload });
  const enrol = (who: Who, collection: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/v1/next/collections/${collection}/private/devices`, headers: who.headers, payload });
  const commit = () => hex(Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex"));
  const registered = async (collection: string) => (await db.query("SELECT 1 FROM next_collections WHERE collection_id = $1", [collection])).rows.length === 1;
  const drain = (collection: string) => new PolicyEmitter(db, client, loadPolicySigner(config, Date.now())).drainCollection(collection);
  /** Queue ops without appending them (pending). */
  const queue = async (collection: string, ops: PolicyOp[]) => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await queueNextPolicy(c, collection, ops);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  };
  const opsOf = (item: Buffer | Uint8Array) => field(decodeCbor(field(decodeCbor(Buffer.from(item)), 11) as Uint8Array), 3) as Decoded[];
  const created = async (who: Who) => {
    const collection = randomUUID();
    const response = await create(who, await createProof(who, collection));
    expect(response.statusCode, response.body).toBe(200);
    return collection;
  };

  it("creates an e2e genesis that enrols only the owner's device", async () => {
    const who = await identity(); const collection = randomUUID();
    const response = await create(who, await createProof(who, collection));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const result = response.json();
    expect(result).toMatchObject({ collection_id: collection, state: "private", owner_account: who.connector.user_id, head: { seq: 1 }, rekey_recipients: [who.device] });
    expect(result.service_devices).toBeUndefined();
    const ops = opsOf(Buffer.from(result.genesis.item, "hex"));
    expect(ops.map((op) => field(op, 0))).toEqual([1, 4, 2]);
    expect(field(ops[0]!, 3)).toBe(0); // e2e
    expect(hex(field(ops[2]!, 1) as Uint8Array)).toBe(who.device.replaceAll("-", ""));
    expect(field(ops[2]!, 3)).toBe(0); // desktop
    expect(field(ops[2]!, 7)).toBeUndefined(); // the creator needs no approval
    expect(result.genesis.item).toBe(hex(log.logs.get(collection.replaceAll("-", ""))![0]!));
    const claims = decodeCbor(Buffer.from(result.device.token.split(".")[0], "hex"));
    expect(hex(field(claims, 1) as Uint8Array)).toBe(who.device.replaceAll("-", ""));
    expect(hex(field(claims, 5) as Uint8Array)).toBe(collection.replaceAll("-", ""));
    const row = (await db.query("SELECT sync, runtime FROM next_collections WHERE collection_id = $1", [collection])).rows[0];
    expect(row).toEqual({ sync: "private", runtime: "next" });
  });

  it("answers a retry from the creating device with the same genesis", async () => {
    const who = await identity(); const collection = randomUUID();
    const first = (await create(who, await createProof(who, collection))).json();
    const again = await create(who, await createProof(who, collection));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().genesis).toEqual(first.genesis);
    expect(log.logs.get(collection.replaceAll("-", ""))!.length).toBe(1);
  });

  it("refuses other devices, other owners, cloud copies and collections that left sync", async () => {
    const who = await identity();
    const collection = await created(who);
    const sibling = await identity(who.connector.user_id);
    expect((await create(sibling, await createProof(sibling, collection))).json().error.code).toBe("collection_exists");
    const stranger = await identity();
    expect((await create(stranger, await createProof(stranger, collection))).json().error.code).toBe("collection_exists");
    const cloud = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [cloud, who.connector.user_id, Buffer.from(config.policyCert.root_key_id, "hex")]);
    expect((await create(who, await createProof(who, cloud))).json().error.code).toBe("collection_exists");
    await db.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [collection]);
    expect((await create(who, await createProof(who, collection))).statusCode).toBe(409);
  });

  it("needs a fresh proof under its own domain, and refuses nil identifiers", async () => {
    const who = await identity(); const collection = randomUUID();
    const payload = await createProof(who, collection);
    expect((await app.inject({ method: "POST", url: "/v1/next/collections/private", payload })).statusCode).toBe(401);
    expect((await create(who, { ...payload, collection_id: randomUUID() })).statusCode).toBe(403);
    expect((await create(who, payload)).statusCode).toBe(200);
    expect((await create(who, payload)).statusCode).toBe(403);
    // An enrolment proof never creates.
    const other = randomUUID();
    const e = await enrolProof(who, other, commit());
    expect((await create(who, { collection_id: other, device_id: e.device_id, challenge: e.challenge, sig: e.sig })).statusCode).toBe(403);
    expect(await registered(other)).toBe(false);
    const nil = "00000000-0000-0000-0000-000000000000";
    expect((await create(who, await createProof(who, nil))).statusCode).toBe(400);
  });

  it("registers nothing when the device is removed before the proof is checked", async () => {
    const who = await identity(); const collection = randomUUID();
    const payload = await createProof(who, collection);
    await db.query("DELETE FROM next_devices WHERE id = $1", [who.device]);
    expect((await create(who, payload)).statusCode).toBe(403);
    expect(await registered(collection)).toBe(false);
  });

  it("enrols the owner's second device with its SAS commitment, approval pending", async () => {
    const owner = await identity();
    const collection = await created(owner);
    const second = await identity(owner.connector.user_id);
    const sas = commit();
    const response = await enrol(second, collection, await enrolProof(second, collection, sas));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ collection_id: collection, enrolled_at: 2, approval: "pending", device: { device_id: second.device } });
    const items = log.logs.get(collection.replaceAll("-", ""))!;
    const [op] = opsOf(items[1]!);
    expect(field(op!, 0)).toBe(2);
    expect(hex(field(op!, 1) as Uint8Array)).toBe(second.device.replaceAll("-", ""));
    expect(hex(field(op!, 7) as Uint8Array)).toBe(sas);
    // The same device and commitment again: the same enrolment, nothing appended.
    const again = await enrol(second, collection, await enrolProof(second, collection, sas));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().enrolled_at).toBe(2);
    expect(items.length).toBe(2);
    // A different commitment is the device's own approval-request, never this route.
    expect((await enrol(second, collection, await enrolProof(second, collection, commit()))).json().error.code).toBe("device_enrolled_differently");
  });

  it("enrols another member account's device, and refuses non-members and removed members", async () => {
    const owner = await identity();
    const collection = await created(owner);
    const editor = await identity();
    expect((await enrol(editor, collection, await enrolProof(editor, collection, commit()))).json().error.code).toBe("not_member");
    await queue(collection, [{ op: "member-set", account: editor.connector.user_id, role: "editor" }]);
    expect((await enrol(editor, collection, await enrolProof(editor, collection, commit()))).json().error.code).toBe("not_member");
    await drain(collection);
    expect((await enrol(editor, collection, await enrolProof(editor, collection, commit()))).statusCode).toBe(200);
    const removed = await identity(editor.connector.user_id);
    await queue(collection, [{ op: "member-remove", account: editor.connector.user_id }]);
    expect((await enrol(removed, collection, await enrolProof(removed, collection, commit()))).json().error.code).toBe("not_member");
  });

  it("refuses revoked devices, cloud copies, collections that left sync and other proofs", async () => {
    const owner = await identity();
    const collection = await created(owner);
    const second = await identity(owner.connector.user_id);
    await queue(collection, [{ op: "device-revoke", device: second.device }]);
    expect((await enrol(second, collection, await enrolProof(second, collection, commit()))).json().error.code).toBe("device_revoked");

    const cloud = randomUUID();
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      await registerNextCollection(c, {
        collectionId: cloud, ownerUserId: owner.connector.user_id, runtime: "next", sync: "cloud_copy", rootKeyId: Buffer.from(config.policyCert.root_key_id, "hex"),
        ops: [{ op: "genesis", owner: owner.connector.user_id, root: Buffer.from(config.policyCert.root_key_id, "hex"), state: "cloud-copy" }, { op: "member-set", account: owner.connector.user_id, role: "owner" }]
      });
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const third = await identity(owner.connector.user_id);
    expect((await enrol(third, cloud, await enrolProof(third, cloud, commit()))).json().error.code).toBe("not_current_private");

    const create2 = await created(owner);
    const p = await createProof(third, create2);
    expect((await enrol(third, create2, { device_id: p.device_id, challenge: p.challenge, sig: p.sig, sas_commit: commit() })).json().error.code).toBe("invalid_proof");
    const sas = commit();
    const proofed = await enrolProof(third, create2, sas);
    expect((await enrol(third, create2, { ...proofed, sas_commit: commit() })).json().error.code).toBe("invalid_proof");
    await db.query("UPDATE next_collections SET runtime = 'shadow' WHERE collection_id = $1", [create2]);
    expect((await enrol(third, create2, await enrolProof(third, create2, sas))).json().error.code).toBe("not_current_private");
    expect((await create(owner, await createProof(owner, create2))).json().error.code).toBe("collection_exists");
    await db.query("UPDATE next_collections SET runtime = 'next' WHERE collection_id = $1", [create2]);
    await db.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [create2]);
    expect((await enrol(third, create2, await enrolProof(third, create2, sas))).json().error.code).toBe("not_current_private");
  });
});
