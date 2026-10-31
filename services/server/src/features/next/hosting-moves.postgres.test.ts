import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerNextHostedRoutes } from "./hosted-routes.js";
import { HOSTING_MOVE_FENCE_MS, registerHostingMoveRoutes } from "./hosting-moves.js";
import { LogServiceClient } from "./log-service-client.js";
import type { MigrationRouting } from "./migration-routing.js";
import { migrationRoute } from "./migration-routing.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { certDigest, keyId, signPolicyItem } from "./policy-wire.js";
import { parseServiceDevice, storeServiceDevice } from "./service-devices.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

const NOW = 1_800_000_000_000;
const MIGRATION_ARN = "arn:aws:kms:ap-southeast-1:000000000000:key/11111111-1111-4111-8111-111111111111";
const CP_ARN = "arn:aws:kms:ap-southeast-1:000000000000:key/22222222-2222-4222-8222-222222222222";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const operator = "o".repeat(40), cpHosted = "h".repeat(40);
const cpDeployment = { url: "https://cp-hosted.example.test", token: "c".repeat(40) };

const originRoot = generateKeyPairSync("ed25519"), originPolicy = generateKeyPairSync("ed25519");
const originUnsigned = { policyPublicKey: ed25519RawPublicKey(originPolicy.publicKey), notBefore: NOW - 1000, notAfter: NOW + 1000, root: keyId(ed25519RawPublicKey(originRoot.publicKey)) };
const originSigner = { privateKey: originPolicy.privateKey, cert: { ...originUnsigned, signature: sign(null, certDigest(originUnsigned), originRoot.privateKey) } };

/** MDBK v1 AWS-KMS envelope (hosted-worker custody/envelope.ts) with synthetic ciphertext. */
function envelope(arn: string, fill: number): string {
  const reference = Buffer.from(arn), ciphertext = Buffer.alloc(48, fill), header = Buffer.alloc(12);
  header.write("MDBK", 0, "latin1"); header[4] = 1; header[5] = 1;
  header.writeUInt16BE(reference.length, 6); header.writeUInt32BE(ciphertext.length, 8);
  return Buffer.concat([header, reference, ciphertext]).toString("base64");
}

