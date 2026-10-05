import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";
import { LOG_TOKEN_LIFETIME_MS, LogServiceClient } from "./log-service-client.js";
import { decodeCbor } from "./policy-wire.js";
import { loadServiceDevice, parseServiceDevice, ServiceDeviceError, storeServiceDevice } from "./service-devices.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

const hosted = "h".repeat(40);
const escrow = "e".repeat(40);
const NOW = 1_800_000_000_000;
const uuidBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");

function record(kind: "hosted" | "escrow", device = randomUUID(), fill = 1) {
  return parseServiceDevice({
    kind, device_id: device, sign_pk: Buffer.alloc(32, fill).toString("hex"), kem_pk: Buffer.alloc(32, fill + 1).toString("hex"),
    noise_pk: Buffer.alloc(32, fill + 2).toString("hex"), wrapped_keys: Buffer.from(`sealed-${kind}`).toString("base64"),
    kms_key_arn: `arn:aws:kms:eu-west-1:000000000000:key/${kind}`
  });
}

describePostgres("service devices", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();
  const issuer = generateKeyPairSync("ed25519");
  const owner = randomUUID();
  const ids = { standard: randomUUID(), private: randomUUID(), left: randomUUID(), barrier: randomUUID() };
  const devices = { hosted: record("hosted"), escrow: record("escrow", randomUUID(), 7), left: record("hosted", randomUUID(), 11), barrier: record("hosted", randomUUID(), 21) };

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Service device tests require a dedicated local test database.");
    schema = `mdbase_next_service_devices_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [owner, `${owner}@example.test`]);
    for (const [id, sync] of [[ids.standard, "cloud_copy"], [ids.private, "private"], [ids.left, "cloud_copy"], [ids.barrier, "cloud_copy"]]) {
      await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next',$3,$4)", [id, owner, sync, Buffer.alloc(16)]);
    }
    await storeServiceDevice(db, ids.standard, devices.hosted);
    await storeServiceDevice(db, ids.standard, devices.escrow);
    await storeServiceDevice(db, ids.left, devices.left);
    await storeServiceDevice(db, ids.barrier, devices.barrier);
    await db.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [ids.left]);
    const transport = generateKeyPairSync("ed25519").privateKey;
    const log = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      transportKeyPem: transport.export({ format: "pem", type: "pkcs8" }).toString() }, async () => { throw new Error("no network"); });
    registerNextHostedRoutes(app, { db, tokens: { hosted, escrow }, log, now: () => NOW });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("stores idempotently and refuses a different device for the same kind", async () => {
    await expect(storeServiceDevice(db, ids.standard, devices.hosted)).resolves.toMatchObject({ device_id: devices.hosted.device_id });
    await expect(storeServiceDevice(db, ids.standard, record("hosted"))).rejects.toMatchObject({ status: 409, code: "service_device_conflict" });
    await expect(storeServiceDevice(db, ids.standard, { ...devices.hosted, kms_key_arn: "arn:aws:kms:other" })).rejects.toBeInstanceOf(ServiceDeviceError);
    expect((await loadServiceDevice(db, ids.standard, { kind: "hosted" }))!.kms_key_arn).toBe(devices.hosted.kms_key_arn);
  });

  it("validates direct writes, and the table refuses malformed rows", async () => {
    const fresh = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [fresh, owner, Buffer.alloc(16)]);
    const good = record("hosted");
    for (const bad of [
      { ...good, sign_pk: good.sign_pk.subarray(0, 31) }, { ...good, kem_pk: Buffer.alloc(32) }, { ...good, wrapped_keys: Buffer.alloc(0) },
      { ...good, wrapped_keys: Buffer.alloc(65 * 1024) }, { ...good, kms_key_arn: "nope" }, { ...good, kind: "owner" as "hosted" },
      { ...good, noise_pk: Buffer.alloc(32) }
    ]) await expect(storeServiceDevice(db, fresh, bad)).rejects.toMatchObject({ code: "invalid_service_device" });
    const insert = (sign: Buffer, wrapped: Buffer) => db.query(
      "INSERT INTO next_service_devices(collection_id, kind, device_id, sign_pk, kem_pk, noise_pk, wrapped_keys, kms_key_arn) VALUES($1,'hosted',$2,$3,$4,$4,$5,'arn:x')",
      [fresh, randomUUID(), sign, Buffer.alloc(32, 9), wrapped]
    );
    await expect(insert(Buffer.alloc(31, 1), Buffer.alloc(1))).rejects.toThrow(/check constraint/i);
    await expect(insert(Buffer.alloc(32, 1), Buffer.alloc(0))).rejects.toThrow(/check constraint/i);
    await expect(insert(Buffer.alloc(32, 1), Buffer.alloc(65537))).rejects.toThrow(/check constraint/i);
    expect(await loadServiceDevice(db, fresh, { kind: "hosted" })).toBeNull();
  });

  it("serves nothing once a concurrent leave commits: the leave and the mint are ordered by the row lock", async () => {
    const leaving = await admin.connect();
    try {
      await leaving.query(`SET search_path = "${schema}"`);
      await leaving.query("BEGIN");
      await leaving.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [ids.barrier]);
      let settled = false;
      const mint = app.inject({ method: "POST", url: `/internal/v1/next/service-devices/${devices.barrier.device_id}/log-token`, headers: { authorization: `Bearer ${hosted}` }, payload: { collection: ids.barrier } })
        .finally(() => { settled = true; });
      const fetch = app.inject({ method: "GET", url: `/internal/v1/next/collections/${ids.barrier}/service-devices/hosted`, headers: { authorization: `Bearer ${hosted}` } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await leaving.query("COMMIT");
      expect((await mint).statusCode).toBe(409);
      expect((await fetch).statusCode).toBe(409);
    } finally {
      leaving.release();
    }
  });

  it("holds the collection row from the currentness check through the mint", async () => {
    // A pool whose transactions, just before COMMIT, check that a leave cannot take the row.
    const events: string[] = [];
    const probe: DatabasePool = {
      query: db.query.bind(db), end: async () => undefined,
      async connect() {
        const inner = await db.connect();
        return {
          async query(text: string, values?: unknown[]) {
            if (text === "COMMIT") {
              const other = await admin.connect();
              try {
                await other.query(`SET search_path = "${schema}"`);
                await other.query("BEGIN");
                await other.query("SET LOCAL lock_timeout = '100ms'");
                await other.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [ids.standard]);
                events.push("leave-acquired");
              } catch (error) {
                events.push(/lock timeout/i.test(String(error)) ? "leave-blocked" : String(error));
              } finally {
                await other.query("ROLLBACK").catch(() => undefined);
                other.release();
              }
            }
            return inner.query(text, values as never);
          },
          release: () => inner.release()
        } as Awaited<ReturnType<DatabasePool["connect"]>>;
      }
    };
    const probed = Fastify();
    const transport = generateKeyPairSync("ed25519").privateKey;
    const log = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      transportKeyPem: transport.export({ format: "pem", type: "pkcs8" }).toString() }, async () => { throw new Error("no network"); });
    const mint = log.mintToken.bind(log);
    log.mintToken = (claims) => { events.push("minted"); return mint(claims); };
    registerNextHostedRoutes(probed, { db: probe, tokens: { hosted, escrow }, log, now: () => NOW });
    const response = await probed.inject({ method: "POST", url: `/internal/v1/next/service-devices/${devices.hosted.device_id}/log-token`, headers: { authorization: `Bearer ${hosted}` }, payload: { collection: ids.standard } });
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toEqual(["minted", "leave-blocked"]);
    await probed.close();
  });

  it("admits service devices only for cloud-copy collections", async () => {
    await expect(storeServiceDevice(db, ids.private, record("hosted"))).rejects.toThrow(/foreign key/i);
    await expect(storeServiceDevice(db, randomUUID(), record("hosted"))).rejects.toThrow(/foreign key/i);
  });

  it("returns a deployment only its own kind's record while standard", async () => {
    const get = (id: string, kind: string, token: string) => app.inject({ method: "GET", url: `/internal/v1/next/collections/${id}/service-devices/${kind}`, headers: { authorization: `Bearer ${token}` } });
    const own = await get(ids.standard, "hosted", hosted);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ kind: "hosted", device_id: devices.hosted.device_id, sign_pk: devices.hosted.sign_pk.toString("hex"), wrapped_keys: devices.hosted.wrapped_keys.toString("base64") });
    expect((await get(ids.standard, "escrow", escrow)).json().device_id).toBe(devices.escrow.device_id);
    expect((await get(ids.standard, "escrow", hosted)).statusCode).toBe(403);
    expect((await get(ids.standard, "hosted", "x".repeat(40))).statusCode).toBe(401);
    expect((await get(ids.private, "hosted", hosted)).statusCode).toBe(409);
    expect((await get(ids.left, "hosted", hosted)).statusCode).toBe(409);
    expect((await get(randomUUID(), "hosted", hosted)).statusCode).toBe(409);
  });

  it("mints a role-0 collection-scoped log token for the caller's own device", async () => {
    const mint = (device: string, collection: string, token: string) => app.inject({ method: "POST", url: `/internal/v1/next/service-devices/${device}/log-token`, headers: { authorization: `Bearer ${token}` }, payload: { collection } });
    const response = await mint(devices.hosted.device_id, ids.standard, hosted);
    expect(response.statusCode, response.body).toBe(200);
    const { token, expires_at } = response.json() as { token: string; expires_at: number };
    expect(expires_at).toBe(NOW + LOG_TOKEN_LIFETIME_MS);
    const [claimsHex, signatureHex] = token.split(".");
    const claims = Buffer.from(claimsHex!, "hex");
    const tag = Buffer.from("mdbase/v1/ls-token");
    const digest = createHash("sha256").update(Buffer.concat([Buffer.of(tag.length), tag, claims])).digest();
    expect(verify(null, digest, issuer.publicKey, Buffer.from(signatureHex!, "hex"))).toBe(true);
    const decoded = decodeCbor(claims) as Map<number, unknown>;
    expect(decoded.get(0)).toBe(0);
    expect(Buffer.from(decoded.get(1) as Uint8Array)).toEqual(uuidBytes(devices.hosted.device_id));
    expect(Buffer.from(decoded.get(2) as Uint8Array)).toEqual(devices.hosted.sign_pk);
    expect(Buffer.from(decoded.get(5) as Uint8Array)).toEqual(uuidBytes(ids.standard));

    expect((await mint(devices.escrow.device_id, ids.standard, hosted)).statusCode).toBe(403);
    expect((await mint(devices.hosted.device_id, ids.standard, "x".repeat(40))).statusCode).toBe(401);
    expect((await mint(randomUUID(), ids.standard, hosted)).statusCode).toBe(404);
    expect((await mint(devices.left.device_id, ids.left, hosted)).statusCode).toBe(409);
    expect((await mint(devices.hosted.device_id, ids.private, hosted)).statusCode).toBe(409);
    const extra = await app.inject({ method: "POST", url: `/internal/v1/next/service-devices/${devices.hosted.device_id}/log-token`, headers: { authorization: `Bearer ${hosted}` }, payload: { collection: ids.standard, role: 1 } });
    expect(extra.statusCode).toBe(400);
  });
});
