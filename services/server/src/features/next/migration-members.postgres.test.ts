import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-migration-token-".repeat(2);
const NIL = "00000000-0000-0000-0000-000000000000";
type Role = "owner" | "editor" | "viewer";
type Op = { op: string; owner?: string; account?: string; role?: Role };

/** The log/replica member reducer: a refused op throws, as it would park the queue. */
function reduce(rows: Array<{ ops: { ops: Op[] } }>): Map<string, Role> {
  const members = new Map<string, Role>();
  const onlyOwner = (account: string) => members.get(account) === "owner" && [...members.values()].filter(r => r === "owner").length === 1;
  for (const op of rows.flatMap(row => row.ops.ops)) {
    if (op.op === "genesis") members.set(op.owner!, "owner");
    if (op.op === "member-set") {
      if (op.account === NIL || (op.role !== "owner" && onlyOwner(op.account!))) throw new Error(`refused ${JSON.stringify(op)}`);
      members.set(op.account!, op.role!);
    }
    if (op.op === "member-remove") {
      if (!members.has(op.account!) || onlyOwner(op.account!)) throw new Error(`refused ${JSON.stringify(op)}`);
      members.delete(op.account!);
    }
  }
  return members;
}
/** Replica::verify_hosted_member_roles conditions, against the route's returned map. */
function nativeAgrees(policy: Map<string, Role>, members: Array<{ account: string; role: Role }>): boolean {
  const expected = new Map(members.map(m => [m.account, m.role]));
  return expected.size === members.length && expected.size > 0 && expected.size <= 1000 && policy.size <= 1000 && !expected.has(NIL)
    && policy.size === expected.size && [...expected].every(([a, r]) => policy.get(a) === r);
}

