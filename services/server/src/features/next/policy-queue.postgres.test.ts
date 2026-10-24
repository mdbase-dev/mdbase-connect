// A parked policy queue on real Postgres: refusals from something in front of the
// log service are retried with backoff instead of parking, an operator can
// resume a parked batch unchanged (audited), and /ready reports parked work
// without taking the whole service out of readiness.
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerSystemRoutes } from "../system/routes.js";
import { LogServiceClient } from "./log-service-client.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { PolicyEmitter, policyQueueHealth, queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { recoverLostPolicy, unparkPolicyQueue } from "./policy-recovery.js";
import { registerPolicyRecoveryRoutes } from "./policy-recovery-routes.js";
import type { PolicyOp } from "./policy-wire.js";
import { FakeLogService, certify } from "../../../test/policy-log.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

const pem = (key: KeyObject) => key.export({ format: "pem", type: "pkcs8" }).toString();
const deviceKeys = () => ({ signPublicKey: Buffer.alloc(32, 1), kemPublicKey: Buffer.alloc(32, 2), noisePublicKey: Buffer.alloc(32, 3) });

describePostgres("parked policy queues (real Postgres)", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const now = Date.now();
  const signer = certify(generateKeyPairSync("ed25519").privateKey, generateKeyPairSync("ed25519").privateKey, now);
  const issuer = generateKeyPairSync("ed25519").privateKey;
  const service = new FakeLogService(ed25519RawPublicKey(issuer));
  // An edge proxy in front of the log service answering RPCs with its own,
  // non-CBOR error page: once (`edge`) or until cleared (`edgeAlways`).
  let edge: number | undefined;
  let edgeAlways: number | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const status = edge ?? edgeAlways;
    if (status && new URL(String(input)).pathname === "/v1/rpc") {
      edge = undefined;
      return new Response("<html>request blocked</html>", { status, headers: { "content-type": "text/html" } });
    }
    return service.fetch(input, init);
  };
  const client = new LogServiceClient({ url: "http://log.test", tokenIssuerKeyPem: pem(issuer), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }, fetchImpl);

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Policy queue tests require a dedicated local test database.");
    schema = `mdbase_policy_queue_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function register(): Promise<string> {
    const owner = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')", [owner, `${owner}@example.com`]);
    const collectionId = randomUUID();
    const ops: PolicyOp[] = [
      { op: "genesis", owner, root: signer.cert.root, state: "cloud-copy" },
      { op: "member-set", account: owner, role: "owner" },
      { op: "device-enrol", device: randomUUID(), account: "00000000-0000-0000-0000-000000000000", kind: "escrow", ...deviceKeys() },
      { op: "device-enrol", device: randomUUID(), account: "00000000-0000-0000-0000-000000000000", kind: "hosted", ...deviceKeys() },
    ];
    await registerNextCollection(db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: signer.cert.root, ops });
    return collectionId;
  }

  const batches = async (collectionId: string) => (await db.query<{ seq: string; state: string; attempts: number; lost: boolean }>(
    "SELECT seq, state, attempts, lost_at IS NOT NULL AS lost FROM next_policy_batches WHERE collection_id = $1 ORDER BY id", [collectionId]
  )).rows;
  const unparkAudits = async (collectionId: string) => (await db.query<{ metadata: Record<string, unknown> }>(
    "SELECT metadata FROM audit_events WHERE event_type = 'next_policy.unparked' AND subject_id = $1", [collectionId]
  )).rows.map(row => row.metadata);

  it.each([403, 413, 429, 401])("retries a %s from an edge proxy instead of parking the queue", async status => {
    const collectionId = await register();
    const emitter = new PolicyEmitter(db, client, signer);
    edge = status;
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow(`http_${status}`);
    expect(await batches(collectionId)).toEqual([{ seq: "1", state: "sending", attempts: 1, lost: false }]);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    expect(await batches(collectionId)).toEqual([{ seq: "1", state: "appended", attempts: 1, lost: false }]);
  });

  it("backs off a collection whose sends keep failing, and stops once one succeeds", async () => {
    let clock = now;
    const collectionId = await register();
    const emitter = new PolicyEmitter(db, client, signer, () => undefined, 2_000, () => clock);
    const attempts = async () => (await batches(collectionId))[0]?.attempts ?? 0;
    edgeAlways = 429;
    try {
      await emitter.drain();
      expect(await attempts()).toBe(1);
      await emitter.drain();
      expect(await attempts()).toBe(1);
      clock += 4_000; await emitter.drain();
      expect(await attempts()).toBe(2);
      clock += 4_000; await emitter.drain();
      expect(await attempts()).toBe(2);
      clock += 4_000; await emitter.drain();
      expect(await attempts()).toBe(3);
    } finally { edgeAlways = undefined; }
    clock += 16_000; await emitter.drain();
    expect(await batches(collectionId)).toEqual([{ seq: "1", state: "appended", attempts: 3, lost: false }]);
    // A foreground publish is never held back by the poller's backoff.
    await queueNextPolicy(db, collectionId, [{ op: "freeze", frozen: true }]);
    await expect(emitter.publishCommitted(collectionId)).resolves.toBeUndefined();
  });

  it("keeps parking on the log service's own refusal, and resumes that batch unchanged once, audited", async () => {
    const collectionId = await register();
    const emitter = new PolicyEmitter(db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(db, collectionId, [{ op: "freeze", frozen: true }]);
    service.refuseNextAppend = true;
    await expect(emitter.drainCollection(collectionId)).rejects.toThrow(/forbidden/);
    await queueNextPolicy(db, collectionId, [{ op: "freeze", frozen: false }]);
    expect(await emitter.drainCollection(collectionId)).toBe(0);
    const parked = (await db.query<{ id: string; item: Buffer }>(
      "SELECT id, item FROM next_policy_batches WHERE collection_id = $1 AND state = 'parked'", [collectionId]
    )).rows[0]!;

    await expect(unparkPolicyQueue(db, collectionId, { actor: " ", reason: "fixed" })).rejects.toThrow(/operator/);
    await expect(unparkPolicyQueue(db, collectionId, { actor: "on-call", reason: "" })).rejects.toThrow(/reason/);
    const resumed = await unparkPolicyQueue(db, collectionId, { actor: "on-call", reason: "log service fixed" });
    expect(resumed).toEqual([{ batch_id: parked.id, seq: 2, error: "log service forbidden", attempts: 1, resumed: "send" }]);
    expect(await unparkPolicyQueue(db, collectionId, { actor: "on-call", reason: "again" })).toEqual([]);
    expect(await unparkAudits(collectionId)).toEqual([{ ...resumed[0], reason: "log service fixed", actor: "on-call" }]);

    expect(await emitter.drainCollection(collectionId)).toBe(2);
    const log = service.logs.get(collectionId.replaceAll("-", ""))!;
    expect(log).toHaveLength(3);
    expect(log[1]!.equals(parked.item)).toBe(true);
    expect((await batches(collectionId)).map(batch => batch.state)).toEqual(["appended", "appended", "appended"]);
  });

  it("resumes a lost batch whose reissue could not be signed", async () => {
    const collectionId = await register();
    const emitter = new PolicyEmitter(db, client, signer);
    await emitter.drainCollection(collectionId);
    await queueNextPolicy(db, collectionId, [{ op: "grant-revoke", grant: randomUUID() }]);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(1);
    expect(await recoverLostPolicy(db, client, collectionId)).toBe(1);
    const expired = new PolicyEmitter(db, client, signer, () => undefined, 2_000, () => signer.cert.notAfter + 1);
    expect(await expired.drainCollection(collectionId)).toBe(0);
    expect(await batches(collectionId)).toEqual([{ seq: "1", state: "appended", attempts: 0, lost: false }, { seq: "2", state: "parked", attempts: 0, lost: true }]);

    const [resumed] = await unparkPolicyQueue(db, collectionId, { actor: "on-call", reason: "policy key renewed" });
    expect(resumed).toMatchObject({ seq: 2, resumed: "reissue" });
    expect(await batches(collectionId)).toEqual([{ seq: "1", state: "appended", attempts: 0, lost: false }, { seq: "2", state: "appended", attempts: 0, lost: true }]);
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    expect((await client.head(collectionId)).seq).toBe(2);
  });

  it("refuses to resume a lost batch it cannot send again unchanged", async () => {
    const collectionId = await register();
    const emitter = new PolicyEmitter(db, client, signer);
    await emitter.drainCollection(collectionId);
    service.logs.get(collectionId.replaceAll("-", ""))!.splice(0, 1, Buffer.from("a0", "hex"));
    expect(await recoverLostPolicy(db, client, collectionId)).toBe(0);
    await expect(unparkPolicyQueue(db, collectionId, { actor: "on-call", reason: "try" })).rejects.toThrow(/lost_genesis/);
    expect(await batches(collectionId)).toEqual([{ seq: "1", state: "parked", attempts: 0, lost: true }]);
    expect(await unparkAudits(collectionId)).toEqual([]);
  });

  it("reports parked and unsent work on /ready without failing readiness", async () => {
    const collectionId = await register();
    await db.query(
      "INSERT INTO next_policy_batches (collection_id, seq, prev, item, issued_at, state, created_at) VALUES ($1, 1, '\\x00', '\\x00', 1, 'parked', now() - interval '1 hour')",
      [collectionId]
    );
    const app = Fastify();
    registerSystemRoutes(app, { db, relay: { ready: async () => undefined }, hostedCollections: false, publicUrl: "http://connect.test",
      nextPolicyHealth: () => policyQueueHealth(db) });
    registerPolicyRecoveryRoutes(app, db, new PolicyEmitter(db, client, signer));
    try {
      const parked = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM next_policy_batches WHERE state = 'parked'")).rows[0]!.n);
      const ready = await app.inject({ url: "/ready" });
      expect(ready.statusCode).toBe(200);
      const body = ready.json();
      expect(body).toMatchObject({ ok: true, service: "mdbase-connect", next_policy: { parked_batches: parked } });
      expect(body.next_policy.oldest_unsent_seconds).toBeGreaterThanOrEqual(3_600);
    } finally { await app.close(); }
  });
});
