import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedProviderResponseError, type HostedProviderClient } from "../../hosted-provider.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-migration-token-".repeat(2);
const sorted = (ids: string[]) => [...ids].sort();

interface Source { state: string; run: string | null; replicas: Map<string, string | null> }

suite("migration replica, unfence and cutover-policy fronts (isolated real PostgreSQL, synthetic provider)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_replicas_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
  }, 60000);
  afterAll(async () => { await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  async function account() {
    const id = randomUUID(), cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [id, `${id}@example.test`]);
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,now())", [id, cohort]);
    return id;
  }
  async function collection(owner: string, sources: Map<string, Source>) {
    const id = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [id, owner]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [id, owner, Buffer.alloc(16, 7)]);
    const replicas = new Map<string, string | null>([[randomUUID(), null], [randomUUID(), null]]);
    sources.set(id, { state: "migrating", run: randomUUID(), replicas });
    return id;
  }

  async function fixture() {
    const sources = new Map<string, Source>(), effects: string[] = [];
    let head = 10;
    const owner = await account(), a = await collection(owner, sources), b = await collection(owner, sources);
    const src = (id: string) => sources.get(id)!;
    const owned = (id: string) => sorted([...src(id).replicas].filter(([, by]) => by !== null && by === src(id).run).map(([r]) => r));
    const fenced = (id: string) => { if (src(id).state !== "migrating") throw new HostedProviderResponseError(409, "legacy_migration_not_started", "x"); };
    const provider: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationReplicas" | "legacyMigrationRevokeReplicas"
      | "legacyMigrationRestoreReplicas" | "legacyMigrationRevokedReplicas" | "legacyMigrationUnfence"> = {
      async legacyMigrationDrain(id) {
        const s = src(id);
        return { collection_id: id, state: s.state, migration_id: s.run, head: 42, started_at: s.run ? "2026-10-12T00:00:00.000Z" : null,
          retain_until: null, in_flight: 0, unresolved: 0, applied_unreceipted: 0 };
      },
      async legacyMigrationReplicas(id) {
        return { replicas: [...src(id).replicas].filter(([, by]) => by === null).map(([r]) => ({ id: r, head: 42, acknowledged_sequence: 42,
          last_seen_at: null, token_expires_at: "2026-11-01T00:00:00.000Z" })) };
      },
      // Provider scoping: only this collection's replicas, owned by the current run.
      async legacyMigrationRevokeReplicas(id, replicas) {
        effects.push(`revoke:${id}`); fenced(id);
        for (const r of replicas) if (src(id).replicas.get(r) === null) src(id).replicas.set(r, src(id).run);
        return { revoked: owned(id).filter(r => replicas.includes(r)) };
      },
      async legacyMigrationRestoreReplicas(id, replicas) {
        effects.push(`restore:${id}`); fenced(id);
        const restored = owned(id).filter(r => replicas.includes(r));
        for (const r of restored) src(id).replicas.set(r, null);
        return { restored };
      },
      async legacyMigrationRevokedReplicas(id) { fenced(id); return { collection_id: id, migration_id: src(id).run!, revoked: owned(id) }; },
      async legacyMigrationUnfence(id) {
        effects.push(`unfence:${id}`); Object.assign(src(id), { state: "active", run: null });
        return { collection_id: id, state: "active", migration_id: null, started_at: null, retain_until: null, restored: [] };
      }
    };
    const app = Fastify();
    registerMigrationReplicaRoutes(app, { db, token, provider, log: { head: async () => ({ seq: head, chain: new Uint8Array(32) }) },
      emitter: { drainCollection: async () => 0 } });
    const claim = (await db.query<{ started_us: string }>(
      "SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS started_us FROM next_migration_cohort_members WHERE account_id=$1", [owner])).rows[0]!;
    const binding = (id = a) => ({ owner_account: owner, started_us: claim.started_us, migration_id: src(id).run });
    const call = (kind: string, body: Record<string, unknown>, id = a) => app.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${id}/${kind}`, headers: { authorization: `Bearer ${token}` }, payload: body });
    const replicas = (id = a) => sorted([...src(id).replicas.keys()]);
    const cutovers = async (id = a) => (await db.query<{ ops: { ops: unknown[] } }>(
      `SELECT ops FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> '[{"op":"migration-cutover"}]'::jsonb`, [id])).rows;
    return { owner, a, b, src, app, call, binding, replicas, cutovers, effects, set head(v: number) { head = v; } };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  const revokeAll = async (f: F, id = f.a) => {
    const r = await f.call("replicas/revoke", { ...f.binding(id), replica_ids: f.replicas(id) }, id);
    expect(r.statusCode, r.body).toBe(200); return r;
  };
  const cutover = (f: F, revoked: string[], id = f.a) => f.call("cutover-policy", { ...f.binding(id), revoked, base_seq: 10 }, id);

  it("lists, revokes and queues exactly one cutover policy; a repeat finds it", async () => {
    const f = await fixture(); try {
      const listed = await f.call("replicas", f.binding()); expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().replicas.map((r: { id: string }) => r.id).sort()).toEqual(f.replicas());
      expect(Object.keys(listed.json().replicas[0]).sort()).toEqual(["acknowledged_sequence", "head", "id", "last_seen_at", "token_expires_at"]);
      expect((await revokeAll(f)).json()).toEqual({ revoked: f.replicas() });
      const first = await cutover(f, f.replicas()); expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ collection_id: f.a, revoked: f.replicas(), freeze: false, created: true });
      const again = await cutover(f, f.replicas()); expect(again.statusCode, again.body).toBe(200);
      expect(again.json().created).toBe(false);
      const rows = await f.cutovers(); expect(rows).toHaveLength(1);
      expect(rows[0]!.ops.ops).toEqual([
        { op: "migration-cutover", legacyCollection: f.a, revoked: f.replicas(), cutoverAt: expect.any(Number) },
        { op: "freeze", frozen: false }]);
      // A different set after queueing is a conflict, never a second item.
      expect((await cutover(f, f.replicas().slice(1))).json().error.code).toBe("migration_cutover_conflict");
      expect(await f.cutovers()).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it("queues one cutover under concurrent requests", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const results = await Promise.all(Array.from({ length: 4 }, () => cutover(f, f.replicas())));
      for (const r of results) expect([200, 503], r.body).toContain(r.statusCode);
      expect(results.filter(r => r.statusCode === 200 && r.json().created)).toHaveLength(1);
      expect(await f.cutovers()).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it.each(["subset", "superset", "empty", "foreign"])("refuses a cutover whose revoked set is not the run's: %s", async mode => {
    const f = await fixture(); try {
      const [r0, r1] = f.replicas();
      // The run owns both for "subset", otherwise only r0.
      await f.call("replicas/revoke", { ...f.binding(), replica_ids: mode === "subset" ? [r0, r1] : [r0] });
      const set = { subset: [r0!], superset: [r0!, r1!], empty: [], foreign: sorted([r0!, f.replicas(f.b)[0]!]) }[mode]!;
      const r = await cutover(f, set);
      expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe("migration_revoked_set_mismatch");
      expect(await f.cutovers()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it("refuses a cutover before the base is in the log", async () => {
    const f = await fixture(); try {
      await revokeAll(f); f.head = 9;
      const r = await cutover(f, f.replicas()); expect(r.json().error.code).toBe("migration_base_not_logged");
      expect(await f.cutovers()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it.each(["replicas", "replicas/revoke", "replicas/unrevoke", "unfence", "cutover-policy"])("refuses stale or foreign claims before any effect: %s", async kind => {
    const f = await fixture(); try {
      const foreign = await account();
      const extra = kind.startsWith("replicas/") ? { replica_ids: f.replicas() } : kind === "cutover-policy" ? { revoked: [], base_seq: 10 } : {};
      const stale = { ...f.binding(), started_us: String(BigInt(f.binding().started_us) - 1n) };
      for (const body of [stale, { ...f.binding(), owner_account: foreign }]) {
        const r = await f.call(kind, { ...body, ...extra }); expect(r.statusCode, r.body).toBe(409);
        expect(r.json().error.code).toBe("migration_claim_not_current");
      }
      expect((await f.call(kind, { ...f.binding(), migration_id: randomUUID(), ...extra })).json().error.code).toBe("migration_run_not_current");
      expect(f.effects).toEqual([]); expect(await f.cutovers()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it.each(["restart", "connect-cutover", "backend-flip"])("refuses a revoke or unrevoke replayed after the claim moved on: %s", async change => {
    const f = await fixture(); try {
      const revoke = { ...f.binding(), replica_ids: f.replicas() };
      await revokeAll(f);
      const unrevoke = await f.call("replicas/unrevoke", revoke); expect(unrevoke.statusCode, unrevoke.body).toBe(200);
      if (change === "restart") await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 second' WHERE account_id=$1", [f.owner]);
      if (change === "connect-cutover") await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,42,11,11,$3)", [f.a, f.owner, "ab".repeat(32)]);
      if (change === "backend-flip") await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [f.owner]);
      const effects = f.effects.length;
      for (const kind of ["replicas/revoke", "replicas/unrevoke"]) {
        const r = await f.call(kind, revoke); expect(r.statusCode, r.body).toBe(409);
      }
      expect(f.effects).toHaveLength(effects);
    } finally { await f.app.close(); }
  });

  it("unfences only a fenced, uncut run that owns no revocation", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const blocked = await f.call("unfence", f.binding()); expect(blocked.json().error.code).toBe("migration_replicas_revoked");
      expect((await f.call("replicas/unrevoke", { ...f.binding(), replica_ids: f.replicas() })).json()).toEqual({ restored: f.replicas() });
      const binding = f.binding();
      const done = await f.call("unfence", binding); expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ state: "active", migration_id: null });
      // Replayed unfence: the run is gone.
      const replay = await f.call("unfence", binding); expect(replay.json().error.code).toBe("migration_run_not_current");
      expect(f.effects.filter(e => e.startsWith("unfence"))).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it("refuses every rollback step once the cutover policy is queued", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      expect((await cutover(f, f.replicas())).statusCode).toBe(200);
      const effects = f.effects.length;
      for (const kind of ["replicas/revoke", "replicas/unrevoke", "unfence"]) {
        const r = await f.call(kind, { ...f.binding(), ...(kind === "unfence" ? {} : { replica_ids: f.replicas() }) });
        expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe("migration_cutover_queued");
      }
      expect(f.effects).toHaveLength(effects);
    } finally { await f.app.close(); }
  });

  it("binds each collection to its own run: no cross-collection use", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      // Same owner, so only the provider run tells the collections apart.
      const crossRun = await f.call("cutover-policy", { ...f.binding(f.a), revoked: f.replicas(), base_seq: 10 }, f.b);
      expect(crossRun.json().error.code).toBe("migration_run_not_current");
      const crossSet = await cutover(f, f.replicas(f.a), f.b);
      expect(crossSet.json().error.code).toBe("migration_revoked_set_mismatch");
      const crossRevoke = await f.call("replicas/revoke", { ...f.binding(f.a), replica_ids: f.replicas(f.b) });
      expect(crossRevoke.json()).toEqual({ revoked: [] });
      expect([...f.src(f.b).replicas.values()]).toEqual([null, null]);
      expect(await f.cutovers(f.b)).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it("refuses ordinary credentials and non-canonical bodies", async () => {
    const f = await fixture(); try {
      const wrong = await f.app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.a}/replicas`,
        headers: { authorization: "Bearer session" }, payload: f.binding() });
      expect(wrong.statusCode).toBe(401);
      for (const body of [{ ...f.binding(), replica_ids: [...f.replicas()].reverse() }, { ...f.binding(), replica_ids: [] },
        { ...f.binding(), replica_ids: f.replicas(), extra: 1 }]) {
        expect((await f.call("replicas/revoke", body)).statusCode).toBe(400);
      }
      expect((await f.call("cutover-policy", { ...f.binding(), revoked: [], base_seq: 0 })).statusCode).toBe(400);
      expect(f.effects).toEqual([]);
    } finally { await f.app.close(); }
  });
});
