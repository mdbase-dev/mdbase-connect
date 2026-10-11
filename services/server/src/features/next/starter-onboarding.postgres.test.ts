import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { scheduleStarterCollection, type StarterCollectionRouteOptions } from "../../account-onboarding.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { tokenHash } from "../../security.js";
import { STARTER_COLLECTION_NAME } from "../../starter-collection.js";
import { registerOnboardingRoutes } from "../onboarding/routes.js";
import { LogServiceClient } from "./log-service-client.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, type NextControlPlaneConfig } from "./policy-keys.js";
import { PolicyEmitter } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, encodeCbor, keyId, type Cbor, type Decoded } from "./policy-wire.js";
import { registerNativeStarterRoutes, type StarterContentPort } from "./starter-onboarding.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const field = (value: Decoded, key: number) => value instanceof Map ? value.get(key) : undefined;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const tokens = { hosted: "h".repeat(40), escrow: "e".repeat(40), hostedOut: "H".repeat(40), escrowOut: "E".repeat(40) };
const timezone = "Australia/Melbourne";

function configuration(): NextControlPlaneConfig {
  const root = generateKeyPairSync("ed25519").privateKey, policy = generateKeyPairSync("ed25519").privateKey;
  const cert = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: Date.now() - 60_000, notAfter: Date.now() + 30 * 86_400_000, root: keyId(ed25519RawPublicKey(root)) };
  const pem = (key: typeof root) => key.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: pem(policy), policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }),
    serviceTokens: { hosted: tokens.hosted, escrow: tokens.escrow },
    cloudCopyBootstrap: { hosted: { url: "https://hosted.test", token: tokens.hostedOut }, escrow: { url: "https://escrow.test", token: tokens.escrowOut } },
    logService: { url: "http://log.test", tokenIssuerKeyPem: pem(generateKeyPairSync("ed25519").privateKey), transportKeyPem: pem(generateKeyPairSync("ed25519").privateKey) }
  };
}

/** The log service: control items per collection, with create, append, head and read. */
class Log {
  readonly logs = new Map<string, Buffer[]>();
  readonly fetch: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/v1/nonce")) return new Response("ab".repeat(32));
    const frame = decodeCbor(Buffer.from(init!.body as Uint8Array));
    const method = field(frame, 2), params = field(frame, 3)!;
    const id = hex(field(params, 0) as Uint8Array), items = this.logs.get(id);
    const chain = () => chainHash(items![items!.length - 1]!);
    let result: Cbor;
    if (method === "create_log") {
      if (!items) this.logs.set(id, [Buffer.from(field(params, 1) as Uint8Array)]);
      result = { struct: [[0, 1], [1, chainHash(this.logs.get(id)![0]!)]] };
    } else if (method === "head") {
      result = { struct: [[0, items!.length], [1, chain()], [2, 1]] };
    } else if (method === "append") {
      const expected = field(params, 1) as number, prev = Buffer.from(field(params, 2) as Uint8Array);
      if (expected !== items!.length + 1 || !prev.equals(Buffer.from(chain()))) result = { struct: [[0, 1], [1, items!.length], [2, chain()]] };
      else { items!.push(...(field(params, 3) as Uint8Array[]).map((b) => Buffer.from(b))); result = { struct: [[0, 0], [1, expected], [2, items!.length]] }; }
    } else if (method === "read") {
      if (!items) return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [3, { struct: [[0, "not_found"]] }]] }));
      const after = field(params, 1) as number, limit = field(params, 2) as number;
      result = { struct: [[0, items.slice(after, after + limit).map((item, i) => [after + i + 1, item])]] };
    } else throw new Error("unexpected log operation");
    return new Response(encodeCbor({ struct: [[0, 1], [1, 1], [2, result]] }), { headers: { "content-type": "application/vnd.mdbase.v1+cbor" } });
  };
}

