import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { deleteAccountLocally } from "../../account-management.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { deviceRegistrationDigest, issueDeviceChallenge, registerDevice } from "./devices.js";
import { registerCollectionMigrationRecordRoute } from "./migration-record-routes.js";
import { registerMigrationSourceWitnessRoutes } from "./migration-source.js";
import {
  acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, flipEvidenceDigest,
  localTakeoverAllowed, registerMigrationRolloutRoutes, releaseCohort, setCohortFrozen, setPaused
} from "./migration-rollout.js";
import { certToJson, ed25519RawPublicKey, loadPolicySigner, type NextControlPlaneConfig } from "./policy-keys.js";
import { registerNextCollection } from "./policy-outbox.js";
import { certDigest, chainHash, decodeCbor, keyId, signPolicyItem, type PolicyOp } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const NIL = "00000000-0000-0000-0000-000000000000";
const token = "m".repeat(40), outbound = "h".repeat(40);
const root = generateKeyPairSync("ed25519").privateKey, policy = generateKeyPairSync("ed25519").privateKey;
const cert = { policyPublicKey: ed25519RawPublicKey(policy), root: keyId(ed25519RawPublicKey(root)),
  notBefore: Date.now() - 60000, notAfter: Date.now() + 30 * 86400000 };
const next: NextControlPlaneConfig = {
  rootPublicKey: ed25519RawPublicKey(root), policyPrivateKeyPem: policy.export({ format: "pem", type: "pkcs8" }).toString(),
  policyCert: certToJson({ ...cert, signature: sign(null, certDigest(cert), root) }), migrationToken: token,
  serviceTokens: { hosted: "H".repeat(40), escrow: "E".repeat(40) },
  cloudCopyBootstrap: { hosted: { url: "https://native.test", token: outbound }, escrow: { url: "https://escrow.test", token: "e".repeat(40) } },
  logService: { url: "https://log.test", tokenIssuerKeyPem: policy.export({ format: "pem", type: "pkcs8" }).toString(),
    transportKeyPem: policy.export({ format: "pem", type: "pkcs8" }).toString() }
};
const signer = loadPolicySigner(next, Date.now());
const digest = (n: number) => n.toString(16).padStart(64, "0");
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const rawX = () => (generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
const cutover = { s_final: 42, cutover_seq: 50, barrier_f: 51, final_digest: digest(7) };

// Real PostgreSQL and actual request authentication/handlers. Native-owner and legacy
// drain observations plus archive-verifier metadata are synthetic: these tests
// preserve inventory/ledger data, not qualify physical record/blob migration.
describePg("suspended account migration service boundary (isolated PostgreSQL)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_suspended_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture() {
    const account = randomUUID(), collection = randomUUID(), hostedDevice = randomUUID(), nativeDevice = randomUUID();
    const connector = randomUUID(), nativeToken = randomUUID(), email = `${account}@example.test`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Suspension fixture')", [account, email]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Preserved collection','mdbase')", [collection, account]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Native fixture',$3)", [connector, account, tokenHash(nativeToken)]);
    const nativeKey = generateKeyPairSync("ed25519").privateKey;
    const nativeKeys = { sign_pk: ed25519RawPublicKey(nativeKey), kem_pk: rawX(), noise_pk: rawX() };
    const challenge = await issueDeviceChallenge(db, connector);
    await registerDevice(db, { id: connector, user_id: account }, {
      device_id: nativeDevice, kind: "desktop", sign_pk: hex(nativeKeys.sign_pk), kem_pk: hex(nativeKeys.kem_pk), noise_pk: hex(nativeKeys.noise_pk),
      challenge: challenge.challenge, sig: hex(sign(null, deviceRegistrationDigest({ challenge: Buffer.from(challenge.challenge, "hex"),
        connectorId: connector, deviceId: nativeDevice, signPk: nativeKeys.sign_pk, kemPk: nativeKeys.kem_pk, noisePk: nativeKeys.noise_pk }), nativeKey))
    }, tokenHash(nativeToken));
    const hostedKeys = { sign_pk: Buffer.alloc(32, 1), kem_pk: Buffer.alloc(32, 2), noise_pk: Buffer.alloc(32, 3) };
    const ops: PolicyOp[] = [
      { op: "genesis", owner: account, root: cert.root, state: "cloud-copy" }, { op: "member-set", account, role: "owner" },
      { op: "device-enrol", device: hostedDevice, account: NIL, kind: "hosted", signPublicKey: hostedKeys.sign_pk, kemPublicKey: hostedKeys.kem_pk, noisePublicKey: hostedKeys.noise_pk },
      { op: "device-enrol", device: nativeDevice, account, kind: "desktop", signPublicKey: nativeKeys.sign_pk, kemPublicKey: nativeKeys.kem_pk, noisePublicKey: nativeKeys.noise_pk }
    ];
    await registerNextCollection(db, { collectionId: collection, ownerUserId: account, runtime: "shadow", sync: "cloud_copy", rootKeyId: cert.root, ops });
    await db.query("INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn) VALUES($1,'hosted',$2,$3,$4,$5,$6,'synthetic-test')",
      [collection, hostedDevice, hostedKeys.sign_pk, hostedKeys.kem_pk, hostedKeys.noise_pk, Buffer.from("test-only-wrap")]);
    const issuedAt = Date.now(), item = signPolicyItem(signer, { collection, seq: 1, prev: Buffer.alloc(32), issuedAt, previousIssuedAt: 0, ops });
    const batch = (await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at) VALUES($1,1,$2,$3,$4,'appended',now()) RETURNING id",
      [collection, Buffer.alloc(32), item, issuedAt])).rows[0].id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1", [collection, batch]);
    const cohort = `c-${randomUUID().slice(0, 8)}`, actor = "synthetic-local-pg";
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor); await releaseCohort(db, cohort, actor);
    await setCohortFrozen(db, cohort, true, "synthetic archive capture", actor);
    const binding = await cohortArchiveBinding(db, cohort);
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
    await acceptCohortArchive(db, cohort, {
      schema: "mdbase-recovery-set/v4", environment: "staging", bucket: "test-migration-archives", prefix: `staging/2026/10/09/${cohort}`, backup_id: cohort,
      complete_sha256: digest(90), manifest_sha256: digest(91), source_commit: "a".repeat(40), migration_batch: binding,
      archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86400000).toISOString(), inventory_digest: digest(92), count: "3" }
    }, "staging");
    await setPaused(db, false, "synthetic migration start", actor);
    const service = Fastify();
    registerMigrationRolloutRoutes(service, { db, token, environment: "staging" });
    registerCollectionMigrationRecordRoute(service, db);
    let calls = 0, reads = 0, during: (() => Promise<void>) | undefined;
    const source = { collection_id: collection, state: "migrating", head: 42, started_at: clock, retain_until: null,
      in_flight: 0, unresolved: 3, applied_unreceipted: 2, migration_id: randomUUID() };
    registerMigrationSourceWitnessRoutes(service, { db, next, signer, provider: { legacyMigrationDrain: async id => {
      expect(id).toBe(collection); reads++; return { ...source };
    } }, fetchImpl: async (input, init) => {
      calls++; expect(String(input)).toBe("https://native.test/internal/v1/migration-admission");
      expect(init?.redirect).toBe("manual"); expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${outbound}`);
      const body = JSON.parse(String(init?.body)); expect(body.collection).toBe(collection);
      expect(Object.keys(body).sort()).toEqual(["challenge", "collection"]); expect(Buffer.from(body.challenge, "base64")).toHaveLength(32);
      await during?.();
      return new Response(JSON.stringify({ schema: "mdbn-migration-admission/1", collection, device_id: hostedDevice,
        epoch: "2", wake: "18446744073709551615", fault_generation: "9007199254740993", challenge: body.challenge,
        applied_head: { seq: "1", chain: hex(chainHash(item)) }, authenticated_head: { seq: "1", chain: hex(chainHash(item)) }, control_chain: hex(chainHash(item)) }));
    } });
    const { app: userApp } = await buildApp({ db, devAuth: true, publicUrl: "http://127.0.0.1:8787" });
    const login = await userApp.inject({ method: "POST", url: "/v1/dev/session", payload: { email, name: "Suspension fixture" } });
    expect(login.statusCode, login.body).toBe(200); expect(login.json().user.id).toBe(account);
    const cookie = `${login.cookies[0]!.name}=${login.cookies[0]!.value}`;
    const request = (method: "GET" | "POST", path: string, payload?: unknown, authorization = `Bearer ${token}`) =>
      service.inject({ method, url: `/internal/v1/next/migration/${path}`, headers: { authorization }, ...(payload === undefined ? {} : { payload }) });
    const nativeRead = () => service.inject({ method: "GET", url: `/v1/next/collections/${collection}/migration-record`, headers: { authorization: `Bearer ${nativeToken}` } });
    const me = () => userApp.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    const inventory = async () => ({
      hosted: (await db.query("SELECT id,user_id,display_name,template,authority_state,quarantined_at FROM hosted_collections WHERE id=$1", [collection])).rows,
      custody: (await db.query("SELECT * FROM next_service_devices WHERE collection_id=$1", [collection])).rows,
      policy: (await db.query("SELECT * FROM next_policy_batches WHERE id=$1", [batch])).rows,
      device: (await db.query("SELECT * FROM next_devices WHERE id=$1", [nativeDevice])).rows
    });
    const sessionStart = () => service.inject({ method: "POST", url: `/internal/v1/next/migration/accounts/${account}/start`, headers: { cookie } });
    return { account, collection, cohort, nativeToken, sessionStart, request, nativeRead, me, inventory,
      get calls() { return calls; }, get reads() { return reads; }, set during(value: (() => Promise<void>) | undefined) { during = value; },
      close: async () => { await userApp.close(); await service.close(); } };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const suspend = async (f: Fixture) => (await db.query("UPDATE users SET suspended_at=date_trunc('milliseconds',now()) WHERE id=$1 RETURNING suspended_at,session_epoch", [f.account])).rows[0];
  const suspension = async (f: Fixture) => (await db.query("SELECT suspended_at,session_epoch FROM users WHERE id=$1", [f.account])).rows[0];
  const started = (f: Fixture) => f.request("POST", `accounts/${f.account}/start`);
  const witness = (f: Fixture) => f.request("POST", `collections/${f.collection}/source-witness`, {});
  const evidence = (f: Fixture) => flipEvidenceDigest([{ collection_id: f.collection, barrier_f: cutover.barrier_f, final_digest: cutover.final_digest }]);

  it("migrates a suspended legacy owner through service-only start/witness/cutover/flip, preserving inventory and ordinary denial", async () => {
    const f = await fixture(); try {
      expect((await f.me()).statusCode).toBe(200);
      const preserved = await f.inventory(), original = await suspend(f);
      expect((await f.me()).statusCode).toBe(401); expect((await f.nativeRead()).statusCode).toBe(401);
      expect((await f.request("GET", "candidates")).json().accounts).toContain(f.account);
      const start = await started(f); expect(start.statusCode, start.body).toBe(200);
      expect((await started(f)).json()).toEqual(start.json());
      await setPaused(db, true, "synthetic pause after start", "synthetic-local-pg");
      expect((await f.request("GET", "candidates")).json().accounts).toEqual([]);
      expect((await f.request("GET", "in-progress")).json().accounts).toContain(f.account);
      const observed = await witness(f); expect(observed.statusCode, observed.body).toBe(200);
      const envelope = decodeCbor(Buffer.from(observed.json().witness, "base64")) as unknown[];
      const claims = decodeCbor(envelope[1] as Uint8Array) as unknown[];
      expect(claims[3]).toBe(2); expect(claims[5]).toBe(42); expect(claims[7]).toBe((1n << 64n) - 1n);
      expect(f.calls).toBe(1); expect(f.reads).toBe(2);
      const cut = await f.request("POST", `collections/${f.collection}/cutover`, cutover); expect(cut.statusCode, cut.body).toBe(200);
      expect((await f.request("POST", `collections/${f.collection}/cutover`, cutover)).json()).toEqual(cut.json());
      const body = { collections: [f.collection], evidence_digest: evidence(f) };
      const flip = await f.request("POST", `accounts/${f.account}/flip`, body); expect(flip.statusCode, flip.body).toBe(200);
      expect((await f.request("POST", `accounts/${f.account}/flip`, body)).json()).toEqual(flip.json());
      expect((await f.request("GET", "in-progress")).json().accounts).not.toContain(f.account);
      expect(await suspension(f)).toEqual(original); expect(await f.inventory()).toEqual(preserved);
      expect((await f.me()).statusCode).toBe(401); expect((await f.nativeRead()).statusCode).toBe(401);
      expect(await localTakeoverAllowed(db, f.account)).toEqual({ local_takeover: false, account_backend: null });
      expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [f.account])).rows[0].account_backend).toBe("next");
      // A separate ordinary account-status change, never a migration side effect.
      await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.account]);
      expect((await f.me()).statusCode).toBe(200);
      const record = await f.nativeRead(); expect(record.statusCode, record.body).toBe(200);
      expect(record.json()).toMatchObject({ collection_id: f.collection, legacy_collection_id: f.collection, ids_preserved: true,
        s_final: "42", cutover_seq: "50", barrier_f: "51", final_digest: cutover.final_digest });
      expect(await f.inventory()).toEqual(preserved);
      expect(await localTakeoverAllowed(db, f.account)).toEqual({ local_takeover: true, account_backend: "next" });
    } finally { await f.close(); }
  });

  it("never substitutes session, ordinary connector, hosted or escrow credentials for the migration token", async () => {
    const f = await fixture(); try {
      expect((await f.me()).statusCode).toBe(200); expect((await f.sessionStart()).statusCode).toBe(401);
      await suspend(f);
      for (const authorization of ["Bearer session-test", `Bearer ${f.nativeToken}`, `Bearer ${next.serviceTokens.hosted}`, `Bearer ${next.serviceTokens.escrow}`]) {
        for (const [method, path, payload] of [
          ["GET", "candidates", undefined], ["GET", "in-progress", undefined], ["POST", `accounts/${f.account}/start`, undefined],
          ["POST", `collections/${f.collection}/source-witness`, {}], ["POST", `collections/${f.collection}/cutover`, cutover],
          ["POST", `accounts/${f.account}/flip`, { collections: [f.collection], evidence_digest: evidence(f) }]
        ] as const) expect((await f.request(method, path, payload, authorization)).statusCode).toBe(401);
      }
      expect((await f.sessionStart()).statusCode).toBe(401);
      expect(f.calls).toBe(0); expect(f.reads).toBe(0);
      expect((await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [f.account])).rows[0].started_at).toBeNull();
    } finally { await f.close(); }
  });

  it("accepts suspension arriving during the native await without lifting it or losing retained journal evidence", async () => {
    const f = await fixture(); try {
      const start = await started(f); expect(start.statusCode, start.body).toBe(200);
      f.during = async () => { await suspend(f); };
      const result = await witness(f); expect(result.statusCode, result.body).toBe(200);
      expect((await suspension(f)).suspended_at).toBeInstanceOf(Date);
      expect(f.calls).toBe(1); expect(f.reads).toBe(2); expect((await f.me()).statusCode).toBe(401);
    } finally { await f.close(); }
  });

  it("still refuses terminal-excluded suspended accounts on every service step before provider effects", async () => {
    const f = await fixture(); try {
      const start = await started(f); expect(start.statusCode, start.body).toBe(200);
      await deleteAccountLocally(db, { userId: f.account, sessionId: randomUUID(), authorized: true, queueProviderCleanup: true });
      expect((await suspension(f)).suspended_at).toBeInstanceOf(Date);
      expect((await f.request("GET", "candidates")).json().accounts).not.toContain(f.account);
      expect((await f.request("GET", "in-progress")).json().accounts).not.toContain(f.account);
      for (const result of [await started(f), await witness(f), await f.request("POST", `collections/${f.collection}/cutover`, cutover),
        await f.request("POST", `accounts/${f.account}/flip`, { collections: [f.collection], evidence_digest: evidence(f) })]) {
        expect(result.statusCode, result.body).toBe(409); expect(result.body).not.toContain('"witness"');
      }
      expect(f.calls).toBe(0); expect(f.reads).toBe(0);
      expect((await db.query("SELECT 1 FROM next_migration_account_flips WHERE account_id=$1", [f.account])).rowCount).toBe(0);
    } finally { await f.close(); }
  });
});
