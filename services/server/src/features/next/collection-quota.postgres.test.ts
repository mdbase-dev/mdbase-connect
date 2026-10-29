import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { inTransaction } from "./bootstrap-common.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const root = Buffer.alloc(16, 17);

describePg("native synced collection entitlement admission", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Quota tests require dedicated local test Postgres.");
    schema = `collection_quota_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function account(profile?: string) {
    const owner = randomUUID();
    await db.query("INSERT INTO users(id,email,name,account_backend) VALUES($1,$2,'Quota fixture','next')", [owner, `${owner}@example.test`]);
    if (profile) await grant(owner, profile);
    return owner;
  }
  async function grant(owner: string, profile: string) {
    await db.query("INSERT INTO account_entitlement_grants(id,user_id,profile_code,source) VALUES($1,$2,$3,'operator')", [randomUUID(), owner, profile]);
  }
  function register(owner: string, collection = randomUUID(), sync: "cloud_copy" | "private" = "cloud_copy", runtime: "next" | "shadow" = "next") {
    return inTransaction(db, client => registerNextCollection(client, {
      collectionId: collection, ownerUserId: owner, runtime, sync, rootKeyId: root,
      ops: [{ op: "genesis", owner, root, state: sync === "private" ? "e2e" : "cloud-copy" }, { op: "member-set", account: owner, role: "owner" }]
    }));
  }
  async function count(owner: string) {
    return Number((await db.query("SELECT count(*) FROM next_collections WHERE owner_user_id=$1", [owner])).rows[0].count);
  }

  it.each([["open_beta_v1", 3], ["beta_v1", 10]] as const)("allows %s's allowance of %i and refuses the next insert without an outbox", async (profile, limit) => {
    const owner = await account(profile);
    for (let index = 0; index < limit; index++) await register(owner, randomUUID(), index % 2 ? "private" : "cloud_copy");
    const refused = randomUUID();
    await expect(register(owner, refused)).rejects.toMatchObject({ status: 429, code: "account_collection_quota_exceeded" });
    expect(await count(owner)).toBe(limit);
    expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1", [refused])).rows).toEqual([]);
  });

  it("serializes different collection UUIDs competing for the last slot", async () => {
    const owner = await account("open_beta_v1");
    await register(owner); await register(owner);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => register(owner)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter(result => result.status === "rejected");
    expect(failures).toHaveLength(7);
    for (const result of failures) expect(result.reason).toMatchObject({ status: 429, code: "account_collection_quota_exceeded" });
    expect(await count(owner)).toBe(3);
  });

  it("deletion facts and leaving sync free slots, even while metadata remains", async () => {
    const owner = await account("free_v1"), deleted = randomUUID(), left = randomUUID();
    await register(owner, deleted);
    await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'cp-intent')", [deleted, randomUUID()]);
    await register(owner, left, "private");
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [left]);
    await register(owner);
    await expect(register(owner)).rejects.toMatchObject({ code: "account_collection_quota_exceeded" });
    expect(await count(owner)).toBe(3);
  });

  it("counts owners, not shared memberships, local catalogs or SHADOW imports", async () => {
    const owner = await account("free_v1"), other = await account("free_v1"), shared = randomUUID();
    await register(other, shared);
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [shared, JSON.stringify({ version: 1, ops: [{ op: "member-set", account: owner, role: "editor" }] })]);
    await register(owner, randomUUID(), "cloud_copy", "shadow");
    const connector = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Local fixture',$3)", [connector, owner, randomUUID()]);
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version) VALUES($1,$2,$3,$4,'Local fixture','0.3.0')", [randomUUID(), owner, connector, randomUUID()]);
    await register(owner);
    await expect(register(owner)).rejects.toMatchObject({ code: "account_collection_quota_exceeded" });
    await register(owner, randomUUID(), "cloud_copy", "shadow");
  });

  it("uses the effective maximum across active grants and keeps over-limit collections", async () => {
    const owner = await account("free_v1");
    await grant(owner, "open_beta_v1");
    await register(owner); await register(owner); await register(owner);
    await db.query("UPDATE account_entitlement_grants SET revoked_at=now() WHERE user_id=$1 AND profile_code='open_beta_v1'", [owner]);
    await expect(register(owner)).rejects.toMatchObject({ code: "account_collection_quota_exceeded" });
    expect(await count(owner)).toBe(3);
  });

  it("fails closed without an active entitlement", async () => {
    const owner = await account();
    await expect(register(owner)).rejects.toMatchObject({ name: "HostedEntitlementRequiredError" });
    await grant(owner, "beta_v1");
    await db.query("UPDATE account_entitlement_grants SET ends_at=now() WHERE user_id=$1", [owner]);
    await expect(register(owner)).rejects.toMatchObject({ name: "HostedEntitlementRequiredError" });
    expect(await count(owner)).toBe(0);
  });

  it("rolls back the collection and outbox together without consuming a slot", async () => {
    const owner = await account("free_v1"), collection = randomUUID();
    await expect(inTransaction(db, async client => {
      await registerNextCollection(client, { collectionId: collection, ownerUserId: owner, runtime: "next", sync: "cloud_copy", rootKeyId: root,
        ops: [{ op: "genesis", owner, root, state: "cloud-copy" }] });
      throw new Error("synthetic registration failure");
    })).rejects.toThrow("synthetic registration failure");
    expect(await count(owner)).toBe(0);
    expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1", [collection])).rows).toEqual([]);
    await register(owner);
  });
});