describePostgres("hosting moves (real Postgres)", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const owner = randomUUID();
  const routing: MigrationRouting = { environment: "lab", accounts: new Set([owner]),
    hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "m".repeat(40) }, inboundToken: "i".repeat(40) };
  const app = Fastify();
  // CP hosted deployment answers verify; the deployment being left answers the release.
  let activation: () => Response = () => Response.json({ activated: true });
  let release: () => Response = () => Response.json({ error: "custody_collection_not_allowed" }, { status: 409 });
  const woken: Request[] = [];
  let releasingCp = false;

  async function migrated({ legacy = true, arn = MIGRATION_ARN }: { legacy?: boolean; arn?: string } = {}) {
    const collection = randomUUID(), device = randomUUID(), wrapped = envelope(arn, 1);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [collection, owner, Buffer.from(originUnsigned.root)]);
    if (legacy) await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Migrated','mdbase')", [collection, owner]);
    await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,1,$2,$3,$4,'appended')", [collection, Buffer.alloc(32),
      Buffer.from(signPolicyItem(originSigner, { collection, seq: 1, prev: Buffer.alloc(32), issuedAt: NOW, previousIssuedAt: 0, ops: [{ op: "genesis", owner, root: originUnsigned.root, state: "cloud-copy" }] })), NOW]);
    await storeServiceDevice(db, collection, parseServiceDevice({ kind: "hosted", device_id: device, sign_pk: "03".repeat(32), kem_pk: "04".repeat(32),
      noise_pk: "05".repeat(32), wrapped_keys: wrapped, kms_key_arn: arn }));
    const step = (name: string, payload: object = {}) => app.inject({ method: "POST", url: `/internal/v1/next/migration/hosting-moves/${collection}/${name}`,
      headers: { authorization: `Bearer ${operator}` }, payload });
    const status = async () => (await app.inject({ method: "GET", url: `/internal/v1/next/migration/hosting-moves/${collection}`, headers: { authorization: `Bearer ${operator}` } })).json();
    const mint = (token: string) => app.inject({ method: "POST", url: `/internal/v1/next/service-devices/${device}/log-token`, headers: { authorization: `Bearer ${token}` }, payload: { collection } });
    const record = (token: string) => app.inject({ method: "GET", url: `/internal/v1/next/collections/${collection}/service-devices/hosted`, headers: { authorization: `Bearer ${token}` } });
    const mark = () => step("mark", { from_kms_key_arn_sha256: sha(MIGRATION_ARN), to_kms_key_arn_sha256: sha(CP_ARN) });
    const fenced = () => db.query("UPDATE next_hosting_moves SET moving_at = now() - make_interval(secs => $2) WHERE collection_id = $1", [collection, HOSTING_MOVE_FENCE_MS / 1000 + 1]);
    return { collection, device, wrapped, step, status, mint, record, mark, fenced };
  }

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Hosting move tests require a dedicated local test database.");
    schema = `mdbase_hosting_moves_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [owner, `${owner}@example.test`]);
    const issuer = generateKeyPairSync("ed25519"), transport = generateKeyPairSync("ed25519").privateKey;
    const log = new LogServiceClient({ url: "https://log.example.test", tokenIssuerKeyPem: issuer.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      transportKeyPem: transport.export({ format: "pem", type: "pkcs8" }).toString() }, async () => { throw new Error("no network"); });
    registerNextHostedRoutes(app, { db, tokens: { hosted: cpHosted }, log, now: () => NOW, migrationRouting: routing });
    registerHostingMoveRoutes(app, { db, token: operator, routing, hosted: cpDeployment, fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      woken.push(request);
      return request.url.startsWith(cpDeployment.url) && !releasingCp ? activation() : release();
    } });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("moves a collection: refuses both Workers while moving, waits out the fence, CAS-stores, then serves only the CP", async () => {
    const m = await migrated();
    expect(await migrationRoute(db, routing, m.collection)).toBe("migration");
    expect((await m.mint(routing.inboundToken)).statusCode).toBe(200);

    // The migration Worker has not dropped its engine yet: the mark holds, unreleased.
    release = () => new Response("busy", { status: 503 });
    const marked = await m.mark();
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json()).toMatchObject({ state: "moving", from_kms_key_arn_sha256: sha(MIGRATION_ARN), to_kms_key_arn_sha256: sha(CP_ARN),
      fence_elapsed: false, released: false, record: { device_id: m.device, kms_key_arn: MIGRATION_ARN, wrapped_keys: m.wrapped } });
    expect(woken.at(-1)!.url).toBe(`${routing.hosted.url}/internal/v1/collections/activate`);
    expect(woken.at(-1)!.headers.get("authorization")).toBe(`Bearer ${routing.hosted.token}`);
    expect(Date.parse(marked.json().fence_at) - Date.parse(marked.json().moving_at)).toBe(HOSTING_MOVE_FENCE_MS);
    // A repeated mark is idempotent, does not restart the fence, and releases again.
    release = () => Response.json({ error: "custody_collection_not_allowed" }, { status: 409 });
    const again = (await m.mark()).json();
    expect(again).toMatchObject({ moving_at: marked.json().moving_at, released: true });
    const wakes = woken.length;
    expect((await m.mark()).json().released).toBe(true);
    expect(woken.length).toBe(wakes);
    expect((await m.step("mark", { from_kms_key_arn_sha256: sha(MIGRATION_ARN), to_kms_key_arn_sha256: sha("arn:aws:kms:other") })).json().error.code).toBe("hosting_move_conflict");
    expect(await migrationRoute(db, routing, m.collection)).toBe("moving");
    for (const token of [routing.inboundToken, cpHosted]) {
      expect((await m.mint(token)).statusCode).toBe(403);
      expect((await m.record(token)).statusCode).toBe(403);
    }

    const store = { expected: { wrapped_keys: m.wrapped, kms_key_arn: MIGRATION_ARN }, record: { wrapped_keys: envelope(CP_ARN, 2), kms_key_arn: CP_ARN } };
    expect((await m.step("store", store)).json().error.code).toBe("hosting_move_fence_pending");
    await m.fenced();
    expect((await m.status()).fence_elapsed).toBe(true);
    // CAS conflict: the record changed since it was read.
    expect((await m.step("store", { ...store, expected: { ...store.expected, wrapped_keys: envelope(MIGRATION_ARN, 9) } })).json().error.code).toBe("hosting_move_record_changed");
    // Only the move's own two keys, and an envelope naming the stored ARN.
    const stray = "arn:aws:kms:ap-southeast-1:000000000000:key/33333333-3333-4333-8333-333333333333";
    expect((await m.step("store", { ...store, record: { wrapped_keys: envelope(stray, 2), kms_key_arn: stray } })).json().error.code).toBe("hosting_move_unknown_key");
    expect((await m.step("store", { ...store, record: { wrapped_keys: envelope(MIGRATION_ARN, 2), kms_key_arn: CP_ARN } })).statusCode).toBe(400);
    expect((await m.step("verify")).json().error.code).toBe("hosting_move_not_moved");

    const stored = await m.step("store", store);
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json()).toMatchObject({ state: "moved", record: { device_id: m.device, kms_key_arn: CP_ARN, wrapped_keys: store.record.wrapped_keys } });
    // A retried store after commit refuses rather than re-applying.
    expect((await m.step("store", store)).json().error.code).toBe("hosting_move_not_moving");
    expect(await migrationRoute(db, routing, m.collection)).toBe("default");
    expect((await m.mint(routing.inboundToken)).statusCode).toBe(403);
    expect((await m.mint(cpHosted)).statusCode).toBe(200);
    expect((await m.record(cpHosted)).json()).toMatchObject({ device_id: m.device, kms_key_arn: CP_ARN });

    const verified = await m.step("verify");
    expect(verified.json()).toEqual({ activated: true });
    expect(woken.at(-1)!.url).toBe(`${cpDeployment.url}/internal/v1/collections/activate`);
    expect(woken.at(-1)!.headers.get("authorization")).toBe(`Bearer ${cpDeployment.token}`);
    expect(await woken.at(-1)!.json()).toEqual({ collection: m.collection });
    activation = () => Response.json({ error: "custody_collection_not_allowed" }, { status: 409 });
    expect((await m.step("verify")).json().error.code).toBe("custody_collection_not_allowed");
    activation = () => new Response("busy", { status: 503 });
    expect((await m.step("verify")).statusCode).toBe(503);
    activation = () => Response.json({ activated: true });
    expect((await m.step("clear")).json().error.code).toBe("hosting_move_moved");
  });

  it("refuses to mark a collection that is not migration-routed or not on the source key, and stores only after a release", async () => {
    const native = await migrated({ legacy: false });
    expect(await migrationRoute(db, routing, native.collection)).toBe("default");
    expect((await native.mark()).json().error.code).toBe("hosting_move_not_migration_routed");
    const retired = await migrated();
    await db.query("INSERT INTO next_migration_routing_retirements(collection_id, actor, reason) VALUES($1, 'test', 'test')", [retired.collection]);
    expect((await retired.mark()).json().error.code).toBe("hosting_move_not_migration_routed");
    const elsewhere = await migrated({ arn: "arn:aws:kms:ap-southeast-1:000000000000:key/33333333-3333-4333-8333-333333333333" });
    expect((await elsewhere.mark()).json().error.code).toBe("hosting_move_wrong_key");
    expect((await elsewhere.step("mark", { from_kms_key_arn_sha256: sha(CP_ARN), to_kms_key_arn_sha256: sha(CP_ARN) })).statusCode).toBe(400);
    for (const m of [native, retired, elsewhere]) expect((await m.status()).state).toBeNull();

    // An activation the Worker accepted (it still minted) or did not answer is no release.
    const m = await migrated();
    release = () => Response.json({ activated: true });
    expect((await m.mark()).json().released).toBe(false);
    await m.fenced();
    const store = { expected: { wrapped_keys: m.wrapped, kms_key_arn: MIGRATION_ARN }, record: { wrapped_keys: envelope(CP_ARN, 2), kms_key_arn: CP_ARN } };
    expect((await m.step("store", store)).json().error.code).toBe("hosting_move_not_released");
    release = () => Response.json({ error: "custody_collection_gone" }, { status: 409 });
    expect((await m.mark()).json().released).toBe(true);
    expect((await m.step("store", store)).json()).toMatchObject({ state: "moved" });
    release = () => Response.json({ error: "custody_collection_not_allowed" }, { status: 409 });
  });

  it("reverses after re-wrap with a fresh fence, returning the collection to the migration Worker", async () => {
    const m = await migrated();
    await m.mark();
    await m.fenced();
    const moved = { wrapped_keys: envelope(CP_ARN, 2), kms_key_arn: CP_ARN };
    expect((await m.step("store", { expected: { wrapped_keys: m.wrapped, kms_key_arn: MIGRATION_ARN }, record: moved })).statusCode).toBe(200);

    // The reverse releases the CP deployment, the one the collection is now leaving.
    releasingCp = true;
    const reversed = await m.step("reverse");
    releasingCp = false;
    expect(reversed.json()).toMatchObject({ state: "moving", fence_elapsed: false, released: true, record: { kms_key_arn: CP_ARN } });
    expect(woken.at(-1)!.url).toBe(`${cpDeployment.url}/internal/v1/collections/activate`);
    expect((await m.mint(cpHosted)).statusCode).toBe(403);
    const back = { expected: moved, record: { wrapped_keys: envelope(MIGRATION_ARN, 3), kms_key_arn: MIGRATION_ARN } };
    expect((await m.step("store", back)).json().error.code).toBe("hosting_move_fence_pending");
    await m.fenced();
    const restored = await m.step("store", back);
    expect(restored.json()).toMatchObject({ state: null, record: { kms_key_arn: MIGRATION_ARN } });
    expect(await migrationRoute(db, routing, m.collection)).toBe("migration");
    expect((await m.mint(routing.inboundToken)).statusCode).toBe(200);
    expect((await m.step("reverse")).json().error.code).toBe("hosting_move_not_found");
  });

  it("clears a mark by the record's key: back to the migration Worker before re-wrap, on to the CP after", async () => {
    const before = await migrated();
    await before.mark();
    expect((await before.step("clear")).json()).toMatchObject({ state: null });
    expect(await migrationRoute(db, routing, before.collection)).toBe("migration");
    expect((await before.step("clear")).statusCode).toBe(200);

    const after = await migrated();
    await after.mark();
    await after.fenced();
    const moved = { wrapped_keys: envelope(CP_ARN, 2), kms_key_arn: CP_ARN };
    await after.step("store", { expected: { wrapped_keys: after.wrapped, kms_key_arn: MIGRATION_ARN }, record: moved });
    await after.step("reverse");
    // An abandoned reverse: the record still names the CP key, so clear routes to the CP.
    expect((await after.step("clear")).json()).toMatchObject({ state: "moved" });
    expect(await migrationRoute(db, routing, after.collection)).toBe("default");
  });

  it("inventories hosted devices by key and lists one key's collections with move state", async () => {
    const pending = await migrated(), marked = await migrated();
    await marked.mark();
    const get = (query = "") => app.inject({ method: "GET", url: `/internal/v1/next/migration/hosting-moves${query}`, headers: { authorization: `Bearer ${operator}` } });
    const { groups } = (await get()).json();
    expect(groups.find((group: { kms_key_arn: string }) => group.kms_key_arn === MIGRATION_ARN)).toMatchObject({ kms_key_arn_sha256: sha(MIGRATION_ARN), moving: 1 });
    expect(groups.find((group: { kms_key_arn: string }) => group.kms_key_arn === CP_ARN)).toMatchObject({ kms_key_arn_sha256: sha(CP_ARN) });
    const listed = (await get(`?kms_key_arn_sha256=${sha(MIGRATION_ARN)}`)).json().collections;
    expect(listed).toContainEqual({ collection_id: pending.collection, kms_key_arn_sha256: sha(MIGRATION_ARN), state: null, current: true });
    expect(listed).toContainEqual({ collection_id: marked.collection, kms_key_arn_sha256: sha(MIGRATION_ARN), state: "moving", current: true });
    // Moved collections (now on the CP key) stay listed through their move row.
    expect(listed.some((row: { kms_key_arn_sha256: string; state: string }) => row.kms_key_arn_sha256 === sha(CP_ARN) && row.state === "moved")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/internal/v1/next/migration/hosting-moves", headers: { authorization: `Bearer ${routing.inboundToken}` } })).statusCode).toBe(401);
    expect((await get("?kms_key_arn_sha256=nothex")).statusCode).toBe(400);
  });
});
