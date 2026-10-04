import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { tokenHash } from "../../security.js";
import { recoverLostPolicy } from "./policy-recovery.js";
import { registerPolicyRecoveryRoutes } from "./policy-recovery-routes.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { LogServiceClient } from "./log-service-client.js";
import { PolicyEmitter, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, domainHash, encodeCbor, keyId, policyItemSignedDigest, type Cbor, type Decoded, type PolicyOp, type PolicySigner } from "./policy-wire.js";
import { ed25519PublicKeyObject, ed25519RawPublicKey } from "./policy-keys.js";

// Only an explicitly approved, local disposable database is accepted. The suite
// creates and drops its own schema.
const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
// Optional interop run against mdbase-next's `logsvc --testkit-cp <label>`.
const logServiceUrl = process.env.MDBASE_NEXT_TEST_LOG_SERVICE_URL;
const logServiceLabel = process.env.MDBASE_NEXT_TEST_LOG_SERVICE_TESTKIT ?? "conformance";
const describeInterop = testUrl && approved && logServiceUrl ? describe : describe.skip;

const pem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();
const seededKey = (label: string) => createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(label).digest()]),
  format: "der",
  type: "pkcs8",
});

function certify(root: KeyObject, policy: KeyObject, now: number): PolicySigner {
  const unsigned = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: now - 60_000, notAfter: now + 90 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  return { cert: { ...unsigned, signature: sign(null, certDigest(unsigned), root) }, privateKey: policy };
}

const field = (value: Decoded | undefined, key: number) => (value instanceof Map ? value.get(key) : undefined);
const bytes = (value: Decoded | undefined) => Buffer.from(value as Uint8Array);

/**
 * A log service holding the contract's append rules (log-service-api.md §4.1: idempotent
 * replay, conditional head, policy signatures) and checking the client's token and
 * proof of possession. `dropNextResponse` commits but loses the response.
 */
