import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPLICATION_CAPABILITY_DEFINITIONS } from "@mdbase-dev/connect-protocol";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { createHostedCollectionMembership } from "../../collection-policy.js";
import { LocalRelayBroker } from "../../relay-broker.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { registerNextRouteRoutes } from "./route-routes.js";
import { parseServiceDevice, storeServiceDevice } from "./service-devices.js";
import { queueNextPolicy, registerNextCollection } from "./policy-outbox.js";
import { certDigest, chainHash, keyId, signPolicyItem, type PolicyOp } from "./policy-wire.js";
import { ed25519RawPublicKey } from "./policy-keys.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const now = 1_800_000_000_000;
const root = generateKeyPairSync("ed25519"); const policy = generateKeyPairSync("ed25519");
const unsigned = { policyPublicKey: ed25519RawPublicKey(policy.publicKey), root: keyId(ed25519RawPublicKey(root.publicKey)), notBefore: now - 1000, notAfter: now + 100_000 };
const signer = { privateKey: policy.privateKey, cert: { ...unsigned, signature: sign(null, certDigest(unsigned), root.privateKey) } };

suite("hosted Noise discovery (real Postgres, not serving qualification)", () => {
  let admin: pg.Pool; let db: DatabasePool; let schema: string;
  const app = Fastify(); const broker = new LocalRelayBroker();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Hosted route tests require a dedicated local test database.");
    schema = `hosted_route_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerNextRouteRoutes(app, { db, publicUrl: "https://connect.example", broker, hostedClientUrl: "https://hosted.example" });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await broker.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function append(id: string, seq: number, ops: PolicyOp[], state = "appended") {
    const previous = (await db.query<{ item: Buffer }>("SELECT item FROM next_policy_batches WHERE collection_id=$1 AND seq=$2 ORDER BY id DESC LIMIT 1", [id, seq - 1])).rows[0];
    const prev = previous ? Buffer.from(chainHash(previous.item)) : Buffer.alloc(32);
    const batch = (await db.query<{ id: string }>("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [
      id, seq, prev, Buffer.from(signPolicyItem(signer, { collection: id, seq, prev, issuedAt: now + seq, previousIssuedAt: now + seq - 1, ops })), now + seq, state
    ])).rows[0]!.id;
    await db.query("UPDATE next_policy_outbox SET batch_id=$2 WHERE collection_id=$1 AND batch_id IS NULL", [id, batch]);
    return batch;
  }
  async function fixture(options: { hostedOnly?: boolean; sync?: "private" | "cloud_copy"; runtime?: "shadow" | "next"; appended?: boolean; daemon?: boolean } = {}) {
    const id = await localGrantFixture(db); const token = `at_${randomUUID()}`;
    await db.query("UPDATE grants SET activated_at=now(), operations=$2, file_capability=$3, application_installation_id=$4, application_authorization=$5 WHERE id=$1", [id,
      JSON.stringify(APPLICATION_CAPABILITY_DEFINITIONS["collection.read"]), JSON.stringify({ kind: "files", protocol_version: 1, actions: ["list", "read"], scope: { kind: "collection" } }), randomUUID(),
      JSON.stringify({ binding: { application_declaration_id: "dev.example.reader", contracts: { semantic_capabilities: 2 } } })]);
    await db.query("UPDATE collections SET enabled=true,present=true,authority_state='active' WHERE id=$1", [id]);
    if (options.hostedOnly) {
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$1,'Hosted fixture','mdbase','active')", [id]);
      await db.query("UPDATE grants SET collection_id=NULL,hosted_collection_id=$1,logical_collection_id=$1 WHERE id=$1", [id]);
    }
    await db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)", [id, randomBytes(32)]);
    await db.query("INSERT INTO access_tokens(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [randomUUID(), tokenHash(token), id]);
    const record = parseServiceDevice({ kind: "hosted", device_id: randomUUID(), sign_pk: "03".repeat(32), kem_pk: "04".repeat(32), noise_pk: "05".repeat(32), wrapped_keys: Buffer.from("isolated-test-wrapped").toString("base64"), kms_key_arn: "arn:aws:kms:eu-west-1:000000000000:key/test" });
    const sync = options.sync ?? "cloud_copy";
    const ops: PolicyOp[] = [{ op: "genesis", owner: id, root: unsigned.root, state: sync === "private" ? "e2e" : "cloud-copy" }];
    if (sync === "cloud_copy") ops.push({ op: "device-enrol", device: record.device_id, account: "00000000-0000-0000-0000-000000000000", kind: "hosted", signPublicKey: record.sign_pk, kemPublicKey: record.kem_pk, noisePublicKey: record.noise_pk });
    await registerNextCollection(db, { collectionId: id, ownerUserId: id, runtime: options.runtime ?? "next", sync, rootKeyId: unsigned.root, ops });
    if (sync === "cloud_copy") await storeServiceDevice(db, id, record);
    const batch = await append(id, 1, ops, options.appended === false ? "sending" : "appended");
    const daemon = randomUUID();
    if (options.daemon) await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,'desktop',$3,$4,$5)", [daemon, id, randomBytes(32), randomBytes(32), randomBytes(32)]);
    const route = (collection = id, bearer = token) => app.inject({ method: "GET", url: `/v1/next/collections/${collection}/route`, headers: { authorization: `Bearer ${bearer}` } });
    return { id, token, record, batch, daemon, route };
  }

  it("puts the exact fixed-path hosted target first and preserves daemon fallback; online remains false", async () => {
    const f = await fixture({ daemon: true });
    const response = await f.route(f.id.toUpperCase());
    expect(response.statusCode).toBe(200);
    expect(response.json().targets.map((target: { kind: string }) => target.kind)).toEqual(["hosted", "desktop"]);
    expect(response.json().targets[0]).toEqual({ kind: "hosted", device: f.record.device_id, noise_pk: f.record.noise_pk.toString("hex"), url: `wss://hosted.example/v1/hosted/app?collection=${f.id}`, online: false });
    await db.query("UPDATE next_service_devices SET activated_at=now(),activation_batch_id=$2 WHERE collection_id=$1", [f.id, f.batch]);
    expect((await f.route()).json().targets[0].online).toBe(false);
  });

  it("supports hosted-only grants without a daemon authority row", async () => {
    const f = await fixture({ hostedOnly: true });
    const response = await f.route();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ collection: f.id, grant: f.id, targets: [{ kind: "hosted", device: f.record.device_id }] });
    await db.query("UPDATE hosted_collections SET authority_state='transferring' WHERE id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(401);
  });

  it("a recorded/pending/lost enrolment does not create a target, and a later appended revoke removes it", async () => {
    const f = await fixture({ appended: false, daemon: true });
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_policy_batches SET state='appended' WHERE id=$1", [f.batch]);
    expect((await f.route()).json().targets[0].kind).toBe("hosted");
    await db.query("UPDATE next_policy_batches SET lost_at=now() WHERE id=$1", [f.batch]);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_policy_batches SET lost_at=NULL WHERE id=$1", [f.batch]);
    const ops: PolicyOp[] = [{ op: "device-revoke", device: f.record.device_id }];
    await queueNextPolicy(db, f.id, ops); await append(f.id, 2, ops);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
  });

  it("private, shadow and left-sync collections never disclose a hosted target", async () => {
    for (const options of [{ sync: "private" as const }, { runtime: "shadow" as const }]) {
      const f = await fixture({ ...options, daemon: true });
      expect((await f.route()).json().targets.every((target: { kind: string }) => target.kind !== "hosted")).toBe(true);
    }
    const f = await fixture({ daemon: true });
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.id]);
    expect((await f.route()).json().targets.every((target: { kind: string }) => target.kind !== "hosted")).toBe(true);
  });

  it("requires the exact live token/grant/account/key and denies other collections", async () => {
    const f = await fixture({ hostedOnly: true });
    expect((await f.route(randomUUID())).statusCode).toBe(401);
    expect((await f.route(f.id, "unknown-token")).statusCode).toBe(401);
    await db.query("DELETE FROM next_grant_client_keys WHERE grant_id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(409);
    await db.query("INSERT INTO next_grant_client_keys(grant_id,client_pk) VALUES($1,$2)", [f.id, randomBytes(32)]);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(401);
    await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.id]);
    await db.query("UPDATE access_tokens SET revoked_at=now() WHERE token_hash=$1", [tokenHash(f.token)]);
    expect((await f.route()).statusCode).toBe(401);
  });

  it("shared grants require the exact active member-policy binding and an unsuspended owner", async () => {
    const f = await fixture({ hostedOnly: true }); const member = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Member')", [member, `${member}@example.test`]);
    const policy = await createHostedCollectionMembership(db, { collectionId: f.id, ownerUserId: f.id, userId: member, role: "viewer" });
    await db.query("UPDATE grants SET user_id=$2,membership_id=$3,membership_policy_id=$4,membership_policy_revision=$5 WHERE id=$1", [f.id, member, policy.membershipId, policy.id, policy.revision]);
    expect((await f.route()).json().targets[0].kind).toBe("hosted");
    const nextPolicy = randomUUID();
    await db.query(`INSERT INTO collection_membership_policies
      (id,membership_id,revision,role,preset_version,actions,operations,scope_ceiling,file_ceiling)
      SELECT $2,membership_id,2,role,preset_version,actions,operations,scope_ceiling,file_ceiling
      FROM collection_membership_policies WHERE id=$1`, [policy.id, nextPolicy]);
    await db.query("UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=2 WHERE id=$1", [policy.membershipId, nextPolicy]);
    expect((await f.route()).statusCode).toBe(401);
    await db.query("UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=$3 WHERE id=$1", [policy.membershipId, policy.id, policy.revision]);
    await db.query("UPDATE collection_memberships SET state='revoking' WHERE id=$1", [policy.membershipId]);
    expect((await f.route()).statusCode).toBe(401);
    await db.query("UPDATE collection_memberships SET state='active' WHERE id=$1", [policy.membershipId]);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.id]);
    expect((await f.route()).statusCode).toBe(401);
  });

  it("waits behind a cloud-copy transition and never returns pre-lock metadata after leave commits", async () => {
    const f = await fixture({ daemon: true }); const lock = await db.connect(); let pending: ReturnType<typeof f.route> | undefined;
    try {
      await lock.query("BEGIN");
      const pid = (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await lock.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.id]);
      pending = f.route();
      const deadline = Date.now() + 4000; let blocked = false;
      while (Date.now() < deadline) {
        const rows = await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
        if (rows.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await lock.query("COMMIT");
      expect((await pending).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    } finally { await lock.query("ROLLBACK"); lock.release(); await pending; }
  });

  it("never uses a mismatched/zero service key or an unappended replacement as a current target", async () => {
    const f = await fixture({ daemon: true });
    await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1", [f.id, Buffer.alloc(32)]);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1", [f.id, randomBytes(32)]);
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    const noise = randomBytes(32);
    await db.query("UPDATE next_service_devices SET noise_pk=$2 WHERE collection_id=$1", [f.id, noise]);
    const ops: PolicyOp[] = [{ op: "device-enrol", device: f.record.device_id, account: "00000000-0000-0000-0000-000000000000", kind: "hosted", signPublicKey: f.record.sign_pk, kemPublicKey: f.record.kem_pk, noisePublicKey: noise }];
    await queueNextPolicy(db, f.id, ops); const replacement = await append(f.id, 2, ops, "sending");
    expect((await f.route()).json().targets.map((target: { kind: string }) => target.kind)).toEqual(["desktop"]);
    await db.query("UPDATE next_policy_batches SET state='appended' WHERE id=$1", [replacement]);
    expect((await f.route()).json().targets[0].noise_pk).toBe(noise.toString("hex"));
  });
});
