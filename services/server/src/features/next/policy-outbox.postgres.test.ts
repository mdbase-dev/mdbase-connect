import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { tokenHash } from "../../security.js";
import { capabilityOperations } from "@mdbase-dev/connect-protocol";
import { createNativeApprovalDelivery } from "../authorizations/native-approval-delivery.js";
import { queueNextGrantPolicy } from "./grant-policy.js";
import { recoverLostPolicy, withPolicyLock } from "./policy-recovery.js";
import { registerPolicyRecoveryRoutes } from "./policy-recovery-routes.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { LogServiceClient } from "./log-service-client.js";
import { PolicyEmitter, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { activatePendingServices } from "./service-activation.js";
import { certDigest, chainHash, decodeCbor, domainHash, encodeCbor, keyId, policyItemSignedDigest, type Cbor, type Decoded, type PolicyOp, type PolicySigner } from "./policy-wire.js";
import { ed25519PublicKeyObject, ed25519RawPublicKey } from "./policy-keys.js";
import { FakeLogService, certify, field, bytes } from "../../../test/policy-log.js";

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

  function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }

  function trackedPool() {
    const pids: number[] = [];
    const db: DatabasePool = { ...database.db, async connect() {
      const connection = await database.db.connect();
      pids.push((await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
      return connection;
    } };
    return { db, pids };
  }

  async function transactions(pids: number[]) {
    return (await database.db.query(
      "SELECT pid, state FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND xact_start IS NOT NULL", [pids]
    )).rows;
  }

  it("does not hold SQL transactions or borrow another connection while the remote head is pending", async () => {
    const collectionId = await register(await newUser(database.db));
    const initial = new PolicyEmitter(database.db, client, signer);
    await initial.drainCollection(collectionId);
    await initial.close();
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    const entered = gate(), finish = gate(), tracked = trackedPool();
    const head = client.head.bind(client);
    const spy = vi.spyOn(client, "head").mockImplementationOnce(async id => {
      entered.release(); await finish.promise; return head(id);
    });
    const emitter = new PolicyEmitter(tracked.db, client, signer);
    const work = emitter.drainCollection(collectionId);
    try {
      await entered.promise;
      expect(await transactions(tracked.pids)).toEqual([]);
      expect(tracked.pids).toHaveLength(1);
      expect((await database.db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND pid=ANY($1::int[])", [tracked.pids])).rows).toHaveLength(1);
    } finally { finish.release(); await work; spy.mockRestore(); await emitter.close(); }
    expect((await client.head(collectionId)).seq).toBe(2);
  });

  it("retries a failed global verification on a fresh connection before draining its queued work", async () => {
    const collectionId = await register(await newUser(database.db));
    const initial = new PolicyEmitter(database.db, client, signer);
    await initial.drainCollection(collectionId); await initial.close();
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    const entered = gate(), finish = gate(), tracked = trackedPool(), errors = vi.fn();
    const read = client.controlItemAt.bind(client);
    const spy = vi.spyOn(client, "controlItemAt").mockImplementation(async (id, seq) => {
      if (id === collectionId) { entered.release(); await finish.promise; }
      return read(id, seq);
    });
    const emitter = new PolicyEmitter(tracked.db, client, signer, errors);
    emitter.hintLostPolicy(collectionId);
    const work = emitter.drain();
    try {
      await entered.promise;
      await database.db.query("SELECT pg_terminate_backend($1)", [tracked.pids.at(-1)]);
      finish.release();
      await work;
      expect(errors.mock.calls.some(([, id]) => id === collectionId)).toBe(true);
      expect((await client.head(collectionId)).seq).toBe(1);
    } finally { finish.release(); await work; spy.mockRestore(); }
    // Failed probes request full recovery and must take priority next poll too.
    await emitter.drain();
    expect((await client.head(collectionId)).seq).toBe(2);
    await emitter.close();
  });

  it("releases a healthy owner's lock even when its callback throws", async () => {
    const collectionId = randomUUID(), tracked = trackedPool(), failure = new Error("callback failed");
    await expect(withPolicyLock(tracked.db, collectionId, async () => { throw failure; })).rejects.toBe(failure);
    expect(await withPolicyLock(tracked.db, collectionId, async () => 42)).toBe(42);
    expect((await database.db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=ANY($1::int[])", [tracked.pids])).rows).toEqual([]);
  });

  it("keeps a multi-page policy history verification outside SQL transactions", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    // More than one 64-row page, using real signed/acknowledged policy batches.
    for (let i = 0; i < 65; i++) {
      await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: i % 2 === 0 }]);
      await emitter.drainCollection(collectionId);
    }
    const entered = gate(), finish = gate(), tracked = trackedPool();
    const read = client.controlItemAt.bind(client);
    let reads = 0;
    const spy = vi.spyOn(client, "controlItemAt").mockImplementation(async (id, seq) => {
      if (++reads === 65) { entered.release(); await finish.promise; }
      return read(id, seq);
    });
    const work = recoverLostPolicy(tracked.db, client, collectionId);
    try {
      await entered.promise;
      expect(await transactions(tracked.pids)).toEqual([]);
      expect(tracked.pids).toHaveLength(1);
    } finally { finish.release(); await work; spy.mockRestore(); await emitter.close(); }
    expect(reads).toBe(66);
    expect((await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id=$1 AND lost_at IS NOT NULL", [collectionId])).rows).toEqual([]);
  });

  it("preserves the callback error after lock connection termination and admits a fresh owner", async () => {
    const collectionId = randomUUID(), tracked = trackedPool(), entered = gate(), finish = gate();
    const original = new Error("original verification unavailable");
    const work = withPolicyLock(tracked.db, collectionId, async () => {
      entered.release(); await finish.promise; throw original;
    });
    const observed = work.catch(error => error);
    try {
      await entered.promise;
      await database.db.query("SELECT pg_terminate_backend($1)", [tracked.pids[0]]);
      finish.release();
      expect(await observed).toBe(original);
    } finally { finish.release(); await observed; }
    expect(await withPolicyLock(tracked.db, collectionId, async () => 42)).toBe(42);
    expect(tracked.pids.at(-1)).not.toBe(tracked.pids[0]);
    expect((await database.db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=ANY($1::int[])", [tracked.pids])).rows).toEqual([]);
  });

  it("fences a terminated sender while takeover retries the original bytes, without a stale ACK or fork", async () => {
    const collectionId = await register(await newUser(database.db));
    const initial = new PolicyEmitter(database.db, client, signer);
    await initial.drainCollection(collectionId); await initial.close();
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    const firstEntered = gate(), firstFinish = gate(), nextEntered = gate(), nextFinish = gate();
    const append = client.append.bind(client);
    const spy = vi.spyOn(client, "append")
      .mockImplementationOnce(async (...args) => { firstEntered.release(); await firstFinish.promise; return append(...args); })
      .mockImplementationOnce(async (...args) => { nextEntered.release(); await nextFinish.promise; return append(...args); });
    const tracked = trackedPool();
    const first = new PolicyEmitter(tracked.db, client, signer), next = new PolicyEmitter(database.db, client, signer);
    const original = first.drainCollection(collectionId).catch(error => error);
    let takeover: Promise<number> | undefined;
    try {
      await firstEntered.promise;
      await database.db.query("SELECT pg_terminate_backend($1)", [tracked.pids[0]]);
      takeover = next.drainCollection(collectionId);
      await nextEntered.promise;
      expect(spy.mock.calls[1]).toEqual(spy.mock.calls[0]);
      firstFinish.release();
      expect(await original).toBeInstanceOf(Error);
      // The old sender may have reached the log. Only the live owner may ACK it.
      expect((await database.db.query("SELECT state FROM next_policy_batches WHERE collection_id=$1 AND seq=2", [collectionId])).rows).toEqual([{ state: "sending" }]);
      nextFinish.release();
      expect(await takeover).toBe(1);
      expect((await client.head(collectionId)).seq).toBe(2);
      expect(service.policyOps(collectionId, signer.cert.policyPublicKey)).toEqual([["1", "4", "2", "2"], ["11"]]);
    } finally {
      firstFinish.release(); nextFinish.release();
      await original; await takeover;
      spy.mockRestore(); await first.close(); await next.close();
    }
  });

  it("does not claim or send after the owner dies during a remote head read", async () => {
    const collectionId = await register(await newUser(database.db));
    const initial = new PolicyEmitter(database.db, client, signer);
    await initial.drainCollection(collectionId); await initial.close();
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    const entered = gate(), finish = gate(), tracked = trackedPool();
    const head = client.head.bind(client);
    const headSpy = vi.spyOn(client, "head").mockImplementationOnce(async id => {
      entered.release(); await finish.promise; return head(id);
    });
    const appendSpy = vi.spyOn(client, "append");
    const emitter = new PolicyEmitter(tracked.db, client, signer);
    const work = emitter.drainCollection(collectionId).catch(error => error);
    try {
      await entered.promise;
      await database.db.query("SELECT pg_terminate_backend($1)", [tracked.pids[0]]);
      finish.release();
      expect(await work).toBeInstanceOf(Error);
      expect(appendSpy).not.toHaveBeenCalled();
      expect((await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id=$1 AND seq=2", [collectionId])).rows).toEqual([]);
    } finally { finish.release(); await work; headSpy.mockRestore(); appendSpy.mockRestore(); }
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    await emitter.close();
  });

  it("does not start an append after ownership dies between the claim commit and send decision", async () => {
    const collectionId = await register(await newUser(database.db));
    const initial = new PolicyEmitter(database.db, client, signer);
    await initial.drainCollection(collectionId); await initial.close();
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    const entered = gate(), finish = gate(), tracked = trackedPool();
    const emitter = new PolicyEmitter(tracked.db, client, signer);
    const steps = emitter as unknown as { claim(...args: unknown[]): Promise<unknown> };
    const claim = steps.claim.bind(emitter);
    const claimSpy = vi.spyOn(steps, "claim").mockImplementationOnce(async (...args) => {
      const batch = await claim(...args); entered.release(); await finish.promise; return batch;
    });
    const appendSpy = vi.spyOn(client, "append");
    const work = emitter.drainCollection(collectionId).catch(error => error);
    try {
      await entered.promise;
      await database.db.query("SELECT pg_terminate_backend($1)", [tracked.pids[0]]);
      finish.release();
      expect(await work).toBeInstanceOf(Error);
      expect(appendSpy).not.toHaveBeenCalled();
      expect((await database.db.query("SELECT state FROM next_policy_batches WHERE collection_id=$1 AND seq=2", [collectionId])).rows).toEqual([{ state: "sending" }]);
    } finally { finish.release(); await work; claimSpy.mockRestore(); appendSpy.mockRestore(); }
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    await emitter.close();
  });

  it("refuses to commit when the physical session is alive but no longer owns the lock", async () => {
    const collectionId = randomUUID();
    await expect(withPolicyLock(database.db, collectionId, async lock => {
      await lock.query("BEGIN");
      try {
        await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 20261004))", [collectionId]);
        await lock.commit();
      } catch (error) {
        await lock.query("ROLLBACK");
        throw error;
      }
    })).rejects.toThrow("policy lock ownership lost; outcome unknown");
    expect(await withPolicyLock(database.db, collectionId, async lock => { await lock.assertOwned(); return 42; })).toBe(42);
  });

  it("does not schedule loss after the owner dies during verification, then recovers exactly once", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    for (const frozen of [true, false]) {
      await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen }]);
      await emitter.drainCollection(collectionId);
    }
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1, 1, Buffer.from("a0", "hex"));
    const entered = gate(), finish = gate(), tracked = trackedPool();
    const read = client.controlItemAt.bind(client);
    const spy = vi.spyOn(client, "controlItemAt").mockImplementation(async (id, seq) => {
      if (seq === 3) { entered.release(); await finish.promise; }
      return read(id, seq);
    });
    const work = recoverLostPolicy(tracked.db, client, collectionId).catch(error => error);
    try {
      await entered.promise;
      await database.db.query("SELECT pg_terminate_backend($1)", [tracked.pids[0]]);
      finish.release();
      expect(await work).toBeInstanceOf(Error);
      expect((await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id=$1 AND lost_at IS NOT NULL", [collectionId])).rows).toEqual([]);
      expect((await database.db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND reissue_of IS NOT NULL", [collectionId])).rows).toEqual([]);
    } finally { finish.release(); await work; spy.mockRestore(); }
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(1);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    await emitter.close();
  });

  it("does not commit a partial loss plan when a later verification read fails", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    for (const frozen of [true, false]) {
      await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen }]);
      await emitter.drainCollection(collectionId);
    }
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1, 1, Buffer.from("a0", "hex"));
    const read = client.controlItemAt.bind(client);
    const failure = new Error("later verification read failed");
    const spy = vi.spyOn(client, "controlItemAt").mockImplementation(async (id, seq) => {
      if (seq === 3) throw failure;
      return read(id, seq);
    });
    try {
      await expect(recoverLostPolicy(database.db, client, collectionId)).rejects.toBe(failure);
      expect((await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id=$1 AND lost_at IS NOT NULL", [collectionId])).rows).toEqual([]);
      expect((await database.db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND reissue_of IS NOT NULL", [collectionId])).rows).toEqual([]);
    } finally { spy.mockRestore(); await emitter.close(); }
  });

  it("survives the actual idle-transaction timeout during remote work without disabling it", async () => {
    const connection = await database.db.connect();
    // Shorten ONLY this disposable test session's timeout. Restore it before
    // returning the physical client; pool and production settings are unchanged.
    await connection.query("SET idle_in_transaction_session_timeout = '50ms'");
    const released = vi.fn();
    const db: DatabasePool = { ...database.db, connect: async () => ({ query: connection.query.bind(connection), release: released }) };
    try {
      expect((await connection.query("SHOW idle_session_timeout")).rows[0]!.idle_session_timeout).toBe("0");
      expect(await withPolicyLock(db, randomUUID(), async () => {
        // A separate backend supplies a deterministic server-side elapsed wait;
        // the lock owner's connection receives no SQL/heartbeat during it.
        await database.db.query("SELECT pg_sleep(0.15)");
        return 42;
      })).toBe(42);
      expect(released).toHaveBeenCalledOnce();
      expect((await connection.query("SHOW idle_in_transaction_session_timeout")).rows[0]!.idle_in_transaction_session_timeout).toBe("50ms");
    } finally {
      await connection.query("RESET idle_in_transaction_session_timeout").catch(() => undefined);
      connection.release();
    }
  });

  it("keeps the 64-row batch cap and drains the next batch without dropping queued policy", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    for (let i = 0; i < 65; i++) await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: i % 2 === 0 }]);
    expect(await emitter.drainCollection(collectionId)).toBe(2);
    expect(service.policyOps(collectionId, signer.cert.policyPublicKey).map(ops => ops.length)).toEqual([4, 64, 1]);
    expect((await database.db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND batch_id IS NULL", [collectionId])).rows).toEqual([]);
    await emitter.close();
  });

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

  it("publishes a committed Private request before its Native feed without waiting for the global poller", async () => {
    const owner = await newUser(database.db), collection = randomUUID(), connector = randomUUID(), device = randomUUID();
    const keys = deviceKeys();
    await database.db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Fixture',$3)", [connector,owner,randomUUID()]);
    await database.db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device,connector,owner,keys.signPublicKey,keys.kemPublicKey,keys.noisePublicKey]);
    await registerNextCollection(database.db, { collectionId:collection,ownerUserId:owner,runtime:"next",sync:"private",rootKeyId:signer.cert.root,
      ops:[{op:"genesis",owner,root:signer.cert.root,state:"e2e"},{op:"member-set",account:owner,role:"owner"},
        {op:"device-enrol",device,account:owner,kind:"desktop",...keys}] });
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => {release=resolve;});
    const globalEntered = new Promise<void>(resolve => {entered=resolve;});
    const emitter = new PolicyEmitter(database.db,client,signer,()=>{},2_000,Date.now,async id => {
      if(id===undefined){entered();await blocked;}
    });
    // Verified Native Private genesis exists, and a global drain is occupied by
    // unrelated activation work. No interval/start or artificial policy tick.
    expect(await emitter.drainCollection(collection)).toBe(1);
    expect(service.policyOps(collection,signer.cert.policyPublicKey)).toEqual([["1","4","2"]]);
    const global = emitter.drain();
    try {
      await globalEntered;
      const grant = randomUUID(), installation = randomUUID();
      await database.db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1::uuid,$1::text,'Fixture','https://fixture.example','[]')",[grant]);
      await database.db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,operations,scope,file_capability,application_installation_id,application_authorization,activated_at)
        VALUES($1,$2,$1,$3,$4::jsonb,'{"access":"full_collection","contracts":[]}',
          '{"kind":"files","protocol_version":1,"actions":["list","read"],"scope":{"kind":"collection"}}',$5,
          '{"binding":{"protocol_version":4,"application_declaration_id":"dev.mdbase.fixture","contracts":{"semantic_capabilities":2}}}',now())`,
        [grant,owner,collection,JSON.stringify(capabilityOperations("collection.read")),installation]);
      await database.db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)",[grant,Buffer.alloc(32,7)]);
      const tx = await database.db.connect();
      try {await tx.query("BEGIN");await queueNextGrantPolicy(tx,grant);await tx.query("COMMIT");}
      finally {tx.release();}
      const logHadRequestAtFeed: boolean[] = [];
      let deferred = 0;
      const delivery = createNativeApprovalDelivery(database.db,{pushPolicy:async id => {
        expect(id).toBe(connector);
        logHadRequestAtFeed.push(service.policyOps(collection,signer.cert.policyPublicKey).flat().includes("6"));
      }},()=>{deferred+=1;},emitter);
      await delivery.grant(grant);
      expect(logHadRequestAtFeed).toEqual([true]);
      expect(deferred).toBe(0);
      expect(service.policyOps(collection,signer.cert.policyPublicKey)).toEqual([["1","4","2"],["6"]]);
    } finally {release();await global;await emitter.close();}
  }, 3_000);

  it("owns bounded committed publication across caller exit and close, without queueing overflow", async () => {
    const collections: string[] = [];
    const initial = new PolicyEmitter(database.db,client,signer);
    for(let i=0;i<5;i+=1){
      const collection=await register(await newUser(database.db));collections.push(collection);
      await initial.drainCollection(collection);
      await queueNextPolicy(database.db,collection,[{op:"grant-revoke",grant:randomUUID()}]);
    }
    await initial.close();
    let release!:()=>void, entered!:()=>void, heads=0;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const allEntered=new Promise<void>(resolve=>{entered=resolve;});
    const gated=new LogServiceClient({url:"http://log.test",tokenIssuerKeyPem:pem(issuer),transportKeyPem:pem(generateKeyPairSync("ed25519").privateKey)},async(input,init)=>{
      if(init?.body&&field(decodeCbor(Buffer.from(init.body as Uint8Array)),2)==="head"){
        heads+=1;if(heads===4)entered();await blocked;
      }
      return service.fetch(input,init);
    });
    const emitter=new PolicyEmitter(database.db,gated,signer);
    const work=collections.slice(0,4).map(id=>emitter.publishCommitted(id));
    let closing:Promise<void>|undefined;
    try{
      await allEntered;
      expect(emitter.publishCommitted(collections[0]!)).toBe(work[0]);
      await expect(emitter.publishCommitted(collections[4]!)).rejects.toThrow("deferred");
      let closed=false;
      closing=emitter.close().then(()=>{closed=true;});
      await Promise.resolve();expect(closed).toBe(false);
      release();await Promise.all(work);await closing;
      expect(closed).toBe(true);
      for(const id of collections.slice(0,4))expect(service.policyOps(id,signer.cert.policyPublicKey)).toHaveLength(2);
      expect(service.policyOps(collections[4]!,signer.cert.policyPublicKey)).toHaveLength(1);
      expect((await database.db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND batch_id IS NULL",[collections[4]])).rows).toHaveLength(1);
      await expect(emitter.publishCommitted(collections[4]!)).rejects.toThrow("closed");
    }finally{release();await Promise.allSettled(work);await (closing??emitter.close());}
  });

  it("forwards the region from the create_log reply on activation, also after a lost reply; none without one", async () => {
    const deployments = { hosted: { url: "https://hosted.test", token: "h".repeat(40) }, escrow: { url: "https://escrow.test", token: "e".repeat(40) } };
    const activations = async (collectionId: string) => {
      for (const kind of ["hosted", "escrow"]) {
        await database.db.query(`INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn)
          VALUES($1,$2,$3,$4,$4,$4,$5,'arn:test:key')`, [collectionId, kind, randomUUID(), Buffer.alloc(32, 1), Buffer.from([1])]);
      }
      const bodies: unknown[] = [];
      await activatePendingServices(database.db, deployments, async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ activated: true }); }, collectionId);
      return bodies;
    };
    const emitter = new PolicyEmitter(database.db, client, signer);
    try {
      service.region = "wnam";
      const placed = await register(await newUser(database.db));
      expect(await emitter.drainCollection(placed)).toBe(1);
      expect(await activations(placed)).toEqual([{ collection: placed, region: "wnam" }, { collection: placed, region: "wnam" }]);

      // The log is created but its reply is lost; the retry answers the stored region, not today's default.
      const retried = await register(await newUser(database.db));
      service.dropNextResponse = true;
      await expect(emitter.drainCollection(retried)).rejects.toThrow(/fetch failed/);
      service.region = "oc";
      expect(await emitter.drainCollection(retried)).toBe(1);
      expect(await activations(retried)).toEqual([{ collection: retried, region: "wnam" }, { collection: retried, region: "wnam" }]);

      service.region = undefined;
      const regionless = await register(await newUser(database.db));
      expect(await emitter.drainCollection(regionless)).toBe(1);
      expect(await activations(regionless)).toEqual([{ collection: regionless }, { collection: regionless }]);
    } finally { service.region = undefined; }
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

  it.each([1, 80])("delivers fresh revocations before the verification time budget with %i acknowledged items", async (count) => {
    const isolated = await withDatabase("bounded_verification");
    const collectionId = randomUUID(), owner = await newUser(isolated.db);
    await registerNextCollection(isolated.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: signer.cert.root, ops: genesisOps(owner, signer.cert.root) });
    const emitter = new PolicyEmitter(isolated.db, client, signer);
    await emitter.drainCollection(collectionId);
    for (let i = 1; i < count; i++) {
      await queueNextPolicy(isolated.db, collectionId, [{ op: "freeze", frozen: false }]);
      await emitter.drainCollection(collectionId);
    }
    const grant = randomUUID();
    await queueNextPolicy(isolated.db, collectionId, [{ op: "grant-revoke", grant }]);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const originalRead = client.controlItemAt.bind(client);
    const read = vi.spyOn(client, "controlItemAt").mockImplementation(async (id, seq) => {
      // Even the first probe must see the fresh revoke already delivered.
      expect(service.policyOps(collectionId, signer.cert.policyPublicKey).at(-1)).toEqual(["7"]);
      elapsed += 501;
      return originalRead(id, seq);
    });
    try {
      expect(await emitter.drain()).toBe(1);
      // Do not start another probe after the 500 ms budget is exhausted.
      expect(read).toHaveBeenCalledTimes(1);
      expect(service.policyOps(collectionId, signer.cert.policyPublicKey).at(-1)).toEqual(["7"]);
      expect((await isolated.db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND batch_id IS NULL", [collectionId])).rows).toEqual([]);
    } finally { read.mockRestore(); clock.mockRestore(); await emitter.close(); await isolated.close(); }
  });

  it.each([10, 25])("finishes a production-scale fixture sweep within the poll budget at %i ms per probe", async (probeMs) => {
    const isolated = await withDatabase("verification_sweep");
    const owner = await newUser(isolated.db), ids = Array.from({ length: 1056 }, () => randomUUID());
    // Use the unmodified main schema and count real appended rows. The healthy
    // byte fixtures isolate scheduling, not signing or log transport validation.
    const item = Buffer.from("a0", "hex");
    await isolated.db.query(`INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id)
      SELECT id, $2, 'next', 'cloud_copy', $3 FROM unnest($1::uuid[]) id`, [ids, owner, signer.cert.root]);
    await isolated.db.query(`INSERT INTO next_policy_batches(collection_id, seq, prev, item, issued_at, state, appended_at)
      SELECT id, seq, $2, $3, 1, 'appended', now() FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,4) seq`,
    [ids, Buffer.alloc(32), item]);
    const totals = (await isolated.db.query<{ batches: number; collections: number }>(
      "SELECT count(*)::int AS batches, count(DISTINCT collection_id)::int AS collections FROM next_policy_batches WHERE state='appended'"
    )).rows[0]!;
    expect(totals).toEqual({ batches: 4224, collections: 1056 });
    let elapsed = 0, checked = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const head = vi.spyOn(client, "head").mockImplementation(async () => {
      elapsed += probeMs;
      return { seq: 4, chain: Buffer.alloc(32) };
    });
    const read = vi.spyOn(client, "controlItemAt").mockImplementation(async () => { checked++; return item; });
    const errors = vi.fn(), emitter = new PolicyEmitter(isolated.db, client, signer, errors, 2_000, () => 0);
    // Each collection also needs one empty probe to finish its finite sweep.
    const probesPerPoll = Math.min(32, Math.ceil(500 / probeMs));
    const polls = Math.ceil((totals.batches + totals.collections) / probesPerPoll);
    try {
      for (let i = 0; i < polls; i++) {
        const before = head.mock.calls.length;
        await emitter.drain();
        expect(head.mock.calls.length - before).toBeLessThanOrEqual(probesPerPoll);
      }
      expect(errors).not.toHaveBeenCalled();
      expect(checked).toBe(totals.batches);
      expect(head).toHaveBeenCalledTimes(totals.batches + totals.collections);
      expect(polls).toBe(probeMs === 10 ? 165 : 264);
      // No more probes until the next scheduled sweep; all cursors completed.
      await emitter.drain();
      expect(head).toHaveBeenCalledTimes(totals.batches + totals.collections);
    } finally { read.mockRestore(); head.mockRestore(); clock.mockRestore(); await emitter.close(); await isolated.close(); }
  }, 120_000);

  it("recovers a late hint and delivers its pending revocation on the next poll ahead of healthy history", async () => {
    const isolated = await withDatabase("priority_recovery");
    const owner = await newUser(isolated.db), collectionId = randomUUID();
    const healthy = Array.from({ length: 1056 }, () => randomUUID()), item = Buffer.from("a0", "hex");
    await isolated.db.query(`INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id)
      SELECT id, $2, 'next', 'cloud_copy', $3 FROM unnest($1::uuid[]) id`, [healthy, owner, signer.cert.root]);
    await isolated.db.query(`INSERT INTO next_policy_batches(collection_id, seq, prev, item, issued_at, state)
      SELECT id, 1, $2, $3, 1, 'appended' FROM unnest($1::uuid[]) id`, [healthy, Buffer.alloc(32), item]);
    await registerNextCollection(isolated.db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: signer.cert.root, ops: genesisOps(owner, signer.cert.root) });
    const emitter = new PolicyEmitter(isolated.db, client, signer, undefined, 2_000, () => now);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(isolated.db, collectionId, [{ op: "member-remove", account: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    const originalHead = client.head.bind(client), originalRead = client.controlItemAt.bind(client);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const head = vi.spyOn(client, "head").mockImplementation(async id =>
      id === collectionId ? originalHead(id) : { seq: 1, chain: Buffer.alloc(32) });
    const read = vi.spyOn(client, "controlItemAt").mockImplementation(async (id, seq) =>
      id === collectionId ? originalRead(id, seq) : item);
    try {
      await emitter.drain(); // Fill the rotation; only 32 of 1,056 healthy collections can be probed.
      expect(head.mock.calls.filter(([id]) => id !== collectionId).length).toBeLessThanOrEqual(32);
      service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
      await queueNextPolicy(isolated.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
      emitter.hintLostPolicy(collectionId); // Arrives behind the existing healthy cursors.
      head.mockClear();
      expect(await emitter.drain()).toBe(2); // Reissue first, then the fresh revoke, in this poll.
      expect(head.mock.calls[0]).toEqual([collectionId]);
      expect(service.policyOps(collectionId, signer.cert.policyPublicKey)).toEqual([["1", "4", "2", "2"], ["5"], ["7"]]);
      expect((await isolated.db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND batch_id IS NULL", [collectionId])).rows).toEqual([]);
    } finally { read.mockRestore(); head.mockRestore(); clock.mockRestore(); await emitter.close(); await isolated.close(); }
  });

  it("advances bounded verification and rebuilds the complete ordered loss plan on a later page", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: true }]);
    await emitter.drainCollection(collectionId);
    const cursor = { after: "0" };
    const read = vi.spyOn(client, "controlItemAt");
    try {
      expect(await recoverLostPolicy(database.db, client, collectionId, cursor)).toBe(0);
      expect(cursor.after).not.toBe("0");
      expect(read).toHaveBeenCalledTimes(1);
      // Loss begins beyond the already checked prefix. Full recovery must still
      // inspect all history before atomically scheduling the ordered reissues.
      service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
      expect(await recoverLostPolicy(database.db, client, collectionId, cursor)).toBe(2);
      expect(cursor.after).toBe("0");
      expect(await emitter.drainCollection(collectionId)).toBe(2);
      expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
      while (true) {
        await recoverLostPolicy(database.db, client, collectionId, cursor);
        if (cursor.after === "0") break;
      }
    } finally { read.mockRestore(); await emitter.close(); }
  });

  it("finishes a bounded sweep even while fresh batches keep arriving", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    const cursor = { after: "0" };
    await recoverLostPolicy(database.db, client, collectionId, cursor);
    expect(cursor.after).not.toBe("0");
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false }]);
    await emitter.drainCollection(collectionId);
    const read = vi.spyOn(client, "controlItemAt");
    try {
      await recoverLostPolicy(database.db, client, collectionId, cursor);
      expect(cursor.after).toBe("0");
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); await emitter.close(); }
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

  it("fences an open fresh sending batch prepared at the regressed head until recovery lands", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false }]);
    service.failNextAppend = true;
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow(/append unavailable/);
    const sending = await database.db.query("SELECT 1 FROM next_policy_batches WHERE collection_id = $1 AND state = 'sending'", [collectionId]);
    expect(sending.rows).toHaveLength(1);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(1);
    expect(await emitter.drainCollection(collectionId)).toBe(2);
    expect(service.policyOps(collectionId, signer.cert.policyPublicKey)).toEqual([["1", "4", "2", "2"], ["7"], ["11"]]);
  });

  it("does not drain fresh work after an exact-read failure until its verification retry succeeds", async () => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false }]);
    service.failReadCollection = collectionId.replaceAll("-", "");
    emitter.hintLostPolicy(collectionId);
    service.failNextRead = true;
    await emitter.drain();
    expect((await client.head(collectionId)).seq).toBe(1);
    const checks = (await database.db.query("SELECT DISTINCT collection_id FROM next_policy_batches")).rows.length;
    service.failNextRead = true;
    for (let i = 0; i <= checks && service.failNextRead; i++) await emitter.drain();
    expect(service.failNextRead).toBe(false);
    expect((await client.head(collectionId)).seq).toBe(1);
    for (let i = 0; i <= checks; i++) await emitter.drain();
    expect((await client.head(collectionId)).seq).toBe(2);
    service.failReadCollection = undefined;
  });

  it.each(["version", "missing", "null", "string"])("durably parks unrecoverable %s retained ops instead of draining fresh work", async (failure) => {
    const collectionId = await register(await newUser(database.db));
    const emitter = new PolicyEmitter(database.db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(database.db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    if (failure === "version") {
      await database.db.query("UPDATE next_policy_outbox SET ops = jsonb_set(ops, '{version}', '99') WHERE batch_id IN (SELECT id FROM next_policy_batches WHERE collection_id = $1 AND seq = 2)", [collectionId]);
    } else if (failure === "missing") {
      await database.db.query("DELETE FROM next_policy_outbox WHERE batch_id IN (SELECT id FROM next_policy_batches WHERE collection_id = $1 AND seq = 2)", [collectionId]);
    } else {
      await database.db.query("UPDATE next_policy_outbox SET ops = $2::jsonb WHERE batch_id IN (SELECT id FROM next_policy_batches WHERE collection_id = $1 AND seq = 2)", [collectionId, JSON.stringify(failure === "null" ? null : "unsupported")]);
    }
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
    await queueNextPolicy(database.db, collectionId, [{ op: "freeze", frozen: false }]);
    expect(await recoverLostPolicy(database.db, client, collectionId)).toBe(0);
    expect(await emitter.drainCollection(collectionId)).toBe(0);
    const parked = await database.db.query<{ error: string }>("SELECT error FROM next_policy_batches WHERE collection_id = $1 AND state = 'parked'", [collectionId]);
    expect(parked.rows[0]!.error).toBe("invalid_retained_ops");
    const app = Fastify();
    registerPolicyRecoveryRoutes(app, database.db, emitter);
    app.get("/ready", () => ({ ok: true }));
    try { expect((await app.inject({ url: "/ready" })).statusCode).toBe(503); } finally { await app.close(); }
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
