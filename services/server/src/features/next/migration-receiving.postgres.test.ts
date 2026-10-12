import { migratedTimerGate } from "./legacy-provider.test-helper.js";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, flipAccountBackend, flipEvidenceDigest,
  localTakeoverAllowed, recordCollectionCutover, registerMigrationRolloutRoutes, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-receiving-token-".repeat(2), actor = "synthetic-source-test";
const hex = (n: number) => n.toString(16).padStart(64, "0");

suite("staging receiving-v1 (isolated real PostgreSQL; synthetic verifier metadata)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_receiving_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
    await setPaused(db, false, "synthetic receiving tests", actor);
  }, 60_000);
  afterAll(async () => { await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  async function fixture(count = 3, withHosted = true) {
    const accounts: string[] = [], ids: string[] = [], name = `r-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < count; i++) {
      const account = randomUUID(); accounts.push(account);
      await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')", [account, `${account}@example.test`]);
    }
    if (withHosted) {
      for (let i = 0; i < 2; i++) {
        const id = randomUUID(); ids.push(id);
        await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Synthetic','mdbase')", [id, accounts[0]]);
      }
      await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [accounts[0]]);
    }
    ids.sort();
    await createCohort(db, name, actor); await addToCohort(db, name, accounts, actor); await releaseCohort(db, name, actor);
    await setCohortFrozen(db, name, true, "synthetic archive capture", actor);
    const binding = await cohortArchiveBinding(db, name);
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
    const archive = { schema: "mdbase-recovery-set/v4", environment: "staging", bucket: "synthetic-archives",
      prefix: `staging/2026/10/11/${name}`, backup_id: name, complete_sha256: hex(1), manifest_sha256: hex(2), source_commit: "a".repeat(40),
      migration_batch: binding, archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: hex(3), count: "3" } };
    const accepted = count ? await acceptCohortArchive(db, name, archive, "staging") : null;
    return { name, accounts, ids, binding, archive, accepted };
  }
  async function front(database = db, environment = "staging") {
    const app = Fastify(); registerMigrationRolloutRoutes(app, { db: database, token, environment });
    return app;
  }
  const request = (app: Awaited<ReturnType<typeof front>>, name: string, query = "?view=receiving-v1", credential = token) => app.inject({
    method: "GET", url: `/internal/v1/next/migration/cohorts/${name}/archive-binding${query}`, headers: { authorization: `Bearer ${credential}` }
  });
  async function cut(f: Awaited<ReturnType<typeof fixture>>, index: number) {
    const collection = f.ids[index]!;
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [collection, f.accounts[0], Buffer.alloc(16)]);
    return recordCollectionCutover(db, collection, { s_final: 42, cutover_seq: 5 + index, barrier_f: 6 + index, final_digest: hex(10 + index) });
  }

  it("returns the exact complete sorted ten-field inventory including suspended/collectionless/terminal members without replacing the public four-field header", async () => {
    const f = await fixture(), app = await front(); try {
      await db.query("UPDATE next_migration_cohort_members SET terminal_excluded_at=now() WHERE account_id=$1", [f.accounts[2]]);
      const plain = await request(app, f.name, ""); expect(plain.statusCode, plain.body).toBe(200); expect(plain.json()).toEqual(f.binding);
      const response = await request(app, f.name); expect(response.statusCode, response.body).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
      const result = response.json();
      expect(Object.keys(result).sort()).toEqual(["archive", "binding", "cutover_evidence_digest", "frozen_at", "members", "schema"]);
      expect(result.schema).toBe("mdbase-migration-receiving/1"); expect(result.binding).toEqual(f.binding);
      expect(result.archive).toEqual({ accepted_at: f.accepted!.accepted_at, verified_result: f.archive });
      expect(result.members.map((m: any) => m.view.account_id)).toEqual([...f.accounts].sort());
      for (const member of result.members) {
        expect(Object.keys(member).sort()).toEqual(["cutovers", "flip", "started_at", "suspended", "terminal_excluded_at", "view"]);
        expect(Object.keys(member.view)).toHaveLength(10); expect(member.cutovers).toEqual([]); expect(member.flip).toBeNull();
      }
      expect(result.members.find((m: any) => m.view.account_id === f.accounts[0])).toMatchObject({ suspended: true, view: { hosted_collections: f.ids } });
      expect(result.members.find((m: any) => m.view.account_id === f.accounts[2])).toMatchObject({ view: { terminal_excluded: true, hosted_collections: [] }, terminal_excluded_at: expect.any(String) });
      expect(result.cutover_evidence_digest).toBeNull();
      expect(await localTakeoverAllowed(db, f.accounts[0]!)).toEqual({ local_takeover: false, account_backend: null });
    } finally { await app.close(); }
  });
  it("publishes current nonempty F evidence only for the complete held set, preserving original recorded timestamps as DATA", async () => {
    const f = await fixture(), app = await front(); try {
      const started = await startAccountMigration(db, f.accounts[0]!, "staging");
      await cut(f, 0);
      let result = (await request(app, f.name)).json(); expect(result.cutover_evidence_digest).toBeNull();
      await cut(f, 1);
      const full = await request(app, f.name); expect(full.statusCode, full.body).toBe(200); result = full.json();
      const member = result.members.find((m: any) => m.view.account_id === f.accounts[0]);
      expect(member.started_at).toBe(started.started_at); expect(member.cutovers).toHaveLength(2);
      expect(member.cutovers.every((c: any) => Object.keys(c).length === 8 && typeof c.barrier_f === "string")).toBe(true);
      const evidence = flipEvidenceDigest(member.cutovers); expect(result.cutover_evidence_digest).toBe(evidence);
      const flipped = await flipAccountBackend(db, f.accounts[0]!, f.ids, evidence, await migratedTimerGate(db, f.accounts[0]!, f.ids));
      result = (await request(app, f.name)).json();
      expect(result.members.find((m: any) => m.view.account_id === f.accounts[0]).flip).toEqual({ collections: f.ids, evidence_digest: evidence, flipped_at: flipped.flipped_at });
      expect(result.cutover_evidence_digest).toBe(evidence);
      expect(await localTakeoverAllowed(db, f.accounts[0]!)).toEqual({ local_takeover: false, account_backend: null });
      expect((await db.query("SELECT suspended_at FROM users WHERE id=$1", [f.accounts[0]])).rows[0].suspended_at).not.toBeNull();
    } finally { await app.close(); }
  });
  it("does not synthesize a positive digest for a collectionless cohort", async () => {
    const f = await fixture(2, false), app = await front(); try {
      const result = await request(app, f.name); expect(result.statusCode, result.body).toBe(200); expect(result.json().cutover_evidence_digest).toBeNull();
    } finally { await app.close(); }
  });
  it.each(["", "session", "hosted-role"])("denies non-migration credentials: %s", async credential => {
    const f = await fixture(), app = await front(); try { const result = await request(app, f.name, undefined, credential); expect(result.statusCode).toBe(401); } finally { await app.close(); }
  });
  it.each(["?view=other", "?view=receiving-v1&limit=1", "?view=receiving-v1&view=receiving-v1"])("refuses caller selectors/duplicate view: %s", async query => {
    const f = await fixture(), app = await front(); try { expect((await request(app, f.name, query)).statusCode).toBe(400); } finally { await app.close(); }
  });
  it.each([{environment:"production",status:503},{environment:"lab",status:409},{environment:"",status:503}])("refuses unsupported environment or mismatched accepted archive: $environment", async ({environment,status}) => {
    const f = await fixture(), app = await front(db, environment); try { expect((await request(app, f.name)).statusCode).toBe(status); } finally { await app.close(); }
  });
  it.each(["membership", "owner", "coverage"])("refuses stale accepted archive after raw topology drift: %s", async change => {
    const f = await fixture(), app = await front(); try {
      if (change === "membership") await db.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1", [f.name]);
      if (change === "owner") await db.query("UPDATE hosted_collections SET user_id=$1 WHERE id=$2", [f.accounts[1], f.ids[0]]);
      if (change === "coverage") await db.query("UPDATE hosted_collections SET authority_state='transferred' WHERE id=$1", [f.ids[0]]);
      const response = await request(app, f.name); expect(response.statusCode, response.body).toBe(409);
    } finally { await app.close(); }
  });
  it("refuses a frozen empty cohort rather than relabeling an empty header as receiving evidence", async () => {
    const f = await fixture(0, false), app = await front(); try { expect((await request(app, f.name)).statusCode).toBe(409); } finally { await app.close(); }
  });
  it("returns more than the candidates/in-progress page cap without truncation", async () => {
    const f = await fixture(137, false), app = await front(); try {
      const response = await request(app, f.name); expect(response.statusCode, response.body).toBe(200);
      expect(response.json().members.map((m: any) => m.view.account_id)).toEqual([...f.accounts].sort());
    } finally { await app.close(); }
  });
  it("refuses more than 1000 members without publishing a truncated inventory", async () => {
    const f = await fixture(1001, false), app = await front(); try {
      expect((await request(app, f.name)).statusCode).toBe(503);
      expect((await request(app, f.name, "")).json()).toEqual(f.binding);
    } finally { await app.close(); }
  });
  it("refuses more than 1000 held collections without narrowing the canonical archive binding", async () => {
    const f = await fixture(1, false), app = await front(); try {
      const ids = Array.from({ length: 1001 }, () => randomUUID());
      await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template)
        SELECT id,$2,'Synthetic','mdbase' FROM unnest($1::uuid[]) AS id`, [ids, f.accounts[0]]);
      const binding = await cohortArchiveBinding(db, f.name);
      const clock = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
      const archive = { ...f.archive, migration_batch: binding, archive_created_at: clock, archive_completed_at: clock,
        retention: { ...f.archive.retention, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString() } };
      await acceptCohortArchive(db, f.name, archive, "staging");
      expect((await request(app, f.name)).statusCode).toBe(503);
      expect((await request(app, f.name, "")).json()).toEqual(binding);
    } finally { await app.close(); }
  });
  it("keeps lossless recorded bigint F values while refusing unsupported numeric writes", async () => {
    const f = await fixture(), app = await front(); try {
      await startAccountMigration(db, f.accounts[0]!, "staging");
      await expect(recordCollectionCutover(db, f.ids[0]!, { s_final: 0, cutover_seq: 1, barrier_f: 9007199254740992, final_digest: hex(4) }))
        .rejects.toMatchObject({ code: "invalid_request" });
      await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','cloud_copy',$3)", [f.ids[0], f.accounts[0], Buffer.alloc(16)]);
      await db.query(`INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest)
        VALUES($1,$2,0,1,9007199254740993,$3)`, [f.ids[0], f.accounts[0], hex(4)]);
      const response = await request(app, f.name); expect(response.statusCode, response.body).toBe(200);
      expect(response.json().members.find((m: any) => m.view.account_id === f.accounts[0]).cutovers[0].barrier_f).toBe("9007199254740993");
      expect(response.json().cutover_evidence_digest).toBeNull();
    } finally { await app.close(); }
  });
  it("does not invert a concurrent user's row lock into the held batch lock", async () => {
    const f = await fixture(), blocker = await db.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [f.accounts[0]]);
    let pending: Promise<unknown> | undefined;
    const wrapped: DatabasePool = { query: db.query.bind(db), end: async () => {}, connect: async () => {
      const client = await db.connect(); return { release: () => client.release(), query: async (text, values) => {
        if (!pending && text.includes("SELECT u.account_backend")) pending = blocker.query("SELECT name FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [f.name]);
        return client.query(text, values);
      } };
    } };
    const app = await front(wrapped); try {
      const response = await request(app, f.name); expect(response.statusCode, response.body).toBe(200); await pending;
    } finally { await blocker.query("ROLLBACK").catch(() => undefined); blocker.release(); await app.close(); }
  });
  it("keeps all reads on one real repeatable-read snapshot across a concurrent status change", async () => {
    const f = await fixture(); let changed = false;
    const wrapped: DatabasePool = { query: db.query.bind(db), end: async () => {}, connect: async () => {
      const client = await db.connect(); return { release: () => client.release(), query: async (text, values) => {
        if (!changed && text.includes("SELECT u.account_backend")) { changed = true; await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.accounts[0]]); }
        return client.query(text, values);
      } };
    } };
    const app = await front(wrapped); try {
      const response = await request(app, f.name); expect(response.statusCode, response.body).toBe(200); expect(changed).toBe(true);
      expect(response.json().members.find((m: any) => m.view.account_id === f.accounts[0]).suspended).toBe(true);
      expect((await db.query("SELECT suspended_at FROM users WHERE id=$1", [f.accounts[0]])).rows[0].suspended_at).toBeNull();
    } finally { await app.close(); }
  });
  it("fails closed on a batch revision committed after a real lock wait, without emitting an old snapshot", async () => {
    const f = await fixture(), app = await front(), blocker = await db.connect(); await blocker.query("BEGIN");
    try {
      await blocker.query("SELECT name FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [f.name]);
      let settled = false; const response = request(app, f.name).then(result => { settled = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false);
      await blocker.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1", [f.name]); await blocker.query("COMMIT");
      const result = await response; expect(result.statusCode, result.body).toBe(503); expect(result.json().error.code).toBe("busy");
    } finally { await blocker.query("ROLLBACK").catch(() => undefined); blocker.release(); await app.close(); }
  });
});
