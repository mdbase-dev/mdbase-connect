import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { tokenHash } from "../../security.js";
import { registerApprovalPeerRoutes } from "./approval-peer-routes.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { domainHash, encodeCbor, uuidBytes, deviceKindNumber, type RegisteredDeviceKind, type Cbor } from "./policy-wire.js";
import { queueApprovalPeer, readApprovalPeers } from "./approval-peer-store.js";
import { lock } from "./bootstrap-common.js";

const url = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = url && approved ? describe : describe.skip;
const schema = `approval_peer_test_${randomUUID().replaceAll("-", "")}`;
let db: DatabasePool, admin: pg.Pool;
const struct = (values: Cbor[]): Cbor => ({ struct: values.map((v, i) => [i, v]) });
type Actor = { kind: RegisteredDeviceKind; user_id: string; id: string; token: string; hash: string; keys: { publicKey: KeyObject; privateKey: KeyObject };
  sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer; connector: { id: string; user_id: string } };

suite("candidate peer metadata on actual PostgreSQL (not LS/applied policy)", () => {
  beforeAll(async () => {
    const u = new URL(url!);
    if (!["localhost", "127.0.0.1", "::1"].includes(u.hostname) || !/test/i.test(u.pathname)) throw new Error("Dedicated loopback test DB required.");
    admin = new pg.Pool({ connectionString: u.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    u.searchParams.set("options", `-csearch_path=${schema}`);
    u.searchParams.set("application_name", schema);
    db = await createDatabase(u.toString());
  }, 60_000);
  afterAll(async () => { await db?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); } });

  async function fixture(expiryOffset = 110_000, linked: { a?: Actor; n?: Actor } = {}, kind: RegisteredDeviceKind = "cli") {
    const collection = randomUUID();
    async function device() {
      const user_id = randomUUID(), connector_id = randomUUID(), id = randomUUID(), token = `TEST:${randomUUID()}`, hash = tokenHash(token);
      const keys = generateKeyPairSync("ed25519"), sign_pk = ed25519RawPublicKey(keys.publicKey);
      const kem_pk = randomBytes(32), noise_pk = randomBytes(32);
      await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'TEST')", [user_id, `${user_id}@example.test`]);
      await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'TEST',$3)", [connector_id, user_id, hash]);
      await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, connector_id, user_id, kind, sign_pk, kem_pk, noise_pk]);
      return { kind, user_id, id, token, hash, keys, sign_pk, kem_pk, noise_pk, connector: { id: connector_id, user_id } };
    }
    const a = linked.a ?? await device(), n = linked.n ?? await device();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','private',$3)", [collection, a.user_id, Buffer.alloc(16)]);
    // Explicit eligibility fixture only. No real LS/CP-signature/application claim.
    const batch = (await db.query<{ id: string }>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,0,'appended') RETURNING id", [collection, Buffer.alloc(32), Buffer.from([0])])).rows[0].id;
    const ops = [a, n].flatMap(d => [
      { op: "member-set", account: d.user_id, role: "owner" },
      { op: "device-enrol", device: d.id, account: d.user_id, kind: d.kind, signPublicKey: { $hex: d.sign_pk.toString("hex") }, kemPublicKey: { $hex: d.kem_pk.toString("hex") }, noisePublicKey: { $hex: d.noise_pk.toString("hex") } }
    ]);
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops,batch_id) VALUES($1,$2::jsonb,$3)", [collection, JSON.stringify({ ops }), batch]);
    const d = (x: typeof a) => struct([uuidBytes(x.id), uuidBytes(x.user_id), deviceKindNumber(x.kind), x.sign_pk, x.kem_pk, x.noise_pk]);
    const peerFor = (generation = randomBytes(32)) => {
      const body = struct([1, 0, struct([uuidBytes(collection), 1, d(a), d(n), randomBytes(32)]), generation, Date.now() + expiryOffset]);
      const signature = sign(null, domainHash("mdbase/v1/device-approval-peer", encodeCbor(body)), a.keys.privateKey);
      return encodeCbor(struct([body, signature]));
    };
    const generation = randomBytes(32), peer = peerFor(generation);
    const proof = async (actor: typeof a, ids?: string[], challengeLifetime = 60_000) => {
      const challenge = randomBytes(32);
      await db.query("INSERT INTO next_device_challenges(challenge,connector_id,expires_at) VALUES($1,$2,$3)", [challenge, actor.connector.id, new Date(Date.now() + challengeLifetime)]);
      const fields = [challenge, uuidBytes(actor.connector.id), uuidBytes(actor.id), uuidBytes(collection)];
      const digest = domainHash(ids ? "mdbase/v1/device-approval-peer-ack" : "mdbase/v1/device-approval-peer-inbox", encodeCbor(ids ? [...fields, ids.map(uuidBytes)] : fields));
      return { device_id: actor.id, challenge: challenge.toString("hex"), sig: sign(null, digest, actor.keys.privateKey).toString("hex") };
    };
    return { a, n, collection, generation, peer, peerFor, proof };
  }
  async function expectAdvisoryWait(count = 1) {
    for (let i = 0; i < 100; i++) {
      if (Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'", [schema])).rows[0].count) === count) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Expected ${count} actual PostgreSQL advisory waiters.`);
  }
  it.each(["mobile", "app-runtime"] as const)("retains exact numeric %s kind for peer origin and enrolment", async kind => {
    const f = await fixture(110_000, {}, kind);
    const queued = await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer);
    const inbox = await readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, await f.proof(f.n));
    expect(inbox.messages).toEqual([{ id: queued.id, peer: Buffer.from(f.peer).toString("base64url") }]);
    await db.query("UPDATE next_devices SET kind = 'cli' WHERE id = $1", [f.a.id]);
    await expect(queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peerFor())).rejects.toMatchObject({ code: "peer_not_current" });
  });
  it("deduplicates opaque bytes and retains consumed identity instead of resurrecting after ACK", async () => {
    const f = await fixture();
    const first = await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer);
    expect(await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer)).toEqual(first);
    const inbox = await readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, await f.proof(f.n));
    expect(inbox.messages).toEqual([{ id: first.id, peer: Buffer.from(f.peer).toString("base64url") }]);
    expect((await readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, await f.proof(f.n, [first.id]), [first.id])).acknowledged).toBe(1);
    expect(await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer)).toEqual(first);
    expect((await readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, await f.proof(f.n))).messages).toEqual([]);
    expect(Number((await db.query("SELECT count(*) FROM next_device_approval_peers WHERE collection_id=$1", [f.collection])).rows[0].count)).toBe(1);
  });
  it("does not replace a retained generation with different signed bytes", async () => {
    const f = await fixture();
    const first = await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer);
    await expect(queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peerFor(f.generation)))
      .rejects.toMatchObject({ code: "peer_conflict" });
    expect(await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer)).toEqual(first);
  });
  it("keeps ACKed identities charged through expiry and refuses the seventeenth generation", async () => {
    const f = await fixture(), ids: string[] = [];
    for (let i = 0; i < 16; i++) ids.push((await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peerFor())).id);
    expect((await readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, await f.proof(f.n, ids), ids)).acknowledged).toBe(16);
    expect((await readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, await f.proof(f.n))).messages).toEqual([]);
    await expect(queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peerFor())).rejects.toMatchObject({ code: "peer_capacity" });
    expect(Number((await db.query("SELECT count(*) FROM next_device_approval_peers WHERE collection_id=$1", [f.collection])).rows[0].count)).toBe(16);
  });
  it.each(["sent", "received"] as const)("serializes the last global %s slot across different collections", async direction => {
    const f = await fixture(), other = await fixture(110_000, direction === "sent" ? { a: f.a } : { n: f.n });
    for (let i = 0; i < 15; i++) await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peerFor());
    const column = direction === "sent" ? "sender_device" : "recipient_device", device = direction === "sent" ? f.a.id : f.n.id;
    const hash = createHash("sha256").update(`mdbase/v1/device-approval-peer-queue\0${device}`).digest(), blocker = await db.connect();
    let pending: Promise<PromiseSettledResult<{ id: string; outcome: "queued" }>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1, $2)", [hash.readInt32BE(0), hash.readInt32BE(4)]);
      pending = Promise.allSettled([f, other].map(x => queueApprovalPeer(db, x.a.connector, x.a.hash, x.collection, x.peerFor())));
      await expectAdvisoryWait(2); // Both different-collection writers reached the shared device gate.
      await blocker.query("COMMIT");
      const results = await pending;
      expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
      const denied = results.find(x => x.status === "rejected");
      expect(denied?.status === "rejected" ? denied.reason : null).toMatchObject({ code: "peer_capacity" });
      expect(Number((await db.query(`SELECT count(*) FROM next_device_approval_peers WHERE ${column}=$1`, [device])).rows[0].count)).toBe(16);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending; }
  });
  it("serves fixed loopback HTTP peer/inbox/ACK with real bearer and exact ACK signature binding", async () => {
    const f = await fixture(), app = Fastify();
    registerApprovalPeerRoutes(app, db);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `${origin}/v1/next/collections/${f.collection}/device-approval`;
    const post = (action: string, token: string, body: unknown) => fetch(`${base}/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post("peer", "wrong", { peer: Buffer.from(f.peer).toString("base64url") })).status).toBe(401);
      const accepted = await post("peer", f.a.token, { peer: Buffer.from(f.peer).toString("base64url") });
      expect(accepted.status).toBe(200);
      const first = await accepted.json() as { id: string };
      const inbox = await post("inbox", f.n.token, await f.proof(f.n));
      expect(inbox.status).toBe(200);
      expect(inbox.headers.get("cache-control")).toBe("no-store");
      expect((await inbox.json()).messages).toEqual([{ id: first.id, peer: Buffer.from(f.peer).toString("base64url") }]);
      const p = await f.proof(f.n, [first.id]);
      expect((await post("ack", f.n.token, { ...p, ids: [randomUUID()] })).status).toBe(403);
      const ack = await post("ack", f.n.token, { ...p, ids: [first.id] });
      expect(ack.status).toBe(200);
      expect(await ack.json()).toEqual({ messages: [], acknowledged: 1 });
    } finally { await app.close(); }
  });

  it("refuses another paired connector, changed credential and another collection", async () => {
    const f = await fixture();
    await expect(queueApprovalPeer(db, f.n.connector, f.n.hash, f.collection, f.peer)).rejects.toMatchObject({ code: "invalid_peer_origin" });
    await expect(queueApprovalPeer(db, f.a.connector, randomUUID(), f.collection, f.peer)).rejects.toMatchObject({ code: "identity_not_current" });
    await expect(queueApprovalPeer(db, f.a.connector, f.a.hash, randomUUID(), f.peer)).rejects.toThrow("Invalid signed approval peer metadata.");
  });
  it.each(["revocation", "expiry"])("refuses %s while send waits on a real CP collection lock", async kind => {
    const f = await fixture(kind === "expiry" ? 250 : 110_000), blocker = await db.connect();
    try {
      await blocker.query("BEGIN"); await lock(blocker, f.collection);
      const pending = queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer)
        .then(() => null, (error: unknown) => error);
      await expectAdvisoryWait();
      if (kind === "expiry") await new Promise(resolve => setTimeout(resolve, 300));
      else await db.query("UPDATE connectors SET revoked_at=clock_timestamp() WHERE id=$1", [f.a.connector.id]);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: kind === "expiry" ? "peer_expired" : "peer_not_current" });
      expect(Number((await db.query("SELECT count(*) FROM next_device_approval_peers WHERE collection_id=$1", [f.collection])).rows[0].count)).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it.each(["challenge-expiry", "recipient-revocation"])("refuses %s while inbox waits on a real CP collection lock", async kind => {
    const f = await fixture();
    await queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer);
    const proof = await f.proof(f.n, undefined, kind === "challenge-expiry" ? 250 : 60_000), blocker = await db.connect();
    try {
      await blocker.query("BEGIN"); await lock(blocker, f.collection);
      const pending = readApprovalPeers(db, f.n.connector, f.n.hash, f.collection, proof)
        .then(() => null, (error: unknown) => error);
      await expectAdvisoryWait();
      if (kind === "challenge-expiry") await new Promise(resolve => setTimeout(resolve, 300));
      else await db.query("UPDATE connectors SET revoked_at=clock_timestamp() WHERE id=$1", [f.n.connector.id]);
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ code: kind === "challenge-expiry" ? "invalid_proof" : "identity_not_current" });
      expect((await db.query("SELECT used_at FROM next_device_challenges WHERE challenge=$1", [Buffer.from(proof.challenge, "hex")])).rows[0].used_at).toBeNull();
      expect((await db.query("SELECT acknowledged_at FROM next_device_approval_peers WHERE collection_id=$1", [f.collection])).rows[0].acknowledged_at).toBeNull();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  it("refuses pending membership removal and pending device revocation", async () => {
    const f = await fixture();
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2::jsonb)", [f.collection, JSON.stringify({ ops: [{ op: "member-remove", account: f.n.user_id }] })]);
    await expect(queueApprovalPeer(db, f.a.connector, f.a.hash, f.collection, f.peer)).rejects.toMatchObject({ code: "not_member" });
    const other = await fixture();
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2::jsonb)", [other.collection, JSON.stringify({ ops: [{ op: "device-revoke", device: other.n.id }] })]);
    await expect(queueApprovalPeer(db, other.a.connector, other.a.hash, other.collection, other.peer)).rejects.toMatchObject({ code: "device_revoked" });
  });
});
