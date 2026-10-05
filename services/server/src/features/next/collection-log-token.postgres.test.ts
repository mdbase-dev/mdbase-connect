import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { collectionLogTokenDigest, registerCollectionLogTokenRoute } from "./collection-log-token.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { LOG_TOKEN_LIFETIME_MS, LogServiceClient } from "./log-service-client.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { decodeCbor, type Decoded } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const field = (v: Decoded, k: number) => (v instanceof Map ? v.get(k) : undefined);
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const NOW = 1_800_000_000_000;
const ROOT = Buffer.alloc(16, 3);

describePg("collection log-token refresh", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const issuer = generateKeyPairSync("ed25519");
  const app = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("dedicated local test Postgres only");
    schema = `log_token_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    const transport = generateKeyPairSync("ed25519").privateKey;
    const log = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      transportKeyPem: transport.export({ format: "pem", type: "pkcs8" }).toString() }, async () => { throw new Error("no network"); });
    registerCollectionLogTokenRoute(app, { db, log, now: () => NOW });
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
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'U') ON CONFLICT DO NOTHING", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Daemon',$3)", [connector.id, user, tokenHash(token)]);
    const reg = await issueDeviceChallenge(db, connector.id);
    await registerDevice(db, connector, {
      device_id: device, kind: "desktop", sign_pk: hex(signPk), kem_pk: hex(kemPk), noise_pk: hex(noisePk), challenge: reg.challenge,
      sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(reg.challenge, "hex"), connectorId: connector.id, deviceId: device, signPk, kemPk, noisePk }), key))
    });
    return { connector, device, key, signPk, kemPk, noisePk, headers: { authorization: `Bearer ${token}` } };
  }
  type Who = Awaited<ReturnType<typeof identity>>;
  const enrol = (who: Who, kemPk = who.kemPk) => ({
    op: "device-enrol" as const, device: who.device, account: who.connector.user_id, kind: "desktop" as const,
    signPublicKey: who.signPk, kemPublicKey: kemPk, noisePublicKey: who.noisePk
  });

  /** A synced collection owned by `owner` whose genesis enrols `who`; appended unless told otherwise. */
  async function collection(owner: Who, sync: "private" | "cloud_copy", who: Who[], appended = true) {
    const c = randomUUID();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await registerNextCollection(client, {
        collectionId: c, ownerUserId: owner.connector.user_id, runtime: "next", sync, rootKeyId: ROOT,
        ops: [
          { op: "genesis", owner: owner.connector.user_id, root: ROOT, state: sync === "private" ? "e2e" : "cloud-copy" },
          { op: "member-set", account: owner.connector.user_id, role: "owner" },
          ...who.filter((w) => w.connector.user_id !== owner.connector.user_id).map((w) => ({ op: "member-set" as const, account: w.connector.user_id, role: "editor" as const })),
          ...who.map((w) => enrol(w))
        ]
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    if (appended) await appendPending(c);
    return c;
  }
  /** Mark every queued outbox row of `c` as appended in one batch (what the emitter does). */
  async function appendPending(c: string) {
    const seq = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM next_policy_batches WHERE collection_id = $1", [c])).rows[0]!.n) + 1;
    const b = await db.query<{ id: string }>(
      "INSERT INTO next_policy_batches(collection_id, seq, prev, item, issued_at, state, appended_at) VALUES($1,$2,$3,$4,$5,'appended',now()) RETURNING id",
      [c, seq, Buffer.alloc(32), Buffer.from([seq]), seq]
    );
    await db.query("UPDATE next_policy_outbox SET batch_id = $1 WHERE collection_id = $2 AND batch_id IS NULL", [b.rows[0]!.id, c]);
  }
  async function proof(who: Who, c: string) {
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const digest = collectionLogTokenDigest({ challenge: Buffer.from(challenge, "hex"), connector: who.connector.id, device: who.device, collection: c });
    return { device_id: who.device, challenge, sig: hex(sign(null, digest, who.key)) };
  }
  const refresh = (who: Who, c: string, payload: unknown, headers = who.headers) =>
    app.inject({ method: "POST", url: `/v1/next/collections/${c}/log-token`, headers, payload });

  it("refreshes a role-0 token, scoped to the collection, for an acknowledged enrolment (private and cloud copy)", async () => {
    for (const sync of ["private", "cloud_copy"] as const) {
      const who = await identity();
      const c = await collection(who, sync, [who]);
      const r = await refresh(who, c, await proof(who, c));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const body = r.json();
      expect(Object.keys(body).sort()).toEqual(["expires_at", "token"]);
      expect(body.expires_at).toBe(NOW + LOG_TOKEN_LIFETIME_MS);
      const [claimsHex, sigHex] = body.token.split(".");
      const claims = Buffer.from(claimsHex, "hex");
      const tag = Buffer.from("mdbase/v1/ls-token");
      const digest = createHash("sha256").update(Buffer.concat([Buffer.of(tag.length), tag, claims])).digest();
      expect(verify(null, digest, issuer.publicKey, Buffer.from(sigHex, "hex"))).toBe(true);
      const d = decodeCbor(claims);
      expect(field(d, 0)).toBe(0);
      expect(hex(field(d, 1) as Uint8Array)).toBe(who.device.replaceAll("-", ""));
      expect(Buffer.from(field(d, 2) as Uint8Array)).toEqual(who.signPk);
      expect(hex(field(d, 5) as Uint8Array)).toBe(c.replaceAll("-", ""));
    }
  });

  it("a member's own enrolled device refreshes; a device enrolled for another account does not", async () => {
    const owner = await identity(); const member = await identity();
    const c = await collection(owner, "private", [owner, member]);
    expect((await refresh(member, c, await proof(member, c))).statusCode).toBe(200);
    const stranger = await identity();
    expect((await refresh(stranger, c, await proof(stranger, c))).statusCode).toBe(409);
  });

  it("refuses a pending (unacknowledged) enrolment, a changed key tuple, a revocation and a left collection", async () => {
    const who = await identity();
    const pending = await collection(who, "cloud_copy", [who], false);
    expect((await refresh(who, pending, await proof(who, pending))).json().error.code).toBe("not_enrolled");
    const changed = await collection(who, "cloud_copy", [who]);
    await db.query("UPDATE next_devices SET kem_pk = $2 WHERE id = $1", [who.device, rawX()]);
    expect((await refresh(who, changed, await proof(who, changed))).json().error.code).toBe("not_enrolled");
    const other = await identity();
    const revoked = await collection(other, "private", [other]);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await queueNextPolicy(client, revoked, [{ op: "device-revoke", device: other.device }]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await refresh(other, revoked, await proof(other, revoked))).json().error.code).toBe("device_revoked");
    const third = await identity();
    const left = await collection(third, "cloud_copy", [third]);
    await db.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [left]);
    expect((await refresh(third, left, await proof(third, left))).json().error.code).toBe("not_current");
  });

  it("needs connector auth and a fresh proof in its own domain, bound to the collection; nil IDs refused", async () => {
    const who = await identity();
    const c = await collection(who, "private", [who]);
    const payload = await proof(who, c);
    expect((await refresh(who, c, payload, {})).statusCode).toBe(401);
    const other = await collection(who, "private", [who]);
    expect((await refresh(who, other, payload)).statusCode).toBe(403);
    // Another domain over the same fields (the device-registration digest) is refused.
    const { challenge } = await issueDeviceChallenge(db, who.connector.id);
    const wrongDomain = sign(null, deviceRegistrationDigest({ challenge: Buffer.from(challenge, "hex"), connectorId: who.connector.id, deviceId: who.device, signPk: who.signPk, kemPk: who.kemPk, noisePk: who.noisePk }), who.key);
    expect((await refresh(who, c, { device_id: who.device, challenge, sig: hex(wrongDomain) })).statusCode).toBe(403);
    expect((await refresh(who, c, payload)).statusCode).toBe(200);
    expect((await refresh(who, c, payload)).statusCode).toBe(403);
    const nil = "00000000-0000-0000-0000-000000000000";
    expect((await refresh(who, nil, await proof(who, nil))).statusCode).toBe(400);
  });

  it("refuses a revoked connector or suspended account", async () => {
    const who = await identity();
    const c = await collection(who, "cloud_copy", [who]);
    const p = await proof(who, c);
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [who.connector.user_id]);
    expect((await refresh(who, c, p)).statusCode).toBe(401);
  });

  it("needs current membership: a removed member's device gets nothing until re-added and acknowledged", async () => {
    const owner = await identity(); const member = await identity();
    const c = await collection(owner, "cloud_copy", [owner, member]);
    expect((await refresh(member, c, await proof(member, c))).statusCode).toBe(200);
    const queue = async (ops: Parameters<typeof queueNextPolicy>[2]) => {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await queueNextPolicy(client, c, ops);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    await queue([{ op: "member-remove", account: member.connector.user_id }]);
    expect((await refresh(member, c, await proof(member, c))).json().error.code).toBe("not_member");
    await appendPending(c);
    expect((await refresh(member, c, await proof(member, c))).json().error.code).toBe("not_member");
    await queue([{ op: "member-set", account: member.connector.user_id, role: "editor" }]);
    expect((await refresh(member, c, await proof(member, c))).json().error.code).toBe("not_member");
    await appendPending(c);
    expect((await refresh(member, c, await proof(member, c))).statusCode).toBe(200);
    expect((await refresh(owner, c, await proof(owner, c))).statusCode).toBe(200);
  });

  it("refuses a collection not served by the next runtime", async () => {
    const who = await identity();
    const c = await collection(who, "cloud_copy", [who]);
    await db.query("UPDATE next_collections SET runtime = 'shadow' WHERE collection_id = $1", [c]);
    expect((await refresh(who, c, await proof(who, c))).json().error.code).toBe("not_current");
  });
});