/** Hosted and escrow service-device generation; the CP's first stored record wins. */
const deployments: typeof fetch = async (input, init) => {
  const kind = new URL(String(input)).hostname === "hosted.test" ? "hosted" : "escrow";
  const { collection } = JSON.parse(String(init!.body)) as { collection: string };
  return new Response(JSON.stringify({
    kind, device_id: randomUUID(), sign_pk: hex(ed25519RawPublicKey(generateKeyPairSync("ed25519").privateKey)), kem_pk: hex(rawX()),
    noise_pk: hex(rawX()), wrapped_keys: Buffer.from(`sealed ${kind}/${collection}`).toString("base64"), kms_key_arn: `arn:aws:kms:eu-west-1:000000000000:key/${kind}`
  }));
};

/** Stand-in for the hosted starter content op: idempotent per collection. */
function contentPort() {
  const sealed = new Map<string, string>();
  const seal = vi.fn<StarterContentPort["seal"]>(async ({ collection, templateVersion, timezone: zone }) => {
    const content = `${templateVersion}/${zone}`;
    if (sealed.has(collection) && sealed.get(collection) !== content) throw new Error("different content");
    sealed.set(collection, content);
    return { digest: content };
  });
  return { seal, sealed };
}

describePg("native starter onboarding", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const config = configuration();
  const log = new Log();
  const client = new LogServiceClient(config.logService, log.fetch);
  const port = contentPort();
  const app = Fastify(), bare = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `starter_onboarding_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    const emitter = new PolicyEmitter(db, client, loadPolicySigner(config, Date.now()));
    for (const instance of [app, bare]) { await instance.register(cookie); registerErrorHandler(instance); }
    registerNativeStarterRoutes(app, { db, next: config, emitter, log: client, fetchImpl: deployments, starterContent: port });
    registerOnboardingRoutes(app, { db, publicUrl: "https://connect.test" } as StarterCollectionRouteOptions);
    registerNativeStarterRoutes(bare, { db, next: config, emitter, log: client, fetchImpl: deployments });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await bare.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function account(options: { flipped?: boolean } = {}) {
    const id = randomUUID(), token = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [id, `${id}@example.test`]);
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',1,now()+interval '1 day')", [randomUUID(), id, tokenHash(token)]);
    const starter = await scheduleStarterCollection(db, id, timezone);
    if (options.flipped !== false) await flip(id);
    return { id, starter, headers: { cookie: `mdbase_session=${token}` } };
  }
  async function flip(id: string) {
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [id]);
    await db.query("INSERT INTO next_migration_account_flips(account_id,collections,evidence_digest) VALUES($1,'{}',$2)", [id, "d".repeat(64)]);
  }
  type Account = Awaited<ReturnType<typeof account>>;
  const onboard = (who: Account, on = app) => on.inject({ method: "POST", url: "/v1/next/onboarding/starter-collection", headers: who.headers });
  const reservation = async (who: Account) => (await db.query(
    "SELECT starter_collection_id::text, template_version, timezone, provisioned_at, provisioning_started_at FROM account_onboarding WHERE user_id=$1", [who.id])).rows[0];
  const owned = async (who: Account) => (await db.query(
    "SELECT collection_id::text, runtime, sync, display_name FROM next_collections WHERE owner_user_id=$1", [who.id])).rows;

  it("creates nothing before the flip or while frozen, and the legacy route refuses a moved account", async () => {
    const who = await account({ flipped: false }), before = await reservation(who), calls = port.seal.mock.calls.length;
    let response = await onboard(who);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("onboarding_not_ready");
    await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [who.id]);
    expect((await onboard(who)).json().error.code).toBe("onboarding_not_ready");
    await db.query("INSERT INTO next_migration_account_flips(account_id,collections,evidence_digest) VALUES($1,'{}',$2)", [who.id, "d".repeat(64)]);
    const cohort = `frozen-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,now())", [who.id, cohort]);
    response = await onboard(who);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("migration_frozen");

    const legacy = await app.inject({ method: "POST", url: "/v1/onboarding/starter-collection", headers: who.headers });
    expect(legacy.statusCode).toBe(409); expect(legacy.json().error.code).toBe("onboarding_moved");
    expect(await owned(who)).toEqual([]);
    expect(await reservation(who)).toEqual(before);
    expect(port.seal.mock.calls.length).toBe(calls);
  });

  it("creates exactly the reserved collection with its template and timezone, once", async () => {
    const who = await account();
    const first = await Promise.all([onboard(who), onboard(who), onboard(who)]);
    expect(first.every((r) => [200, 202].includes(r.statusCode))).toBe(true);
    expect(first.some((r) => r.statusCode === 200)).toBe(true);
    const again = await onboard(who);
    for (const response of [...first.filter((r) => r.statusCode === 200), again]) {
      expect(response.json()).toEqual({ status: "ready", collection_id: who.starter, template_version: "starter-v1", timezone });
    }
    expect(await owned(who)).toEqual([{ collection_id: who.starter, runtime: "next", sync: "cloud_copy", display_name: STARTER_COLLECTION_NAME }]);
    expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [who.starter])).rows).toEqual([]);
    expect(port.sealed.get(who.starter)).toBe(`starter-v1/${timezone}`);
    expect(await reservation(who)).toMatchObject({ starter_collection_id: who.starter, provisioned_at: expect.any(Date), provisioning_started_at: null });
  });

  it("re-converges on the same collection after an unanswered content seal", async () => {
    const who = await account();
    port.seal.mockImplementationOnce(async (input) => { port.sealed.set(input.collection, `starter-v1/${input.timezone}`); throw new Error("reply lost"); });
    const lost = await onboard(who);
    expect(lost.statusCode).toBe(503); expect(lost.json().error.code).toBe("not_ready");
    expect(await reservation(who)).toMatchObject({ provisioned_at: null, provisioning_started_at: null });
    expect((await onboard(who)).json()).toMatchObject({ status: "ready", collection_id: who.starter });
    expect((await owned(who)).map((row) => row.collection_id)).toEqual([who.starter]);
  });

  it.each([
    ["unsupported template", "UPDATE account_onboarding SET template_version='starter-v0' WHERE user_id=$1"],
    ["unsupported timezone", "UPDATE account_onboarding SET timezone='Mars/Olympus' WHERE user_id=$1"],
    ["legacy collection at the reservation", "INSERT INTO hosted_collections(id,user_id,display_name,template) SELECT starter_collection_id,user_id,'Legacy','onboarding' FROM account_onboarding WHERE user_id=$1"]
  ])("stops without a replacement: %s", async (_case, change) => {
    const who = await account(), calls = port.seal.mock.calls.length;
    await db.query(change, [who.id]);
    const response = await onboard(who);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("starter_unavailable");
    expect(await owned(who)).toEqual([]); expect(port.seal.mock.calls.length).toBe(calls);
    expect(await reservation(who)).toMatchObject({ provisioned_at: null, provisioning_started_at: null });
  });

  it("stops on another owner's collection at the reservation, and on a reservation that changed during creation", async () => {
    const other = await account();
    expect((await onboard(other)).statusCode).toBe(200);
    const who = await account();
    await db.query("UPDATE account_onboarding SET starter_collection_id=$2 WHERE user_id=$1", [who.id, other.starter]);
    expect((await onboard(who)).json().error.code).toBe("starter_unavailable");
    expect(await owned(who)).toEqual([]);

    const drifting = await account();
    port.seal.mockImplementationOnce(async (input) => {
      await db.query("UPDATE account_onboarding SET timezone='Europe/London' WHERE user_id=$1", [drifting.id]);
      return { digest: `starter-v1/${input.timezone}` };
    });
    expect((await onboard(drifting)).json().error.code).toBe("starter_unavailable");
    expect(await reservation(drifting)).toMatchObject({ provisioned_at: null });
  });

  it("keeps a deleted starter deleted", async () => {
    const who = await account();
    expect((await onboard(who)).statusCode).toBe(200);
    await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'cp-intent')", [who.starter, randomUUID()]);
    const calls = port.seal.mock.calls.length;
    expect((await onboard(who)).json()).toEqual({ status: "deleted", collection_id: who.starter, template_version: "starter-v1", timezone });
    expect(port.seal.mock.calls.length).toBe(calls);
  });

  it("refuses retryably and creates nothing without a content port", async () => {
    const who = await account();
    const response = await onboard(who, bare);
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe("starter_content_unavailable");
    expect(await owned(who)).toEqual([]);
    expect(await reservation(who)).toMatchObject({ provisioned_at: null, provisioning_started_at: null });
  });
});