class FakeLogService {
  readonly logs = new Map<string, Buffer[]>();
  dropNextResponse = false;
  refuseNextAppend = false;
  failNextRead = false;
  constructor(private readonly issuer: Uint8Array) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/nonce") return new Response("ab".repeat(32));
    const body = Buffer.from(init!.body as Uint8Array);
    const headers = new Headers(init!.headers);
    const [claimsHex, sigHex] = headers.get("authorization")!.replace("Bearer ", "").split(".");
    const claims = Buffer.from(claimsHex!, "hex");
    expect(verify(null, domainHash("mdbase/v1/ls-token", claims), ed25519PublicKeyObject(this.issuer), Buffer.from(sigHex!, "hex"))).toBe(true);
    const frame = decodeCbor(body);
    const method = field(frame, 2) as string;
    const possession = domainHash("mdbase/v1/item-sig", Buffer.concat([Buffer.from("ls-http"), Buffer.from(headers.get("x-mdbase-nonce")!, "hex"), Buffer.from(method), Buffer.of(0), createHash("sha256").update(body).digest()]));
    expect(verify(null, possession, ed25519PublicKeyObject(bytes(field(decodeCbor(claims), 2))), Buffer.from(headers.get("x-mdbase-sig")!, "hex"))).toBe(true);
    const params = field(frame, 3);
    const collection = bytes(field(params, 0)).toString("hex");
    const log = this.logs.get(collection);
    const head = () => ({ seq: log?.length ?? 0, chain: log?.length ? chainHash(log[log.length - 1]!) : new Uint8Array(32) });
    const st = (...fields: Array<readonly [number, Cbor]>): Cbor => ({ struct: fields });
    let result: Cbor;
    if (method === "create_log") {
      const genesis = bytes(field(params, 1));
      if (log && !log[0]!.equals(genesis)) return this.reply({ error: "invalid" });
      if (!log) this.logs.set(collection, [genesis]);
      result = st([0, 1], [1, chainHash(genesis)]);
    } else if (method === "head") {
      if (!log) return this.reply({ error: "not_found" });
      result = st([0, head().seq], [1, head().chain], [2, 1]);
    } else if (method === "read") {
      if (this.failNextRead) {
        this.failNextRead = false;
        throw new TypeError("read failed");
      }
      if (!log) return this.reply({ error: "not_found" });
      const after = field(params, 1) as number;
      const items: Cbor[] = [];
      for (let i = after; i < log.length; i += 1) {
        const decoded = decodeCbor(log[i]!);
        if (field(decoded, 0) !== 1) continue;
        items.push([i + 1, log[i]!]);
        break;
      }
      result = st([0, items], [1, head().seq], [2, head().chain], [3, 1], [4, false], [6, false]);
    } else if (method === "append") {
      if (this.refuseNextAppend) {
        this.refuseNextAppend = false;
        return this.reply({ error: "forbidden" });
      }
      if (!log) return this.reply({ error: "not_found" });
      const expectSeq = field(params, 1) as number;
      const items = (field(params, 3) as Uint8Array[]).map((item) => Buffer.from(item));
      if (expectSeq <= log.length && items.every((item, i) => log[expectSeq - 1 + i]?.equals(item))) {
        result = st([0, 0], [1, expectSeq], [2, expectSeq + items.length - 1]);
      } else if (expectSeq !== log.length + 1 || !bytes(field(params, 2)).equals(Buffer.from(head().chain))) {
        result = st([0, 1], [1, head().seq], [2, head().chain]);
      } else {
        log.push(...items);
        result = st([0, 0], [1, expectSeq], [2, log.length]);
      }
    } else {
      return this.reply({ error: "invalid" });
    }
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new TypeError("fetch failed");
    }
    return this.reply({ result });
  };

  private reply(input: { result?: Cbor; error?: string }): Response {
    const frame = encodeCbor({ struct: [[0, 1], [1, 1], [2, input.result], [3, input.error ? { struct: [[0, input.error]] } : undefined]] });
    return new Response(frame, { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  }

  /** Decode the policy ops at each position, verifying each item's signature. */
  policyOps(collectionId: string, policyKey: Uint8Array): string[][] {
    return this.logs.get(collectionId.replaceAll("-", ""))!.map((item) => {
      const decoded = decodeCbor(item);
      expect(bytes(field(decoded, 6)).equals(Buffer.from(keyId(policyKey)))).toBe(true);
      const digest = policyItemSignedDigest(collectionId, field(decoded, 3) as number, bytes(field(decoded, 4)), bytes(field(decoded, 6)), bytes(field(decoded, 11)));
      expect(verify(null, digest, ed25519PublicKeyObject(policyKey), bytes(field(decoded, 12)))).toBe(true);
      const payload = decodeCbor(bytes(field(decoded, 11)));
      return (field(payload, 3) as Decoded[]).map((op) => String(field(op, 0)));
    });
  }
}

async function withDatabase(prefix: string) {
  const url = new URL(testUrl!);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
    throw new Error("Policy outbox tests require a dedicated local test database.");
  }
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const db = await createDatabase(url.toString());
  return {
    db,
    async close() {
      await db.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

async function newUser(db: DatabasePool): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [id, `${id}@example.com`]);
  return id;
}

const deviceKeys = () => ({ signPublicKey: Buffer.alloc(32, 1), kemPublicKey: Buffer.alloc(32, 2), noisePublicKey: Buffer.alloc(32, 3) });

function genesisOps(owner: string, root: Uint8Array): PolicyOp[] {
  return [
    { op: "genesis", owner, root, state: "cloud-copy" },
    { op: "member-set", account: owner, role: "owner" },
    { op: "device-enrol", device: randomUUID(), account: "00000000-0000-0000-0000-000000000000", kind: "escrow", ...deviceKeys() },
    { op: "device-enrol", device: randomUUID(), account: "00000000-0000-0000-0000-000000000000", kind: "hosted", ...deviceKeys() },
  ];
}

describePostgres("mdbase-next policy outbox", () => {
  let database: Awaited<ReturnType<typeof withDatabase>>;
  const now = Date.now();
  const root = generateKeyPairSync("ed25519").privateKey;
  const policy = generateKeyPairSync("ed25519").privateKey;
  const issuer = generateKeyPairSync("ed25519").privateKey;
  const signer = certify(root, policy, now);
  const service = new FakeLogService(ed25519RawPublicKey(issuer));
  const client = new LogServiceClient({ url: "http://log.test", tokenIssuerKeyPem: pem(issuer), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }, service.fetch);

  beforeAll(async () => {
    database = await withDatabase("mdbase_next_outbox_test");
  }, 60_000);
  afterAll(async () => database?.close(), 60_000);

  async function register(owner: string) {
    const collectionId = randomUUID();
    await registerNextCollection(database.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: signer.cert.root, ops: genesisOps(owner, signer.cert.root) });
    return collectionId;
  }

  it("creates the log with the genesis item, then appends queued ops as one item", async () => {
    const owner = await newUser(database.db);
    const collectionId = await register(owner);
    const emitter = new PolicyEmitter(database.db, client, signer);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    const member = await newUser(database.db);
    expect(await queueNextPolicy(database.db, collectionId, [{ op: "member-set", account: member, role: "editor" }])).toBe(true);
    expect(await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }])).toBe(true);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    expect(service.policyOps(collectionId, signer.cert.policyPublicKey)).toEqual([["1", "4", "2", "2"], ["4", "7"]]);
    const issued = await database.db.query<{ issued_at: string }>("SELECT issued_at FROM next_policy_batches WHERE collection_id = $1 ORDER BY seq", [collectionId]);
    expect(Number(issued.rows[1]!.issued_at)).toBeGreaterThan(Number(issued.rows[0]!.issued_at));
  });

  it("never lets a private collection enrol a hosted or escrow device", async () => {
    const owner = await newUser(database.db);
    const collectionId = randomUUID();
    const privateGenesis: PolicyOp[] = [{ op: "genesis", owner, root: signer.cert.root, state: "e2e" }, { op: "member-set", account: owner, role: "owner" }];
    await expect(registerNextCollection(database.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "private", rootKeyId: signer.cert.root, ops: genesisOps(owner, signer.cert.root).map((op) => (op.op === "genesis" ? { ...op, state: "e2e" as const } : op)) })).rejects.toThrow(/never enrols/);
    await registerNextCollection(database.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "private", rootKeyId: signer.cert.root, ops: privateGenesis });
    await expect(queueNextPolicy(database.db, collectionId, [{ op: "device-enrol", device: randomUUID(), account: "00000000-0000-0000-0000-000000000000", kind: "hosted", ...deviceKeys() }])).rejects.toThrow(/never enrols/);
    await expect(queueNextPolicy(database.db, collectionId, [{ op: "collection-state", state: "cloud-copy" }])).rejects.toThrow(/never enrols/);
    expect(await queueNextPolicy(database.db, collectionId, [{ op: "device-enrol", device: randomUUID(), account: owner, kind: "desktop", ...deviceKeys() }])).toBe(true);
    const grant = { op: "grant" as const, grant: randomUUID(), installation: randomUUID(), appId: "app", account: owner, capabilities: ["collection.read"], clientPublicKey: Buffer.alloc(32, 9) };
    await expect(queueNextPolicy(database.db, collectionId, [{ ...grant, fileFolders: ["Private"] }])).rejects.toThrow(/folder names in clear/);
    expect(await queueNextPolicy(database.db, collectionId, [{ ...grant, folderScoped: true }])).toBe(true);
    await expect(database.db.query("INSERT INTO next_collections (collection_id, owner_user_id, runtime, sync, root_key_id) VALUES ($1, $2, 'next', 'local', $3)", [randomUUID(), owner, Buffer.alloc(16)])).rejects.toThrow();
  });

  it("queues nothing for a collection the new runtime does not serve", async () => {
    expect(await queueNextPolicy(database.db, randomUUID(), [{ op: "grant-revoke", grant: randomUUID() }])).toBe(false);
  });

  it("does not queue ops whose transaction rolls back", async () => {
    const collectionId = await register(await newUser(database.db));
    await new PolicyEmitter(database.db, client, signer).drainCollection(collectionId);
    const connection = await database.db.connect();
    await connection.query("BEGIN");
    await queueNextPolicy(connection, collectionId, [{ op: "freeze", frozen: true }]);
    await connection.query("ROLLBACK");
    connection.release();
    expect(await new PolicyEmitter(database.db, client, signer).drainCollection(collectionId)).toBe(0);
  });

  it("retries the same bytes after a lost response, without a second item", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    service.dropNextResponse = true;
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow(/fetch failed/);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    expect(service.policyOps(collectionId, signer.cert.policyPublicKey)).toHaveLength(2);
  });

  it("rebuilds at the new head when another writer appended first", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    service.dropNextResponse = true;
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow();
    // Simulate the lost append never having landed, and a device item taking seq 2.
    const log = service.logs.get(collectionId.replaceAll("-", ""))!;
    log.splice(1, 1, Buffer.from("a0", "hex"));
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    expect(log).toHaveLength(3);
    const batches = await database.db.query<{ seq: string }>("SELECT seq FROM next_policy_batches WHERE collection_id = $1 AND state = 'appended' ORDER BY seq", [collectionId]);
    expect(batches.rows.map((row) => Number(row.seq))).toEqual([1, 3]);
  });

  it("parks the queue on a refusal and keeps later ops behind it", async () => {
    const collectionId = randomUUID();
    const owner = await newUser(database.db);
    await registerNextCollection(database.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: signer.cert.root, ops: genesisOps(owner, signer.cert.root) });
    service.logs.set(collectionId.replaceAll("-", ""), [Buffer.from("a0", "hex")]);
    const emitter = new PolicyEmitter(database.db, client, signer);
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow(/invalid/);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    expect(await emitter.drainCollection(collectionId)).toBe(0);
    const parked = await database.db.query<{ state: string }>("SELECT state FROM next_policy_batches WHERE collection_id = $1", [collectionId]);
    expect(parked.rows).toEqual([{ state: "parked" }]);
  });

  it("reissues a regressed acknowledged tail in original batches before fresh ops, once", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    const grant = randomUUID();
    await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant }]);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    await emitter.drainCollection(collectionId);
    const log = service.logs.get(collectionId.replaceAll("-", ""))!;
    const original = log.slice(1);
    log.splice(1);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false }]);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(2);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
    expect(await emitter.drainCollection(collectionId)).toBe(3);
    expect(service.policyOps(collectionId, signer.cert.policyPublicKey)).toEqual([["1", "4", "2", "2"], ["7"], ["11"], ["11"]]);
    // Same canonical op bytes/subjects, fresh item signature and issued_at.
    original.forEach((item, index) => {
      const oldPayload = decodeCbor(bytes(field(decodeCbor(item), 11)));
      const newPayload = decodeCbor(bytes(field(decodeCbor(log[index + 1]!), 11)));
      expect(field(newPayload, 3)).toEqual(field(oldPayload, 3));
      expect(field(newPayload, 2)).toBeGreaterThan(field(oldPayload, 2) as number);
      expect(log[index + 1]!.equals(item)).toBe(false);
    });
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
    // The replacement can itself be lost on the next failover.
    log.splice(1);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(3);
    expect(await emitter.drainCollection(collectionId)).toBe(3);
  });

  it("detects an overwritten position at a nonregressed head, without trusting hints", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "member-remove", account: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1, 1, Buffer.from("a0", "hex"));
    emitter.hintLostPolicy(collectionId);
    await emitter.drain();
    const restored = service.logs.get(collectionId.replaceAll("-", ""))!.at(-1)!;
    const ops = field(decodeCbor(bytes(field(decodeCbor(restored), 11))), 3) as Decoded[];
    expect(ops.map((op) => field(op, 0))).toEqual([5]);
    expect((await client.head(collectionId)).seq).toBe(3);
  });

  it("rolls back loss scheduling if verification fails", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    service.failNextRead = true;
    await expect(recoverLostPolicy(database.db, client, collectionId)).rejects.toThrow(/read failed/);
    const marked = await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id = $1 AND lost_at IS NOT NULL", [collectionId]);
    expect(marked.rows).toHaveLength(0);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
  });

  it("serializes concurrent checks and parks refused reissues with later work blocked", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
    const results = await Promise.all([recoverLostPolicy(database.db, client, collectionId), recoverLostPolicy(database.db, client, collectionId)]);
    expect(results.sort()).toEqual([0, 1]);
    service.refuseNextAppend = true;
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow(/forbidden/);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false }]);
    expect(await emitter.drainCollection(collectionId)).toBe(0);
    const parked = await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id = $1 AND state = 'parked'", [collectionId]);
    expect(parked.rows).toHaveLength(1);
  });

  it("parks a reissue that cannot be signed without relaxing certificate validity", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
    await recoverLostPolicy(database.db, client, collectionId);
    const expired = new PolicyEmitter(database.db, client, signer, () => undefined, 2_000, () => signer.cert.notAfter + 1);
    expect(await expired.drainCollection(collectionId)).toBe(0);
    const parked = await database.db.query<{ error: string }>("SELECT error FROM next_policy_batches WHERE collection_id = $1 AND state = 'parked'", [collectionId]);
    expect(parked.rows[0]!.error).toMatch(/validity window/);
  });

  it("parks lost genesis instead of changing the root at a new position", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(0, 1, Buffer.from("a0", "hex"));
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
    expect(await emitter.drainCollection(collectionId)).toBe(0);
    const batch = await database.db.query<{ error: string }>("SELECT error FROM next_policy_batches WHERE collection_id = $1", [collectionId]);
    expect(batch.rows[0]!.error).toBe("lost_genesis");
  });

  it("accepts only authenticated owner hints, verifies bytes, and surfaces parked readiness", async () => {
    const owner = await newUser(database.db);
    const collectionId = await register(owner);
    const token = randomUUID();
    const connector = randomUUID();
    await database.db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Test',$3)", [connector, owner, tokenHash(token)]);
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    const app = Fastify();
    registerPolicyRecoveryRoutes(app, database.db, emitter);
    app.get("/ready", () => ({ ok: true }));
    try {
      const url = `/v1/next/collections/${collectionId}/lost-policy`;
      const payload = { from_seq: 1, to_seq: 999, ops_digest: "ab".repeat(32) };
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      const otherToken = randomUUID();
      await database.db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Other',$3)", [randomUUID(), await newUser(database.db), tokenHash(otherToken)]);
      expect((await app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(202);
      expect((await app.inject({ method: "POST", url: `/v1/next/collections/${randomUUID()}/lost-policy`, payload, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url, payload: { ...payload, ops_digest: "bad" }, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400);
      await emitter.drain();
      expect((await client.head(collectionId)).seq).toBe(1);
      await database.db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [connector]);
      expect((await app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("refuses to sign for a collection governed by another root", async () => {
    const other = certify(generateKeyPairSync("ed25519").privateKey, policy, now);
    const collectionId = await register(await newUser(database.db));
    await expect(new PolicyEmitter(database.db, client, other).drainCollection(collectionId)).rejects.toThrow(/different root/);
  });
});

describeInterop("mdbase-next policy outbox against logsvc", () => {
  let database: Awaited<ReturnType<typeof withDatabase>>;
  // logsvc --testkit-cp <label> pins the root and token issuer derived from the label.
  const root = seededKey(`${logServiceLabel}/root`);
  const issuer = seededKey(`${logServiceLabel}/issuer`);
  const signer = certify(root, generateKeyPairSync("ed25519").privateKey, Date.now());
  let client: LogServiceClient;

  beforeAll(async () => {
    client = new LogServiceClient({ url: logServiceUrl!, tokenIssuerKeyPem: pem(issuer), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) });
    database = await withDatabase("mdbase_next_logsvc_test");
  }, 60_000);
  afterAll(async () => database?.close(), 60_000);

  it("creates a log and appends policy items the service accepts", async () => {
    const owner = await newUser(database.db);
    const collectionId = randomUUID();
    await registerNextCollection(database.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: signer.cert.root, ops: genesisOps(owner, signer.cert.root) });
    const emitter = new PolicyEmitter(database.db, client, signer);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    await queueNextPolicy(database.db, collectionId, [{ op: "member-set", account: randomUUID(), role: "viewer" }, { op: "freeze", frozen: true }]);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false, reason: "interop" }]);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    expect((await client.head(collectionId)).seq).toBe(3);
  });
});
