import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { serviceClaimReadDigest, type ServiceClaimFacts } from "./migration-claim-auth.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-hosted-role-".repeat(3), adminToken = "synthetic-operator-".repeat(3), audience = "https://cp.example.test";
const privateKey = (oid: string, byte: number) => createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([
  Buffer.from(`302e020100300506032b${oid}04220420`, "hex"), Buffer.alloc(32, byte)
]) });
const publicBytes = (key: ReturnType<typeof privateKey>) => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
const key = privateKey("6570", 0x43), signPk = publicBytes(key), kemPk = publicBytes(privateKey("656e", 0x44)), noisePk = publicBytes(privateKey("656e", 0x47));

// Actual isolated CP cryptography/SQL, not a native FULL, actual TLS/physical
// target, pending/settlement, durable host commit or managed H1 qualification.
suite("hosted own-collection migration proof (isolated PostgreSQL)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_service_${randomUUID().replaceAll("-", "")}`;
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

  async function fixture(target = true, database = db) {
    const account = randomUUID(), collection = randomUUID(), device = randomUUID(), root = Buffer.alloc(16, 0x13), cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [collection, account]);
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,'2026-10-10T18:00:00.123456Z')", [account, cohort]);
    if (target) {
      await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [collection, account, root]);
      await db.query("INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn) VALUES($1,'hosted',$2,$3,$4,$5,$6,'synthetic-private-kms-label')", [collection, device, signPk, kemPk, noisePk, Buffer.from("synthetic-private-wrapper")]);
    }
    const facts: ServiceClaimFacts = { collection_id: collection, owner_account: account, started_us: "1791655200123456", target: target ? {
      runtime: "shadow", root_key_id: root.toString("hex"), hosted: { device_id: device, sign_pk: signPk.toString("hex"), kem_pk: kemPk.toString("hex"), noise_pk: noisePk.toString("hex") }
    } : null };
    const app = Fastify();
    const forbidden = async () => { throw new Error("read attempted provider effect"); };
    registerMigrationProviderRoutes(app, { db: database, token: adminToken, hostedRead: { token, audience }, provider: { legacyMigrationDrain: forbidden, legacyMigrationSource: forbidden, legacyMigrationFence: forbidden } });
    const request = (kind: "challenge" | "read", payload: object, auth = token, suffix = "") => app.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${collection}/claim/${kind}${suffix}`, headers: { authorization: `Bearer ${auth}` }, payload });
    const nonce = async () => {
      const result = await request("challenge", { device_id: device });
      expect(result.statusCode, result.body).toBe(200);
      expect(Object.keys(result.json())).toEqual(["challenge"]);
      return result.json().challenge as string;
    };
    const proof = (challenge: string, input = facts, origin = audience, signer = key) => ({ device_id: input.target!.hosted.device_id, challenge,
      sig: sign(null, serviceClaimReadDigest(origin, input, Buffer.from(challenge, "hex")), signer).toString("hex") });
    return { account, collection, device, root, facts, app, request, nonce, proof };
  }
  async function unused(challenge: string) {
    return (await db.query("SELECT used_at FROM next_device_challenges WHERE challenge=$1", [Buffer.from(challenge, "hex")])).rows[0]?.used_at === null;
  }
  it("accepts fresh DB cohort members for the LAB role without an environment account pin", async () => {
    const own = await fixture(); const inbound = "synthetic-db-cohort-role-".repeat(3), scoped = Fastify();
    registerMigrationProviderRoutes(scoped, { db, token: adminToken, hostedRead: { token, audience, migrationRouting: {
      accounts: new Set(), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "outbound".repeat(6) }, inboundToken: inbound
    } } });
    const request = (kind: "challenge" | "read", payload: object, credential: string) => scoped.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${own.collection}/claim/${kind}`, headers: { authorization: `Bearer ${credential}` }, payload });
    try {
      expect((await request("challenge", { device_id: own.device }, token)).statusCode).toBe(403);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_device_id=$1", [own.device])).rows[0].n).toBe(0);
      const nonce = await request("challenge", { device_id: own.device }, inbound);
      expect(nonce.statusCode, nonce.body).toBe(200);
      const challenge = nonce.json().challenge as string;
      expect((await request("read", own.proof(challenge), token)).statusCode).toBe(403);
      expect(await unused(challenge)).toBe(true);
      expect((await request("read", own.proof(challenge), inbound)).statusCode).toBe(200);
      expect(await unused(challenge)).toBe(false);
    } finally { await scoped.close(); await own.app.close(); }
  });
  it("returns only a one-use challenge then exact public current facts; no provider/policy/audit/key effects", async () => {
    const f = await fixture();
    try {
      const challenge = await f.nonce(); expect(challenge).toMatch(/^[0-9a-f]{64}$/u);
      const result = await f.request("read", f.proof(challenge));
      expect(result.statusCode, result.body).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json()).toEqual({ schema: "mdbase-migration-claim/1", ...f.facts });
      expect(result.body).not.toContain("synthetic-private"); expect(await unused(challenge)).toBe(false);
      for (const table of ["audit_events", "next_policy_outbox"]) {
        const column = table === "audit_events" ? "subject_id" : "collection_id";
        expect((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [f.collection])).rows[0].n).toBe(0);
      }
      expect((await db.query("SELECT count(*)::int AS n FROM next_service_devices WHERE collection_id=$1", [f.collection])).rows[0].n).toBe(1);
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(409);
    } finally { await f.app.close(); }
  });
  it("scopes the migration hosted credential to the authoritative account before nonce or proof effects", async () => {
    const own = await fixture(), other = await fixture();
    const migrationToken = "synthetic-migration-hosted-role-".repeat(3);
    const scoped = Fastify();
    registerMigrationProviderRoutes(scoped, { db, token: adminToken, hostedRead: { token, audience, migrationRouting: {
      accounts: new Set([own.account]), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "outbound".repeat(6) }, inboundToken: migrationToken
    } } });
    const request = (f: typeof own, kind: "challenge" | "read", payload: object, credential: string) => scoped.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${f.collection}/claim/${kind}`, headers: { authorization: `Bearer ${credential}` }, payload });
    try {
      expect((await request(own, "challenge", { device_id: own.device }, token)).statusCode).toBe(403);
      expect((await request(other, "challenge", { device_id: other.device }, migrationToken)).statusCode).toBe(403);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_device_id=ANY($1::uuid[])", [[own.device, other.device]])).rows[0].n).toBe(0);
      const challenge = (await request(own, "challenge", { device_id: own.device }, migrationToken)).json().challenge as string;
      expect(challenge).toMatch(/^[0-9a-f]{64}$/u);
      expect((await request(own, "read", own.proof(challenge), token)).statusCode).toBe(403);
      expect(await unused(challenge)).toBe(true);
      expect((await request(own, "read", own.proof(challenge), migrationToken)).statusCode).toBe(200);
      expect((await request(other, "challenge", { device_id: other.device }, token)).statusCode).toBe(200);
    } finally { await scoped.close(); await own.app.close(); await other.app.close(); }
  });

  it("admits each exact allowlisted account and excludes the third before nonce effects", async () => {
    const a = await fixture(), b = await fixture(), outside = await fixture();
    const migrationToken = "synthetic-multi-account-token-".repeat(3);
    const app = Fastify();
    registerMigrationProviderRoutes(app, { db, token: adminToken, hostedRead: { token, audience, migrationRouting: {
      accounts: new Set([a.account, b.account]), hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "outbound".repeat(6) }, inboundToken: migrationToken
    } } });
    const request = (f: typeof a, kind: "challenge" | "read", payload: object, auth: string) => app.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${f.collection}/claim/${kind}`, headers: { authorization: `Bearer ${auth}` }, payload });
    try {
      for (const f of [a, b]) {
        expect((await request(f, "challenge", { device_id: f.device }, token)).statusCode).toBe(403);
        const nonce = await request(f, "challenge", { device_id: f.device }, migrationToken);
        expect(nonce.statusCode, nonce.body).toBe(200);
        const challenge = nonce.json().challenge as string;
        expect((await request(f, "read", f.proof(challenge), token)).statusCode).toBe(403);
        expect(await unused(challenge)).toBe(true);
        expect((await request(f, "read", f.proof(challenge), migrationToken)).statusCode).toBe(200);
      }
      expect((await request(outside, "challenge", { device_id: outside.device }, migrationToken)).statusCode).toBe(403);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_device_id=$1", [outside.device])).rows[0].n).toBe(0);
      expect((await request(outside, "challenge", { device_id: outside.device }, token)).statusCode).toBe(200);
    } finally { await app.close(); await a.app.close(); await b.app.close(); await outside.app.close(); }
  });

  it("never overwrites/renews an outstanding live nonce and permits a new one only after expiry", async () => {
    const f = await fixture();
    try {
      const challenge = await f.nonce();
      const before = (await db.query("SELECT expires_at FROM next_device_challenges WHERE challenge=$1", [Buffer.from(challenge, "hex")])).rows[0];
      expect((await f.request("challenge", { device_id: f.device })).json().error.code).toBe("challenge_pending");
      expect((await db.query("SELECT expires_at FROM next_device_challenges WHERE challenge=$1", [Buffer.from(challenge, "hex")])).rows[0]).toEqual(before);
      await db.query("UPDATE next_device_challenges SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE challenge=$1", [Buffer.from(challenge, "hex")]);
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(409);
      expect(await f.nonce()).not.toBe(challenge);
    } finally { await f.app.close(); }
  });
  it("refuses ordinary/admin/escrow credentials and selectors/malformed/cross-device proofs", async () => {
    const f = await fixture();
    try {
      for (const auth of [adminToken, "session", "app", "escrow", "wrong"]) expect((await f.request("challenge", { device_id: f.device }, auth)).statusCode).toBe(401);
      for (const extra of [{ audience: "https://other.test" }, { owner: f.account }, { kind: "escrow" }, { verified: true }]) {
        expect((await f.request("challenge", { device_id: f.device, ...extra })).statusCode).toBe(400);
      }
      expect((await f.request("challenge", { device_id: f.device }, token, "?purpose=other")).statusCode).toBe(400);
      expect((await f.request("challenge", { device_id: randomUUID() })).statusCode).toBe(409);
      const challenge = await f.nonce(), proof = f.proof(challenge);
      for (const bad of [{ ...proof, sig: "00".repeat(64) }, { ...proof, device_id: randomUUID() }, f.proof(challenge, f.facts, "https://other.test")]) {
        expect((await f.request("read", bad)).statusCode).toBe(401); expect(await unused(challenge)).toBe(true);
      }
      for (const bad of [{ ...proof, sig: proof.sig + "\n" }, { ...proof, challenge: challenge.toUpperCase() }, { ...proof, challenge: "00".repeat(33) }]) expect((await f.request("read", bad)).statusCode).toBe(400);
      expect((await f.request("read", proof)).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });
  it("rejects a foreign collection nonce even with a valid proof under that collection's current key", async () => {
    const a = await fixture(), b = await fixture();
    try {
      const challenge = await a.nonce();
      expect((await b.request("read", b.proof(challenge))).statusCode).toBe(409);
      expect(await unused(challenge)).toBe(true);
    } finally { await a.app.close(); await b.app.close(); }
  });
  it.each(["start", "root", "device", "sign", "kem", "noise"])("binds the immutable issuance subject and refuses replacement: %s", async mode => {
    const f = await fixture();
    try {
      const challenge = await f.nonce(); let facts = f.facts, signer = key;
      if (mode === "start") { await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 microsecond' WHERE account_id=$1", [f.account]); facts = { ...facts, started_us: "1791655200123457" }; }
      if (mode === "root") { await db.query("UPDATE next_collections SET root_key_id=$2 WHERE collection_id=$1", [f.collection, Buffer.alloc(16, 0x14)]); facts = { ...facts, target: { ...facts.target!, root_key_id: "14".repeat(16) } }; }
      if (mode === "device") {
        const device = randomUUID();
        await db.query("DELETE FROM next_service_devices WHERE collection_id=$1", [f.collection]);
        await db.query("INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn) VALUES($1,'hosted',$2,$3,$4,$5,$6,'synthetic-private-kms-label')", [f.collection, device, signPk, kemPk, noisePk, Buffer.from("synthetic-private-wrapper")]);
        facts = { ...facts, target: { ...facts.target!, hosted: { ...facts.target!.hosted, device_id: device } } };
      }
      if (["sign", "kem", "noise"].includes(mode)) {
        const changed = privateKey(mode === "sign" ? "6570" : "656e", 0x67), pub = publicBytes(changed);
        const column = `${mode}_pk`;
        await db.query(`UPDATE next_service_devices SET ${column}=$2 WHERE collection_id=$1`, [f.collection, pub]);
        facts = { ...facts, target: { ...facts.target!, hosted: { ...facts.target!.hosted, [column]: pub.toString("hex") } } };
        if (mode === "sign") signer = changed;
      }
      expect((await f.request("read", f.proof(challenge, facts, audience, signer))).statusCode).toBe(409);
    } finally { await f.app.close(); }
  });
  it.each(["unstarted", "terminal", "quarantine", "deletion", "cutover", "backend", "next", "left", "revoked"])("refuses current-source/target lifecycle drift: %s", async mode => {
    const f = await fixture();
    try {
      const challenge = await f.nonce();
      if (mode === "unstarted") await db.query("UPDATE next_migration_cohort_members SET started_at=NULL WHERE account_id=$1", [f.account]);
      if (mode === "terminal") await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [f.account]);
      if (mode === "quarantine") await db.query("UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1", [f.collection]);
      if (mode === "deletion") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
      if (mode === "cutover") await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,42,2,2,$3)", [f.collection, f.account, "ab".repeat(32)]);
      if (mode === "backend") await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [f.account]);
      if (mode === "next") await db.query("UPDATE next_collections SET runtime='next' WHERE collection_id=$1", [f.collection]);
      if (mode === "left") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
      if (mode === "revoked") await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [f.collection, { ops: [{ op: "device-revoke", device: f.device }] }]);
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(409);
      expect(await unused(challenge)).toBe(true);
    } finally { await f.app.close(); }
  });
  it("refuses missing pre-bootstrap target, instead of returning null target as service success", async () => {
    const f = await fixture(false);
    try { expect((await f.request("challenge", { device_id: f.device })).statusCode).toBe(409); }
    finally { await f.app.close(); }
  });
  it("enforces a persistent per-subject bound after nonce consumption", async () => {
    const f = await fixture();
    try {
      for (let i = 0; i < 20; i++) { const challenge = await f.nonce(); expect((await f.request("read", f.proof(challenge))).statusCode).toBe(200); }
      expect((await f.request("challenge", { device_id: f.device })).statusCode).toBe(429);
    } finally { await f.app.close(); }
  });
  it("rolls back nonce consumption when deletion arrives after the consume SQL await", async () => {
    let collection = "", inject = false;
    const wrapped: DatabasePool = { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const client = await db.connect();
      return { release: client.release.bind(client), query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
        const result = await client.query<R>(text, values);
        if (inject && text.startsWith("UPDATE next_device_challenges SET used_at")) {
          inject = false;
          await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [collection, randomUUID()]);
        }
        return result;
      } };
    } };
    const f = await fixture(true, wrapped); collection = f.collection;
    try {
      const challenge = await f.nonce(); inject = true;
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(409);
      expect(inject).toBe(false); expect(await unused(challenge)).toBe(true);
    } finally { await f.app.close(); }
  });
  it("unknown COMMIT acknowledgment emits no successful claim even when nonce consumption landed", async () => {
    let loseAck = false;
    const wrapped: DatabasePool = { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const client = await db.connect();
      return { release: client.release.bind(client), query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
        const result = await client.query<R>(text, values);
        if (loseAck && text === "COMMIT") { loseAck = false; throw new Error("synthetic lost commit acknowledgment"); }
        return result;
      } };
    } };
    const f = await fixture(true, wrapped);
    try {
      const challenge = await f.nonce(); loseAck = true;
      const result = await f.request("read", f.proof(challenge));
      expect(result.statusCode).toBe(500); expect(result.json()).not.toHaveProperty("target");
      expect(await unused(challenge)).toBe(false); // Independent SQL, not failure=no-effect.
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(409);
    } finally { await f.app.close(); }
  });
  it("schema requires exactly one genuine connector OR service subject and isolates service purpose", async () => {
    const f = await fixture();
    try {
      await expect(db.query("INSERT INTO next_device_challenges(challenge,expires_at) VALUES($1,now()+interval '10 seconds')", [Buffer.alloc(32, 0x91)])).rejects.toMatchObject({ code: "23514" });
      await expect(db.query(`INSERT INTO next_device_challenges(challenge,connector_id,service_collection_id,service_device_id,service_purpose,service_audience,service_subject_hash,expires_at)
        VALUES($1,$2,$3,$4,'migration-claim-read/v1',$5,$6,now()+interval '10 seconds')`, [Buffer.alloc(32, 0x92), randomUUID(), f.collection, f.device, audience, Buffer.alloc(32, 1)])).rejects.toMatchObject({ code: "23514" });
      await expect(db.query(`INSERT INTO next_device_challenges(challenge,service_collection_id,service_device_id,service_purpose,service_audience,service_subject_hash,expires_at)
        VALUES($1,$2,$3,'connector-enrol',$4,$5,now()+interval '10 seconds')`, [Buffer.alloc(32, 0x93), f.collection, f.device, audience, Buffer.alloc(32, 1)])).rejects.toMatchObject({ code: "23514" });
    } finally { await f.app.close(); }
  });
  it("uses actual expiry after a service-row lock wait, not frozen transaction-start now()", async () => {
    const f = await fixture(), holder = await db.connect();
    try {
      const challenge = await f.nonce();
      await db.query("UPDATE next_device_challenges SET expires_at=clock_timestamp()+interval '400 milliseconds' WHERE challenge=$1", [Buffer.from(challenge, "hex")]);
      await holder.query("BEGIN"); await holder.query("SELECT device_id FROM next_service_devices WHERE collection_id=$1 FOR UPDATE", [f.collection]);
      const pending = f.request("read", f.proof(challenge));
      await new Promise(resolve => setTimeout(resolve, 700)); await holder.query("COMMIT");
      expect((await pending).statusCode).toBe(409); expect(await unused(challenge)).toBe(true);
    } finally { await holder.query("ROLLBACK"); holder.release(); await f.app.close(); }
  });
});
