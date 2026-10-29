import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { deleteAccountLocally } from "../../account-management.js";
import { revokeHostedCollectionMembership } from "../../collection-membership-lifecycle.js";
import { createHostedCollectionMembership, type CollectionMembershipPolicy } from "../../collection-policy.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { inTransaction } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;

type Op = { op: string; account?: string };

describePg("account deletion on native collections (dedicated local Postgres)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `account_deletion_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  /** A next account with a browser session and one enrolled desktop device. */
  async function account() {
    const sessionToken = randomUUID();
    const id = randomUUID(), connector = randomUUID(), device = randomUUID(), email = `${id}@example.test`;
    await db.query("INSERT INTO users(id,email,name,account_backend,session_epoch) VALUES($1,$2,'Person','next',1)", [id, email]);
    await db.query("INSERT INTO email_identities(id,user_id,email,normalized_email,verified_at,is_primary) VALUES($1,$2,$3,$3,now(),true)", [randomUUID(), id, email]);
    await db.query("INSERT INTO account_entitlement_grants(id,user_id,profile_code,source,source_reference) VALUES($1,$2,'beta_v1','operator',$3)", [randomUUID(), id, randomUUID()]);
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',1,now()+interval '1 day')", [randomUUID(), id, tokenHash(sessionToken)]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Desktop',$3)", [connector, id, tokenHash(randomUUID())]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, connector, id, randomBytes(32), randomBytes(32), randomBytes(32)]);
    return { id, connector, device, cookie: `mdbase_session=${sessionToken}` };
  }
  type Account = Awaited<ReturnType<typeof account>>;

  async function collection(owner: Account) {
    const id = randomUUID(), root = randomBytes(32);
    await inTransaction(db, client => registerNextCollection(client, {
      collectionId: id, ownerUserId: owner.id, runtime: "next", sync: "cloud_copy", rootKeyId: root,
      ops: [{ op: "genesis", owner: owner.id, root, state: "cloud-copy" }, { op: "member-set", account: owner.id, role: "owner" }]
    }));
    return id;
  }

  const join = (collectionId: string, owner: Account, member: Account) =>
    createHostedCollectionMembership(db, { collectionId, ownerUserId: owner.id, userId: member.id, role: "editor" });

  /** A native app grant bound to the member's current membership policy. */
  async function grant(user: Account, policy: CollectionMembershipPolicy) {
    const id = randomUUID(), app = randomUUID();
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'App','https://example.test','[]')", [app, app]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,next_collection_id,logical_collection_id,membership_id,membership_policy_id,membership_policy_revision,
        operations,application_installation_id,application_authorization)
      VALUES($1,$2,$3,$4,$4,$5,$6,$7,'["read"]','installation','{"binding":{"protocol_version":4,"contracts":{}}}')`,
    [id, user.id, app, policy.collectionId, policy.membershipId, policy.id, policy.revision]);
    return id;
  }

  const ops = async (collectionId: string, accountId: string): Promise<Op[]> =>
    (await db.query<{ ops: { ops: Op[] } }>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [collectionId]))
      .rows.flatMap(row => row.ops.ops).filter(op => op.account === accountId);

  /** Rows still pointing at `value` through any single-column foreign key to `table`. */
  async function references(table: string, value: string) {
    const keys = await db.query<{ child: string; column: string }>(
      `SELECT c.conrelid::regclass::text AS child, a.attname AS column FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
       WHERE c.contype='f' AND c.confrelid=$1::regclass AND cardinality(c.conkey)=1`, [table]);
    expect(keys.rows.length).toBeGreaterThan(5);
    const left: string[] = [];
    for (const { child, column } of keys.rows) {
      const count = (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${child} WHERE "${column}"=$1`, [value])).rows[0]!.n;
      if (count !== "0") left.push(`${child}.${column}=${count}`);
    }
    return left;
  }

  it("reports every owned collection in the account deletion summary", async () => {
    const owner = await account(), other = await account();
    const cloud = await collection(owner), privateCollection = await collection(owner), left = await collection(owner);
    await db.query("UPDATE next_collections SET sync='private' WHERE collection_id=$1", [privateCollection]);
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [left]);
    const shared = await collection(other);
    await join(shared, other, owner);
    await db.query(`INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)`, [randomUUID(), owner.id, randomBytes(32)]);
    // Legacy and next-runtime rows with the same id count as one collection.
    await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,contracts) VALUES($1,$2,'Migrated','mdbase','[]'),($3,$2,'Legacy','mdbase','[]')`, [cloud, owner.id, randomUUID()]);
    const { app } = await buildApp({ db, publicUrl: "https://connect.example", registration: "open", authRateLimitSecret: "account-test-rate-limit-secret-with-32-bytes" });
    try {
      const result = await app.inject({ method: "GET", url: "/v1/account", headers: { cookie: owner.cookie } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ backend: "next", deletion: { hosted_collections: 2, owned_collections: 4 } });
    } finally { await app.close(); }
  });

  it("erases the account, permanently denies its own collections and removes it from other people's", async () => {
    const deleted = await account(), member = await account(), other = await account();
    // The account's own collection, shared with a member who has an app grant on it.
    const owned = await collection(deleted);
    const memberGrant = await grant(member, await join(owned, deleted, member));
    // Someone else's collection the account belongs to (with an app grant), and one it already left.
    const shared = await collection(other), left = await collection(other);
    await grant(deleted, await join(shared, other, deleted));
    const leftMembership = await join(left, other, deleted);
    await revokeHostedCollectionMembership(db, { collectionId: left, actorUserId: other.id, membershipId: leftMembership.membershipId });

    await deleteAccountLocally(db, { userId: deleted.id, sessionId: randomUUID(), authorized: true, queueProviderCleanup: false });

    // Nothing references the account or its collection; only the audit trail is kept, anonymised.
    expect(await references("users", deleted.id)).toEqual([]);
    expect(await references("next_collections", owned)).toEqual([]);
    expect((await db.query("SELECT 1 FROM grants WHERE id=$1", [memberGrant])).rows).toEqual([]);
    expect((await db.query("SELECT event_type FROM audit_events WHERE subject_id=$1 AND event_type='account.deleted'", [deleted.id])).rows).toHaveLength(1);

    // Its collection id stays denied after the rows cascade away, so it can never be reused.
    await expect(requireCollectionNotDeleted(db, owned)).rejects.toThrow("collection_deleted");
    expect((await db.query("SELECT authority,actor_id FROM next_collection_deletion_facts WHERE collection_id=$1", [owned])).rows)
      .toEqual([{ authority: "cp-intent", actor_id: deleted.id }]);

    // Other owners' logs revoke the account's devices exactly once; an earlier removal is not repeated.
    expect(await ops(shared, deleted.id)).toEqual([{ op: "member-set", account: deleted.id, role: "editor" }, { op: "member-remove", account: deleted.id }]);
    expect(await ops(left, deleted.id)).toEqual([{ op: "member-set", account: deleted.id, role: "editor" }, { op: "member-remove", account: deleted.id }]);
    await requireCollectionNotDeleted(db, shared);

    // Everyone else keeps their account, sessions, devices and collections.
    for (const person of [member, other]) {
      expect((await db.query("SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id JOIN next_devices d ON d.user_id=u.id WHERE u.id=$1", [person.id])).rows).toHaveLength(1);
    }
    expect((await db.query("SELECT collection_id FROM next_collections WHERE owner_user_id=$1 ORDER BY collection_id", [other.id])).rows.map(row => row.collection_id))
      .toEqual([shared, left].sort());
  });
});
