import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { DatabaseConnection } from "../../database-types.js";
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

  async function fixture(target = true, database = db, routingMode?: "standard" | "csv" | "cohort") {
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
    const inbound = "synthetic-migration-role-".repeat(3);
    const migrationRouting = routingMode && routingMode !== "standard" ? {
      environment: "lab" as const, accounts: new Set(routingMode === "csv" ? [account] : []), inboundToken: inbound,
      hosted: { url: "https://mdbase-next-hosted-mig-lab.example.workers.dev", token: "outbound".repeat(6) }
    } : undefined;
    registerMigrationProviderRoutes(app, { db: database, token: adminToken, hostedRead: { token, audience, migrationRouting }, provider: { legacyMigrationDrain: forbidden, legacyMigrationSource: forbidden, legacyMigrationFence: forbidden } });
    const request = (kind: "challenge" | "read", payload: object, auth = migrationRouting ? inbound : token, suffix = "") => app.inject({ method: "POST",
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
  // Transparent real-PG observation/fault boundary. No product hooks, SQL values
  // in evidence, or client substitution across transaction statements.
  function tapped(after: (sql: string, client: DatabaseConnection) => Promise<void> | void, failed?: (error: unknown) => void): DatabasePool {
    return { query: db.query.bind(db), end: db.end.bind(db), connect: async () => {
      const client = await db.connect();
      return { release: client.release.bind(client), query: async <R extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
        let result: pg.QueryResult<R>;
        try { result = await client.query<R>(text, values); }
        catch (error) { failed?.(error); throw error; }
        await after(text.replace(/\s+/gu, " ").trim(), client);
        return result;
      } };
    } };
  }
  it.each((["standard", "csv", "cohort"] as const).flatMap(mode => [0, 10].map(delay => ({ mode, delay }))))(
    "consolidates only route-local claim SQL with four fresh snapshots: $mode, response delay $delay", async ({ mode, delay }) => {
    const calls: string[] = []; let injected = 0;
    const f = await fixture(true, tapped(async sql => {
      calls.push(sql);
      if (delay) { const start = performance.now(); await new Promise(resolve => setTimeout(resolve, delay)); injected += performance.now() - start; }
    }), mode);
    try {
      const start = performance.now(), challenge = await f.nonce(), challengeMs = performance.now() - start, challengeCalls = calls.splice(0);
      const readStart = performance.now(), result = await f.request("read", f.proof(challenge)), readMs = performance.now() - readStart;
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toEqual({ schema: "mdbase-migration-claim/1", ...f.facts });
      const readCalls = calls.splice(0), pair = [...challengeCalls, ...readCalls];
      const fingerprint = (queries: string[]) => Object.fromEntries([...new Set(queries)].sort().map(sql => [sql, queries.filter(q => q === sql).length]));
      // Static SQL only: no parameters, account IDs, nonce values or content.
      console.log("MIGRATION_CLAIM_SQL " + JSON.stringify({ mode, response_delay_ms: delay, actual_injected_ms: injected, challenge_ms: challengeMs, read_ms: readMs,
        challenge: challengeCalls.length, read: readCalls.length,
        challenge_fingerprint: fingerprint(challengeCalls), read_fingerprint: fingerprint(readCalls) }));
      const extra = mode === "standard" ? 0 : mode === "csv" ? 1 : 2;
      expect(challengeCalls).toHaveLength(20 + extra);
      expect(readCalls).toHaveLength(18 + extra);
      expect(pair.filter(sql => sql === "BEGIN")).toHaveLength(2);
      expect(pair.filter(sql => sql === "COMMIT")).toHaveLength(2);
      expect(pair.filter(sql => sql.startsWith("SET LOCAL"))).toEqual([
        "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '5s'",
        "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '5s'"
      ]);
      expect(pair.filter(sql => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
      expect(pair.filter(sql => sql.includes("FROM hosted_collections h"))).toHaveLength(8);
      expect(pair.filter(sql => sql.includes("revoked AS"))).toHaveLength(4); // Already canonical on main, not new savings.
      expect(pair.filter(sql => sql.includes("FOR SHARE OF device, parent"))).toHaveLength(4);
    } finally { await f.app.close(); }
  });
  async function unused(challenge: string) {
    return (await db.query("SELECT used_at FROM next_device_challenges WHERE challenge=$1", [Buffer.from(challenge, "hex")])).rows[0]?.used_at === null;
  }
  it.each(["root", "device", "sign", "kem", "noise", "start", "owner", "runtime", "left"] as const)("rereads projected target/source after consume, not an earlier locked snapshot: %s", async kind => {
    let armed = false, collection = "", account = "";
    const database = tapped(async (sql, client) => {
      if (!armed || !sql.startsWith("UPDATE next_device_challenges SET used_at")) return;
      armed = false;
      if (kind === "root") await client.query("UPDATE next_collections SET root_key_id=$2 WHERE collection_id=$1", [collection, Buffer.alloc(16, 0x52)]);
      else if (kind === "device") {
        // The live nonce FK intentionally forbids UPDATE of its device ID.
        // Genuine replacement deletes (cascading that nonce), then inserts.
        await client.query("DELETE FROM next_service_devices WHERE collection_id=$1", [collection]);
        await client.query("INSERT INTO next_service_devices(collection_id,kind,device_id,sign_pk,kem_pk,noise_pk,wrapped_keys,kms_key_arn) VALUES($1,\'hosted\',$2,$3,$4,$5,$6,\'synthetic-private-kms-label\')",
          [collection, randomUUID(), signPk, kemPk, noisePk, Buffer.from("synthetic-private-wrapper")]);
      }
      else if (kind === "start") await client.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 microsecond' WHERE account_id=$1", [account]);
      else if (kind === "runtime") await client.query("UPDATE next_collections SET runtime='next' WHERE collection_id=$1", [collection]);
      else if (kind === "left") await client.query("UPDATE next_collections SET left_sync_at=clock_timestamp() WHERE collection_id=$1", [collection]);
      else if (kind === "owner") {
        const other = randomUUID();
        await client.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Other')", [other, `${other}@example.test`]);
        await client.query("UPDATE next_collections SET owner_user_id=$2 WHERE collection_id=$1", [collection, other]);
      } else await client.query(`UPDATE next_service_devices SET ${kind}_pk=$2 WHERE collection_id=$1`, [collection, publicBytes(privateKey(kind === "sign" ? "6570" : "656e", 0x64))]);
    });
    const f = await fixture(true, database); collection = f.collection; account = f.account;
    try {
      const challenge = await f.nonce(); armed = true;
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(409);
      expect(armed).toBe(false); expect(await unused(challenge)).toBe(true);
      // The fault and consumption rolled back together, independently read back.
      expect((await f.request("read", f.proof(challenge))).statusCode).toBe(200);
    } finally { armed = false; await f.app.close(); }
  });
  it("unknown challenge COMMIT acknowledgment leaves the original live slot, never a success or replacement", async () => {
    let loseAck = true;
    const f = await fixture(true, tapped(sql => {
      if (loseAck && sql === "COMMIT") { loseAck = false; throw new Error("synthetic lost challenge commit acknowledgment"); }
    }));
    try {
      expect((await f.request("challenge", { device_id: f.device })).statusCode).toBe(500);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1 AND used_at IS NULL", [f.collection])).rows[0].n).toBe(1);
      expect((await f.request("challenge", { device_id: f.device })).json().error.code).toBe("challenge_pending");
    } finally { await f.app.close(); }
  });
  it.each(["55P03", "57014", "40P01", "40001"])("rolls back failed bounded transaction setup with no claim: %s", async code => {
    let fail = true;
    const f = await fixture(true, tapped(sql => {
      if (fail && sql.startsWith("SET LOCAL")) { fail = false; throw Object.assign(new Error("synthetic setup failure"), { code }); }
    }));
    try {
      const result = await f.request("challenge", { device_id: f.device });
      expect(result.statusCode, result.body).toBe(503); expect(result.json().error.code).toBe("busy");
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1", [f.collection])).rows[0].n).toBe(0);
      expect(await f.nonce()).toMatch(/^[0-9a-f]{64}$/u);
    } finally { await f.app.close(); }
  });
  const phases = ["source", "advisory", "deletion", "parent", "device", "revocation", "nonce", "final-source"] as const;
  const phaseCases = (["standard", "csv", "cohort"] as const).flatMap(mode =>
    (["challenge", "read"] as const).flatMap(route => (["deletion", "cutover"] as const).flatMap(fact => phases.map(phase => ({ mode, route, fact, phase })))));
  it.each(phaseCases)("rechecks $fact at $phase in $route ($mode), including nonce rollback", async ({ mode, route, fact, phase }) => {
    let armed = false, injected = false, sources = 0, collection = "", account = "";
    const database = tapped(async sql => {
      if (!armed) return;
      if (sql.includes("FROM hosted_collections h")) sources++;
      const hit = phase === "source" ? sources === 1
        : phase === "advisory" ? sql.includes("pg_advisory_xact_lock")
        : phase === "deletion" ? sql.startsWith("SELECT 1 FROM next_collection_deletion_facts")
        : phase === "parent" ? sql.includes("FROM next_collections WHERE")
        : phase === "device" ? sql.includes("FROM next_service_devices")
        : phase === "revocation" ? sql.includes("revoked AS")
        : phase === "nonce" ? sql.startsWith(route === "challenge" ? "INSERT INTO next_device_challenges" : "UPDATE next_device_challenges SET used_at")
        : sources === 3;
      if (!hit) return;
      armed = false; injected = true;
      if (fact === "deletion") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [collection, randomUUID()]);
      else await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,42,2,2,$3)", [collection, account, "ab".repeat(32)]);
    });
    const f = await fixture(true, database, mode); collection = f.collection; account = f.account;
    try {
      const challenge = route === "read" ? await f.nonce() : null;
      armed = true;
      const result = await f.request(route, challenge ? f.proof(challenge) : { device_id: f.device });
      expect(injected, phase).toBe(true);
      expect(result.statusCode, result.body).toBe(409);
      if (challenge) expect(await unused(challenge)).toBe(true);
      else expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1", [f.collection])).rows[0].n).toBe(0);
    } finally { armed = false; await f.app.close(); }
  });
  it.each(["standard", "csv", "cohort"] as const)("serializes concurrent issue and single consume without a replacement nonce: %s", async mode => {
    const f = await fixture(true, db, mode);
    try {
      const issued = await Promise.all(Array.from({ length: 8 }, () => f.request("challenge", { device_id: f.device })));
      expect(issued.filter(r => r.statusCode === 200)).toHaveLength(1);
      expect(issued.filter(r => r.statusCode === 409 && r.json().error.code === "challenge_pending")).toHaveLength(7);
      const challenge = issued.find(r => r.statusCode === 200)!.json().challenge as string;
      const consumed = await Promise.all(Array.from({ length: 8 }, () => f.request("read", f.proof(challenge))));
      expect(consumed.filter(r => r.statusCode === 200)).toHaveLength(1);
      expect(consumed.filter(r => r.statusCode === 409 && r.json().error.code === "challenge_invalid")).toHaveLength(7);
      expect(await unused(challenge)).toBe(false);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1", [f.collection])).rows[0].n).toBe(1);
    } finally { await f.app.close(); }
  });
  it("keeps the database one-outstanding index stronger than the aggregate20 guard, and expiry releases it", async () => {
    const f = await fixture();
    try {
      const challenge = await f.nonce();
      // Twenty simultaneous unused rows are not a reachable schema state. Do
      // not drop the real index to fabricate an API/concurrency qualification.
      await expect(db.query(`INSERT INTO next_device_challenges
        (challenge,service_collection_id,service_device_id,service_purpose,service_audience,service_subject_hash,expires_at)
        SELECT $1,service_collection_id,service_device_id,service_purpose,service_audience,service_subject_hash,expires_at
        FROM next_device_challenges WHERE challenge=$2`, [Buffer.alloc(32, 0x93), Buffer.from(challenge, "hex")])).rejects.toMatchObject({ code: "23505" });
      expect((await f.request("challenge", { device_id: f.device })).json().error.code).toBe("challenge_pending");
      await db.query("UPDATE next_device_challenges SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE service_collection_id=$1", [f.collection]);
      expect(await f.nonce()).not.toBe(challenge);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1", [f.collection])).rows[0].n).toBe(1);
    } finally { await f.app.close(); }
  });
  it.each(["direct", "same-row-after", "same-row-before", "historic-reenrol", "other-device", "other-account"] as const)("preserves canonical permanent revocation/ordinality after consume: %s", async kind => {
    let armed = false, collection = "", device = "", account = "";
    // A genuine competing policy writer is parent/advisory-lock serialized
    // (tested below). This same-transaction fault tests the final fresh guard.
    const database = tapped(async (sql, client) => {
      if (!armed || !sql.startsWith("UPDATE next_device_challenges SET used_at")) return;
      armed = false;
      const enrol = { op: "device-enrol", device, account }, removal = { op: "member-remove", account };
      const ops = kind === "direct" ? [{ op: "device-revoke", device }]
        : kind === "other-device" ? [{ op: "device-revoke", device: randomUUID() }]
        : kind === "other-account" ? [enrol, { ...removal, account: randomUUID() }]
        : kind === "same-row-before" ? [removal, enrol] : [enrol, removal];
      await client.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [collection, { ops }]);
      if (kind === "historic-reenrol") await client.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [collection, { ops: [{ ...enrol, account: randomUUID() }] }]);
    });
    const f = await fixture(true, database); collection = f.collection; device = f.device; account = f.account;
    try {
      const challenge = await f.nonce(); armed = true;
      const result = await f.request("read", f.proof(challenge));
      expect(armed).toBe(false);
      const denied = ["direct", "same-row-after", "historic-reenrol"].includes(kind);
      expect(result.statusCode, result.body).toBe(denied ? 409 : 200);
      expect(await unused(challenge)).toBe(denied);
    } finally { armed = false; await f.app.close(); }
  });
  it("holds the exact device key share lock across proof/nonce/final-read until COMMIT", async () => {
    let release!: () => void, observed!: () => void, armed = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { observed = resolve; });
    const database = tapped(async sql => { if (armed && sql.includes("FROM next_service_devices")) { armed = false; observed(); await gate; } });
    const f = await fixture(true, database), writer = await db.connect();
    let pending: ReturnType<typeof f.request> | undefined;
    try {
      const challenge = await f.nonce(); armed = true;
      pending = f.request("read", f.proof(challenge)); void pending.then(() => undefined);
      await seen;
      await writer.query("BEGIN"); await writer.query("SET LOCAL lock_timeout='150ms'");
      await expect(writer.query("UPDATE next_service_devices SET sign_pk=$2 WHERE collection_id=$1", [f.collection, Buffer.alloc(32, 0x61)])).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
      await writer.query("BEGIN"); await writer.query("SET LOCAL lock_timeout='150ms'");
      await expect(writer.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [f.collection,
        { ops: [{ op: "device-revoke", device: f.device }] }])).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK"); release();
      expect((await pending).statusCode).toBe(200);
    } finally { release(); await pending; await writer.query("ROLLBACK"); writer.release(); await f.app.close(); }
  });
  it("a genuine device lock timeout refuses without issuing a nonce", async () => {
    const f = await fixture(), holder = await db.connect();
    try {
      await holder.query("BEGIN"); await holder.query("SELECT device_id FROM next_service_devices WHERE collection_id=$1 FOR UPDATE", [f.collection]);
      const result = await f.request("challenge", { device_id: f.device });
      expect(result.statusCode, result.body).toBe(503); expect(result.json().error.code).toBe("busy");
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1", [f.collection])).rows[0].n).toBe(0);
    } finally { await holder.query("ROLLBACK"); holder.release(); await f.app.close(); }
  }, 15_000);
  it("a real reciprocal device/advisory deadlock refuses with no claim outcome", async () => {
    let armed = true, collection = "", databaseError: string | undefined, observed!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { observed = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const database = tapped(async (sql, client) => {
      if (sql === "BEGIN") await client.query("SET LOCAL deadlock_timeout='50ms'");
      if (armed && sql.includes("FROM next_collections WHERE")) { armed = false; observed(); await gate; }
    }, error => { databaseError = (error as { code?: string }).code; });
    const f = await fixture(true, database), holder = await db.connect(); collection = f.collection;
    let pending: ReturnType<typeof f.request> | undefined, waiting: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN"); await holder.query("SET LOCAL statement_timeout='5s'"); await holder.query("SET LOCAL deadlock_timeout='5s'");
      await holder.query("SELECT device_id FROM next_service_devices WHERE collection_id=$1 FOR UPDATE", [collection]);
      pending = f.request("challenge", { device_id: f.device }); void pending.then(() => undefined);
      await seen;
      waiting = holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 20261005))", [collection]);
      release(); const result = await pending;
      expect(databaseError).toBe("40P01");
      expect(result.statusCode, result.body).toBe(503); expect(result.json().error.code).toBe("busy");
      await waiting;
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1", [collection])).rows[0].n).toBe(0);
    } finally { release(); await pending; await waiting?.catch(() => undefined); await holder.query("ROLLBACK"); holder.release(); await f.app.close(); }
  }, 15_000);
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
  it("scopes all released frozen cohort members to the LAB credential before nonce or proof effects", async () => {
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
      expect((await request(other, "challenge", { device_id: other.device }, token)).statusCode).toBe(403);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_device_id=ANY($1::uuid[])", [[own.device, other.device]])).rows[0].n).toBe(0);
      const challenge = (await request(own, "challenge", { device_id: own.device }, migrationToken)).json().challenge as string;
      expect(challenge).toMatch(/^[0-9a-f]{64}$/u);
      expect((await request(own, "read", own.proof(challenge), token)).statusCode).toBe(403);
      expect(await unused(challenge)).toBe(true);
      expect((await request(own, "read", own.proof(challenge), migrationToken)).statusCode).toBe(200);
      expect((await request(other, "challenge", { device_id: other.device }, migrationToken)).statusCode).toBe(200);
    } finally { await scoped.close(); await own.app.close(); await other.app.close(); }
  });

  it("admits CSV and additional canonical DB cohort members only through the LAB role", async () => {
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
      // This third account is not in CSV, but has its own authoritative released
      // frozen cohort. Other eligible cohorts are DATA, not a refusal condition.
      expect((await request(outside, "challenge", { device_id: outside.device }, token)).statusCode).toBe(403);
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_device_id=$1", [outside.device])).rows[0].n).toBe(0);
      expect((await request(outside, "challenge", { device_id: outside.device }, migrationToken)).statusCode).toBe(200);
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
  it("allows 445 sequential fresh issue/consume cycles without counting consumed nonces against the cap", async () => {
    const f = await fixture(), seen = new Set<string>();
    try {
      for (let i = 0; i < 445; i++) {
        const challenge = await f.nonce();
        expect(seen.has(challenge)).toBe(false); seen.add(challenge);
        expect((await f.request("read", f.proof(challenge))).statusCode).toBe(200);
      }
      expect(seen.size).toBe(445);
      // All recent consumed rows still exist: success is not cleanup, a time
      // advance, nonce reuse, or a test-only bypass of one-live enforcement.
      expect((await db.query("SELECT count(*)::int AS n FROM next_device_challenges WHERE service_collection_id=$1 AND used_at IS NOT NULL", [f.collection])).rows[0].n).toBe(445);
      const next = await f.nonce();
      expect((await f.request("challenge", { device_id: f.device })).statusCode).toBe(409);
      expect((await f.request("read", f.proof(next))).statusCode).toBe(200);
      expect((await f.request("read", f.proof(next))).statusCode).toBe(409);
    } finally { await f.app.close(); }
  }, 60_000);
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