suite("migration member policy (isolated real PostgreSQL, synthetic provider)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_members_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
  }, 60000);
  afterAll(async () => { await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  const user = async () => {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [id, `${id}@example.test`]);
    return id;
  };
  async function owner() {
    const id = await user(), cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,now())", [id, cohort]);
    return id;
  }
  async function collection(account: string) {
    const id = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [id, account]);
    await db.query("INSERT INTO collection_identities(id,owner_user_id) VALUES($1,$2)", [id, account]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [id, account, Buffer.alloc(16, 7)]);
    await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [id, JSON.stringify({ version: 1, ops: [
      { op: "genesis", owner: account, root: { $hex: "07".repeat(16) }, state: "cloud-copy" }, { op: "member-set", account, role: "owner" }] })]);
    return id;
  }
  /** Membership rows as acceptance and the lifecycle write them. */
  async function member(id: string, role: "editor" | "viewer", state = "active", account?: string) {
    account ??= await user();
    const membership = randomUUID(), policy = randomUUID(), pending = randomUUID();
    await db.query(`INSERT INTO collection_memberships(id,collection_id,user_id,state,revoked_at) VALUES($1,$2,$3,'active',NULL)`, [membership, id, account]);
    for (const [pid, revision, r] of [[policy, 1, role], [pending, 2, "editor"]] as const) {
      await db.query(`INSERT INTO collection_membership_policies(id,membership_id,revision,role,preset_version,actions,operations,scope_ceiling,file_ceiling)
        VALUES($1,$2,$3,$4,1,'[]','[]','{}','{}')`, [pid, membership, revision, r]);
    }
    await db.query(`UPDATE collection_memberships SET current_policy_id=$2,current_policy_revision=1,state=$3,
      pending_policy_id=CASE WHEN $3='changing' THEN $4::uuid END, pending_policy_revision=CASE WHEN $3='changing' THEN 2 END,
      revoked_at=CASE WHEN $3='revoked' THEN now() END WHERE id=$1`, [membership, policy, state, pending]);
    return account;
  }

  async function fixture() {
    const runs = new Map<string, string>(), effects: string[] = [];
    const account = await owner(), a = await collection(account), b = await collection(account);
    runs.set(a, randomUUID()); runs.set(b, randomUUID());
    const unused = async () => { throw new Error("not used"); };
    const provider: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationReplicas" | "legacyMigrationRevokeReplicas"
      | "legacyMigrationRestoreReplicas" | "legacyMigrationRevokedReplicas" | "legacyMigrationUnfence"> = {
      async legacyMigrationDrain(id) {
        return { collection_id: id, state: "migrating", migration_id: runs.get(id) ?? null, head: 42, started_at: "2026-10-12T00:00:00.000Z",
          retain_until: null, in_flight: 0, unresolved: 0, applied_unreceipted: 0 };
      },
      async legacyMigrationRevokedReplicas(id) { return { collection_id: id, migration_id: runs.get(id)!, revoked: [] }; },
      legacyMigrationReplicas: unused, legacyMigrationRevokeReplicas: unused, legacyMigrationRestoreReplicas: unused, legacyMigrationUnfence: unused
    };
    const app = Fastify();
    registerMigrationReplicaRoutes(app, { db, token, provider, log: { head: async () => ({ seq: 10, chain: new Uint8Array(32) }) },
      emitter: { drainCollection: async id => { effects.push(`drain:${id}`); return 0; } } });
    const started = async () => (await db.query<{ s: string }>(
      "SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS s FROM next_migration_cohort_members WHERE account_id=$1", [account])).rows[0]!.s;
    const claim = await started();
    const binding = (id = a) => ({ owner_account: account, started_us: claim, migration_id: runs.get(id) });
    const call = (kind: string, body: Record<string, unknown>, id = a) => app.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${id}/${kind}`, headers: { authorization: `Bearer ${token}` }, payload: body });
    const queue = (body: Record<string, unknown> = binding(), id = a) => call("members-policy", body, id);
    const outbox = async (id = a) => (await db.query<{ ops: { ops: Op[] } }>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1 ORDER BY id", [id])).rows;
    /** Queue once, then check the queued policy against the returned native expectation. */
    const queueAgrees = async (id = a) => {
      const response = await queue(binding(id), id); expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { members: Array<{ account: string; role: Role }>; queued: number };
      expect(nativeAgrees(reduce(await outbox(id)), body.members)).toBe(true);
      return body;
    };
    return { account, a, b, runs, effects, app, binding, call, queue, outbox, queueAgrees, started };
  }

  it("queues one member-set per current member with the state mapping; a replay queues nothing", async () => {
    const f = await fixture(); try {
      const editor = await member(f.a, "editor"), viewer = await member(f.a, "viewer"), changing = await member(f.a, "editor", "changing");
      await member(f.a, "editor", "revoking"); await member(f.a, "editor", "revoked");
      const invited = await user();
      await db.query(`INSERT INTO collection_invitations(id,collection_id,invited_by_user_id,target_mode,target_user_id,token_hash,role,preset_version,
        actions,operations,scope_ceiling,file_ceiling,expires_at) VALUES($1,$2,$3,'invitee_code',$4,$5,'editor',1,'[]','[]','{}','{}',now()+interval '1 day')`,
        [randomUUID(), f.a, f.account, invited, randomUUID()]);
      const before = (await f.outbox()).length;
      const first = await f.queueAgrees();
      expect(first.queued).toBe(3);
      expect(first.members).toEqual([{ account: f.account, role: "owner" }, { account: editor, role: "editor" },
        { account: viewer, role: "viewer" }, { account: changing, role: "viewer" }].sort((x, y) => x.account < y.account ? -1 : 1));
      const added = (await f.outbox()).slice(before);
      expect(added.map(row => row.ops.ops)).toEqual(
        [editor, viewer, changing].sort().map(account => [{ op: "member-set", account, role: account === editor ? "editor" : "viewer" }]));
      expect(f.effects).toEqual([`drain:${f.a}`]);
      const replay = await f.queueAgrees();
      expect(replay).toEqual({ ...first, queued: 0 });
      expect(await f.outbox()).toHaveLength(before + 3);
      expect((await f.outbox(f.b)).length).toBe(1);
      expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.members_policy' AND subject_id=$1", [f.a])).rows).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it("reconciles members added, removed, erased and mid-change during the run exactly once", async () => {
    const f = await fixture(); try {
      const leaving = await member(f.a, "editor"), erased = await member(f.a, "viewer"), demoted = await member(f.a, "editor");
      await f.queueAgrees();
      const joined = await member(f.a, "editor"), lifecycle = await member(f.a, "viewer");
      // The ordinary lifecycle already queued this one; it is never duplicated.
      await db.query("INSERT INTO next_policy_outbox(collection_id,ops) VALUES($1,$2)", [f.a, JSON.stringify({ version: 1, ops: [{ op: "member-set", account: lifecycle, role: "viewer" }] })]);
      await db.query("UPDATE collection_memberships SET state='revoked',revoked_at=now() WHERE user_id=$1", [leaving]);
      await db.query("DELETE FROM users WHERE id=$1", [erased]);
      await db.query(`UPDATE collection_memberships m SET state='changing',pending_policy_id=p.id,pending_policy_revision=2
        FROM collection_membership_policies p WHERE p.membership_id=m.id AND p.revision=2 AND m.user_id=$1`, [demoted]);
      const before = (await f.outbox()).length;
      const second = await f.queueAgrees();
      expect(second.queued).toBe(4);
      expect((await f.outbox()).slice(before).map(row => row.ops.ops[0])).toEqual([
        ...[joined, demoted].sort().map(account => ({ op: "member-set", account, role: account === joined ? "editor" : "viewer" })),
        ...[leaving, erased].sort().map(account => ({ op: "member-remove", account }))]);
      expect((await f.queueAgrees()).queued).toBe(0);
    } finally { await f.app.close(); }
  });

  it("refuses foreign, stale, superseded and cross-collection claims without queueing", async () => {
    const f = await fixture(), other = await fixture(); try {
      await member(f.a, "editor"); await member(f.b, "viewer");
      const before = { a: (await f.outbox()).length, b: (await f.outbox(f.b)).length };
      const refused = async (body: Record<string, unknown>, code: string, id = f.a) => {
        const r = await f.queue(body, id); expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe(code);
      };
      await refused(other.binding(other.a), "migration_claim_not_current");
      await refused({ ...f.binding(), owner_account: other.account }, "migration_claim_not_current");
      // Collection b's run presented on collection a, and a's on b.
      await refused(f.binding(f.b), "migration_run_not_current");
      await refused(f.binding(f.a), "migration_run_not_current", f.b);
      // The provider run moved on.
      const stale = f.binding(); f.runs.set(f.a, randomUUID());
      await refused(stale, "migration_run_not_current");
      // A restarted claim refuses the old binding.
      await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 second' WHERE account_id=$1", [f.account]);
      await refused(f.binding(), "migration_claim_not_current");
      // A claim that ended refuses every binding.
      await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [f.account]);
      await refused({ ...f.binding(), started_us: await f.started() }, "migration_source_not_current");
      expect((await f.outbox()).length).toBe(before.a); expect((await f.outbox(f.b)).length).toBe(before.b);
      expect((await f.app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.a}/members-policy`,
        headers: { authorization: "Bearer wrong" }, payload: f.binding() })).statusCode).toBe(401);
    } finally { await f.app.close(); await other.app.close(); }
  });

  it("queues each member once under concurrent duplicate attempts", async () => {
    const f = await fixture(); try {
      for (let i = 0; i < 5; i++) await member(f.a, i % 2 ? "viewer" : "editor");
      const before = (await f.outbox()).length;
      const results = await Promise.all(Array.from({ length: 4 }, () => f.queue()));
      for (const r of results) expect([200, 503], r.body).toContain(r.statusCode);
      expect(results.filter(r => r.statusCode === 200).map(r => r.json().queued).reduce((x, y) => x + y, 0)).toBe(5);
      expect(await f.outbox()).toHaveLength(before + 5);
      expect((await f.queueAgrees()).queued).toBe(0);
    } finally { await f.app.close(); }
  });

  it("orders members before the cutover and refuses member changes once it is queued", async () => {
    const f = await fixture(); try {
      await member(f.a, "editor");
      const cutover = () => f.call("cutover-policy", { ...f.binding(), revoked: [], base_seq: 10 });
      const early = await cutover(); expect(early.statusCode, early.body).toBe(409); expect(early.json().error.code).toBe("migration_members_not_queued");
      await f.queueAgrees();
      const queued = await cutover(); expect(queued.statusCode, queued.body).toBe(200);
      await member(f.a, "viewer");
      const late = await f.queue(); expect(late.statusCode).toBe(409); expect(late.json().error.code).toBe("migration_cutover_queued");
      expect((await f.outbox()).at(-1)!.ops.ops[0]!.op).toBe("migration-cutover");
    } finally { await f.app.close(); }
  });

  it("refuses a parked queue or a missing genesis owner without queueing", async () => {
    const f = await fixture(); try {
      await member(f.a, "editor");
      await db.query("INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state) VALUES($1,2,'\\x00','\\x00',1,'parked')", [f.a]);
      const parked = await f.queue(); expect(parked.statusCode).toBe(409); expect(parked.json().error.code).toBe("migration_policy_blocked");
      await db.query("DELETE FROM next_policy_batches WHERE collection_id=$1", [f.a]);
      await db.query("DELETE FROM next_policy_outbox WHERE collection_id=$1", [f.a]);
      const orphan = await f.queue(); expect(orphan.statusCode).toBe(409); expect(orphan.json().error.code).toBe("migration_target_unavailable");
      expect(await f.outbox()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it("refuses more members than the native comparison carries and accepts exactly the cap", async () => {
    const f = await fixture(); try {
      // Bulk seeding (no per-row round trips): the cap needs 1000 members plus the owner.
      await db.query(`WITH u AS (INSERT INTO users(id,email,name) SELECT id, id::text || '@example.test', 'Test'
          FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,1000)) g RETURNING id),
        m AS (INSERT INTO collection_memberships(id,collection_id,user_id) SELECT gen_random_uuid(), $1, id FROM u RETURNING id),
        p AS (INSERT INTO collection_membership_policies(id,membership_id,revision,role,preset_version,actions,operations,scope_ceiling,file_ceiling)
          SELECT gen_random_uuid(), id, 1, 'viewer', 1, '[]', '[]', '{}', '{}' FROM m RETURNING id)
        SELECT count(*) FROM p`, [f.a]);
      await db.query(`UPDATE collection_memberships c SET current_policy_id=p.id,current_policy_revision=1
        FROM collection_membership_policies p WHERE p.membership_id=c.id AND c.collection_id=$1`, [f.a]);
      const before = (await f.outbox()).length;
      const over = await f.queue(); expect(over.statusCode).toBe(409); expect(over.json().error.code).toBe("migration_members_over_cap");
      expect(await f.outbox()).toHaveLength(before);
      await db.query(`UPDATE collection_memberships SET state='revoked',revoked_at=now()
        WHERE id=(SELECT id FROM collection_memberships WHERE collection_id=$1 ORDER BY user_id LIMIT 1)`, [f.a]);
      const at = await f.queueAgrees();
      expect(at.members).toHaveLength(1000); expect(at.queued).toBe(999);
    } finally { await f.app.close(); }
  }, 60000);
});
