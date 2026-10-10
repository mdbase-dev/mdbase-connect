import { randomBytes, randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import { acceptHostedCollectionInvitation, createHostedCollectionInvitation } from "./collection-invitations.js";
import { changeHostedCollectionMembershipRole, finalizeReadyMembershipTransitions, revokeHostedCollectionMembership } from "./collection-membership-lifecycle.js";
import { createHostedCollectionMembership, type CollectionMembershipPolicy } from "./collection-policy.js";
import { registerHostedSharingRoutes } from "./features/hosted/sharing-routes.js";
import { refuseRevoked } from "./features/next/bootstrap-common.js";
import { registerErrorHandler } from "./platform/error-handler.js";
import { tokenHash } from "./security.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;

type Op = { op: string; account?: string; role?: string; grant?: string };

suite("transactional membership policy and native sharing (isolated PostgreSQL)", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const app = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Membership tests require dedicated local test PostgreSQL.");
    schema = `membership_policy_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await app.register(cookie);
    registerErrorHandler(app);
    registerHostedSharingRoutes(app, { db, hostedCollections: true, hostedSharing: true });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function account(entitled = false) {
    const id = randomUUID(), email = `${id}@example.test`;
    await db.query("INSERT INTO users(id,email,name,account_backend,session_epoch) VALUES($1,$2,'Person','next',1)", [id, email]);
    await db.query("INSERT INTO email_identities(id,user_id,email,normalized_email,verified_at,is_primary) VALUES($1,$2,$3,$3,now(),true)", [randomUUID(), id, email]);
    if (entitled) {
      await db.query("INSERT INTO account_entitlement_grants(id,user_id,profile_code,source,source_reference) VALUES($1,$2,'beta_v1','operator',$3)", [randomUUID(), id, randomUUID()]);
      await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)", [id, randomUUID()]);
    }
    return { id, email };
  }

  async function fixture(sync: "private" | "cloud_copy" | "legacy" | "shadow" = "cloud_copy", retainedHosted = false) {
    const owner = await account(true), member = await account(), collection = randomUUID();
    if (sync !== "legacy") await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,$3,$4,$5)", [collection, owner.id, sync === "shadow" ? "shadow" : "next", sync === "private" ? "private" : "cloud_copy", randomBytes(16)]);
    if (retainedHosted || sync === "legacy" || sync === "shadow") await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Shared','mdbase','https://provider.example','active')", [collection, owner.id]);
    return { owner, member, collection };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const createMember = (f: Fixture, role: "viewer" | "editor" = "editor", pool = db) => createHostedCollectionMembership(pool, { collectionId: f.collection, ownerUserId: f.owner.id, userId: f.member.id, role });
  const ops = async (collection: string): Promise<Op[]> => (await db.query<{ ops: { version: number; ops: Op[] } }>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [collection])).rows.flatMap(row => {
    expect(row.ops.version).toBe(1);
    return row.ops.ops;
  });
  const memberOps = async (f: Fixture) => (await ops(f.collection)).filter(op => op.account === f.member.id);
  const invite = (f: Fixture) => createHostedCollectionInvitation(db, { collectionId: f.collection, actorUserId: f.owner.id, role: "editor", target: { email: f.member.email } });
  async function session(user: string) {
    const token = randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',1,now()+interval '1 day')", [randomUUID(), user, tokenHash(token)]);
    return { cookie: `mdbase_session=${token}` };
  }

  it.each(["cloud_copy", "private"] as const)("creates %s membership without a legacy hosted row, with one exact policy op", async sync => {
    const f = await fixture(sync), membership = await createMember(f);
    expect(membership).toMatchObject({ role: "editor", revision: 1 });
    expect((await db.query("SELECT id FROM hosted_collections WHERE id=$1", [f.collection])).rows).toEqual([]);
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "editor" }]);
    await expect(createMember(f)).rejects.toThrow("already has an active membership");
    expect(await memberOps(f)).toHaveLength(1);
  });

  it("reuses existing browser invitation, acceptance, listing, role and removal routes", async () => {
    const f = await fixture(), ownerHeaders = await session(f.owner.id), memberHeaders = await session(f.member.id);
    const base = `/v1/hosted/collections/${f.collection}`;
    expect((await app.inject({ method: "GET", url: `${base}/members` })).statusCode).toBe(401);
    const invited = await app.inject({ method: "POST", url: `${base}/invitations`, headers: ownerHeaders, payload: { email: f.member.email, role: "editor" } });
    expect(invited.statusCode, invited.body).toBe(202);
    expect(await ops(f.collection)).toEqual([]);
    const accepted = await app.inject({ method: "POST", url: "/v1/hosted/collection-invitations/accept", headers: memberHeaders, payload: { token: invited.json().invitation.token } });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const membership = accepted.json().membership.id;
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "editor" }]);
    const listed = await app.inject({ method: "GET", url: `${base}/members`, headers: ownerHeaders });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().members.map((row: { role: string }) => row.role)).toEqual(["owner", "editor"]);
    expect((await app.inject({ method: "GET", url: `${base}/members`, headers: memberHeaders })).statusCode).toBe(404);
    const changed = await app.inject({ method: "PATCH", url: `${base}/members/${membership}`, headers: ownerHeaders, payload: { role: "viewer" } });
    expect(changed.statusCode, changed.body).toBe(200);
    const removed = await app.inject({ method: "DELETE", url: `${base}/members/${membership}`, headers: ownerHeaders });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(await memberOps(f)).toEqual([
      { op: "member-set", account: f.member.id, role: "editor" },
      { op: "member-set", account: f.member.id, role: "viewer" },
      { op: "member-remove", account: f.member.id }
    ]);
  });

  it("accepts an invitation concurrently once, reserving one seat and enqueueing one member", async () => {
    const f = await fixture(), invitation = await invite(f);
    const results = await Promise.allSettled([0, 1].map(() => acceptHostedCollectionInvitation(db, { userId: f.member.id, token: invitation.token })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await db.query("SELECT id FROM collection_memberships WHERE collection_id=$1", [f.collection])).rows).toHaveLength(1);
    expect((await db.query("SELECT id FROM account_collection_member_seats WHERE collection_id=$1 AND released_at IS NULL", [f.collection])).rows).toHaveLength(1);
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "editor" }]);
  });

  it("refuses the wrong target and expired invitation without publishing policy", async () => {
    const f = await fixture(), invitation = await invite(f), outsider = await account();
    await expect(acceptHostedCollectionInvitation(db, { userId: outsider.id, token: invitation.token })).rejects.toThrow("invalid or unavailable");
    await db.query("UPDATE collection_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE collection_id=$1", [f.collection]);
    await expect(acceptHostedCollectionInvitation(db, { userId: f.member.id, token: invitation.token })).rejects.toThrow("invalid or unavailable");
    expect(await ops(f.collection)).toEqual([]);
  });

  function failCommit(): DatabasePool {
    return {
      query: db.query.bind(db), end: async () => {},
      connect: async () => {
        const connection = await db.connect(), query = connection.query.bind(connection);
        connection.query = (text, values) => text === "COMMIT" ? Promise.reject(new Error("injected pre-commit failure")) : query(text, values);
        return connection;
      }
    };
  }

  it("rolls membership and outbox back together after enqueue", async () => {
    const f = await fixture();
    await expect(createMember(f, "editor", failCommit())).rejects.toThrow("injected pre-commit failure");
    expect((await db.query("SELECT id FROM collection_memberships WHERE collection_id=$1", [f.collection])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM collection_identities WHERE id=$1", [f.collection])).rows).toEqual([]);
    expect(await ops(f.collection)).toEqual([]);
  });

  it("rolls acceptance, seat and policy back together and retains the single-use token", async () => {
    const f = await fixture(), invitation = await invite(f);
    await expect(acceptHostedCollectionInvitation(failCommit(), { userId: f.member.id, token: invitation.token })).rejects.toThrow("injected pre-commit failure");
    expect((await db.query("SELECT state FROM collection_invitations WHERE id=$1", [invitation.id])).rows).toEqual([{ state: "pending" }]);
    expect((await db.query("SELECT id FROM account_collection_member_seats WHERE collection_id=$1", [f.collection])).rows).toEqual([]);
    expect(await ops(f.collection)).toEqual([]);
    await expect(acceptHostedCollectionInvitation(db, { userId: f.member.id, token: invitation.token })).resolves.toMatchObject({ collectionId: f.collection });
    expect(await memberOps(f)).toHaveLength(1);
  });

  it("rolls role changes and removals back with their policy projection", async () => {
    const f = await fixture(), membership = await createMember(f);
    const input = { collectionId: f.collection, actorUserId: f.owner.id, membershipId: membership.membershipId };
    await expect(changeHostedCollectionMembershipRole(failCommit(), { ...input, role: "viewer" })).rejects.toThrow("injected pre-commit failure");
    await expect(revokeHostedCollectionMembership(failCommit(), input)).rejects.toThrow("injected pre-commit failure");
    expect((await db.query("SELECT state,current_policy_revision,revoked_at FROM collection_memberships WHERE id=$1", [membership.membershipId])).rows).toEqual([{ state: "active", current_policy_revision: 1, revoked_at: null }]);
    expect((await db.query("SELECT id FROM collection_membership_policies WHERE membership_id=$1", [membership.membershipId])).rows).toHaveLength(1);
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "editor" }]);
  });

  async function providerReplica(f: Fixture, membership: Pick<CollectionMembershipPolicy, "membershipId" | "id" | "role">) {
    const replica = randomUUID();
    await db.query("INSERT INTO hosted_replicas(id,collection_id,authorized_user_id,name,purpose,mode,membership_id,membership_policy_id,membership_policy_revision) VALUES($1,$2,$3,'Retained mirror','mirror',$4,$5,$6,1)", [replica, f.collection, f.member.id, membership.role === "editor" ? "read_write" : "read_only", membership.membershipId, membership.id]);
    return replica;
  }
  async function completeProvider(f: Fixture) {
    await db.query("UPDATE provider_revocation_jobs SET state='completed',completed_at=now() WHERE collection_id=$1", [f.collection]);
  }

  it.each([["editor", "viewer"], ["viewer", "editor"]] as const)("projects provider-pending %s -> %s as viewer, then activates the exact target", async (initial, target) => {
    // A migrated collection may retain genuine legacy provider replicas.
    const f = await fixture("cloud_copy", true), membership = await createMember(f, initial);
    await providerReplica(f, membership);
    expect(await changeHostedCollectionMembershipRole(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: membership.membershipId, role: target })).toMatchObject({ state: "changing", pendingProviderRevocations: 1 });
    expect(await memberOps(f)).toEqual([
      { op: "member-set", account: f.member.id, role: initial },
      { op: "member-set", account: f.member.id, role: "viewer" }
    ]);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(0);
    await completeProvider(f);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(1);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(0);
    expect(await memberOps(f)).toEqual([
      { op: "member-set", account: f.member.id, role: initial },
      { op: "member-set", account: f.member.id, role: "viewer" },
      { op: "member-set", account: f.member.id, role: target }
    ]);
    expect((await db.query("SELECT state,current_policy_revision,pending_policy_id FROM collection_memberships WHERE id=$1", [membership.membershipId])).rows).toEqual([{ state: "active", current_policy_revision: 2, pending_policy_id: null }]);
  });

  it("rolls finalization and target role back together, then resumes once", async () => {
    const f = await fixture("cloud_copy", true), membership = await createMember(f, "viewer");
    await providerReplica(f, membership);
    await changeHostedCollectionMembershipRole(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: membership.membershipId, role: "editor" });
    await completeProvider(f);
    await expect(finalizeReadyMembershipTransitions(failCommit())).rejects.toThrow("injected pre-commit failure");
    expect((await db.query("SELECT state FROM collection_memberships WHERE id=$1", [membership.membershipId])).rows).toEqual([{ state: "changing" }]);
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "viewer" }, { op: "member-set", account: f.member.id, role: "viewer" }]);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(1);
    expect((await memberOps(f)).at(-1)).toEqual({ op: "member-set", account: f.member.id, role: "editor" });
  });

  it("publishes one removal immediately during provider wait, never again on retry/finalization", async () => {
    const f = await fixture("cloud_copy", true), invitation = await invite(f);
    const accepted = await acceptHostedCollectionInvitation(db, { userId: f.member.id, token: invitation.token });
    const membership = (await db.query<{ current_policy_id: string }>("SELECT current_policy_id FROM collection_memberships WHERE id=$1", [accepted.membershipId])).rows[0]!;
    await providerReplica(f, { membershipId: accepted.membershipId, id: membership.current_policy_id, role: "editor" });
    const remove = () => revokeHostedCollectionMembership(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: accepted.membershipId });
    expect(await remove()).toMatchObject({ state: "revoking" });
    expect(await remove()).toMatchObject({ state: "revoking" });
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "editor" }, { op: "member-remove", account: f.member.id }]);
    expect((await db.query("SELECT released_at FROM account_collection_member_seats WHERE membership_id=$1", [accepted.membershipId])).rows).toEqual([{ released_at: null }]);
    await completeProvider(f);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(1);
    expect(await remove()).toMatchObject({ state: "revoked" });
    expect(await memberOps(f)).toHaveLength(2);
    expect((await db.query("SELECT released_at IS NOT NULL AS released FROM account_collection_member_seats WHERE membership_id=$1", [accepted.membershipId])).rows).toEqual([{ released: true }]);
  });

  it("releases revoked seats after leave-sync cleanup, without publishing new authority", async () => {
    const f = await fixture("cloud_copy", true), invitation = await invite(f);
    const accepted = await acceptHostedCollectionInvitation(db, { userId: f.member.id, token: invitation.token });
    const policy = (await db.query<{ current_policy_id: string }>("SELECT current_policy_id FROM collection_memberships WHERE id=$1", [accepted.membershipId])).rows[0]!;
    await providerReplica(f, { membershipId: accepted.membershipId, id: policy.current_policy_id, role: "editor" });
    await revokeHostedCollectionMembership(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: accepted.membershipId });
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    await completeProvider(f);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(1);
    expect((await db.query("SELECT released_at IS NOT NULL AS released FROM account_collection_member_seats WHERE membership_id=$1", [accepted.membershipId])).rows).toEqual([{ released: true }]);
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "editor" }, { op: "member-remove", account: f.member.id }]);
  });

  it("does not promote a provider-pending membership after leave-sync", async () => {
    const f = await fixture("cloud_copy", true), membership = await createMember(f, "viewer");
    await providerReplica(f, membership);
    await changeHostedCollectionMembershipRole(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: membership.membershipId, role: "editor" });
    await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    await completeProvider(f);
    expect(await finalizeReadyMembershipTransitions(db)).toBe(0);
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "viewer" }, { op: "member-set", account: f.member.id, role: "viewer" }]);
  });

  it.each(["left", "suspended", "legacy-account", "deleted"] as const)("refuses %s native authority rather than falling back to a retained hosted row", async state => {
    const f = await fixture("cloud_copy", true);
    if (state === "left") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.collection]);
    if (state === "suspended") await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.owner.id]);
    if (state === "legacy-account") await db.query("UPDATE users SET account_backend='legacy' WHERE id=$1", [f.owner.id]);
    if (state === "deleted") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [f.collection, randomUUID()]);
    await expect(createMember(f)).rejects.toThrow("not available for membership changes");
    await expect(invite(f)).rejects.toThrow("unavailable");
    expect(await ops(f.collection)).toEqual([]);
  });

  it("keeps shadow authority on the legacy row until cutover", async () => {
    const f = await fixture("shadow");
    await createMember(f, "viewer");
    expect(await memberOps(f)).toEqual([{ op: "member-set", account: f.member.id, role: "viewer" }]);
    const blocked = await fixture("shadow");
    await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [blocked.collection]);
    await expect(createMember(blocked)).rejects.toThrow("not available");
    expect(await ops(blocked.collection)).toEqual([]);
  });

  it.each(["quarantined", "owner-mismatch"] as const)("refuses %s shadow authority without publication", async state => {
    const f = await fixture("shadow");
    if (state === "quarantined") await db.query("UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1", [f.collection]);
    else await db.query("UPDATE next_collections SET owner_user_id=$2 WHERE collection_id=$1", [f.collection, f.member.id]);
    await expect(createMember(f)).rejects.toThrow("not available");
    expect(await ops(f.collection)).toEqual([]);
  });

  it.each([true, false])("projects same-row removal/enrollment ordering (enrolled first: %s)", async enrolledFirst => {
    const f = await fixture(), device = randomUUID();
    await createMember(f);
    const enrolled = { op: "device-enrol", device, account: f.member.id };
    const removed = { op: "member-remove", account: f.member.id };
    const readded = { op: "member-set", account: f.member.id, role: "editor" };
    // This test qualifies the CP projection's row/op order, not native tuple admission.
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [f.collection, JSON.stringify({ version: 1, ops: enrolledFirst ? [enrolled, removed, readded] : [removed, readded, enrolled] })]);
    const connection = await db.connect();
    try {
      if (enrolledFirst) await expect(refuseRevoked(connection, f.collection, device)).rejects.toThrow("device_revoked");
      else await expect(refuseRevoked(connection, f.collection, device)).resolves.toBeUndefined();
    } finally {
      connection.release();
    }
  });

  it("retains legacy lifecycle without creating any next policy rows", async () => {
    const f = await fixture("legacy"), membership = await createMember(f);
    await changeHostedCollectionMembershipRole(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: membership.membershipId, role: "viewer" });
    await revokeHostedCollectionMembership(db, { collectionId: f.collection, actorUserId: f.owner.id, membershipId: membership.membershipId });
    expect(await ops(f.collection)).toEqual([]);
  });
});
