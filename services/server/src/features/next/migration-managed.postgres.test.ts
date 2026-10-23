// Real product adapter, rollout SQL, timer importer and terminal readback.
// Synthetic trusted archive intake and scripted Worker; no runtime/cloud qualification.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, openDatabase, type DatabasePool } from "../../db.js";
import type { LegacyNotificationWatermark } from "../../hosted-provider-replies.js";
import { fakeLegacyProvider } from "./legacy-provider.test-helper.js";
import { labRun, labStatus, postgresLabConnect, resumeLab, routeBack, PAUSE_REASON, STEP,
  type LabWorker, type WorkerReply, type WorkerStatus } from "./migration-lab.js";
import { inTransaction } from "./bootstrap-common.js";
import { registerMigrationProviderRoutes } from "./migration-provider.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { acceptCohortArchive, addToCohort, createCohort, cutOverCollection, flipEvidenceDigest,
  readCohortCaptureSnapshot, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";
import { requireCompletedAccountMigration } from "./migration-sharing.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const actor = "synthetic-managed-array", hold = "30000000-0000-4000-8000-000000000003";
const ok = (status: WorkerStatus): WorkerReply => ({ kind: "ok", status });
const empty = (): WorkerStatus => ({ run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } });

suite("managed whole-account driver through postgresLabConnect", () => {
  let admin: pg.Pool, writer: pg.Pool, db: DatabasePool, source: DatabasePool;
  const schemas: string[] = [], apps: FastifyInstance[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    schemas.push(...["managed_cp", "managed_src"].map(s => `${s}_${randomUUID().replaceAll("-", "")}`));
    for (const schema of schemas) await admin.query(`CREATE SCHEMA "${schema}"`);
    const cp = new URL(url); cp.searchParams.set("options", `-csearch_path=${schemas[0]}`); db = await createDatabase(cp.toString());
    const src = new URL(url); src.searchParams.set("options", `-csearch_path=${schemas[1]}`);
    writer = new pg.Pool({ connectionString: src.toString(), max: 2 });
    await writer.query(`
      CREATE TABLE hosted_provider_collections(id uuid PRIMARY KEY, state text NOT NULL,
        legacy_migration_id uuid, legacy_migration_started_at timestamptz, head bigint NOT NULL);
      CREATE TABLE mdbase_runtime_schema(singleton boolean PRIMARY KEY, version integer NOT NULL);
      INSERT INTO mdbase_runtime_schema VALUES(TRUE,2);
      CREATE TABLE mdbase_runtime_timers(namespace text,id text,generation bigint,status text,fire_at timestamptz,
        lease_worker text,lease_token text,lease_expires_at timestamptz,record_json jsonb);
      CREATE TABLE mdbase_runtime_runs(namespace text,id text,status text,lease_worker text,lease_token text,lease_expires_at timestamptz,record_json jsonb);
      CREATE TABLE hosted_provider_runtime_outbox(collection_id uuid,processed_at timestamptz,lease_token text,leased_until timestamptz);
      CREATE TABLE hosted_provider_replicas(id uuid PRIMARY KEY,collection_id uuid);
      CREATE TABLE hosted_provider_mutation_journal(replica_id uuid,state text);
    `);
    src.searchParams.set("options", `-csearch_path=${schemas[1]} -cdefault_transaction_read_only=on`);
    source = await openDatabase(src.toString());
    await setPaused(db, false, "synthetic managed", actor);
  }, 60_000);
  afterAll(async () => {
    await source?.end(); await writer?.end(); await db?.end();
    for (const schema of schemas) await admin?.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture(count = 2, transferred = 0) {
    const account = randomUUID(), collections = Array.from({ length: count }, () => randomUUID()).sort(), cohort = `managed-${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic managed')", [account, `${account}@example.test`]);
    for (const [id, state] of [...collections.map(id => [id, "active"]), ...Array.from({ length: transferred }, () => [randomUUID(), "transferred"])])
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic','mdbase','https://provider.example',$3)", [id, account, state]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor); await releaseCohort(db, cohort, actor);
    await setCohortFrozen(db, cohort, true, "synthetic freeze", actor);
    const capture = await inTransaction(db, client => readCohortCaptureSnapshot(client, cohort)), inventory = prearchiveInventory(capture);
    const clock = (await db.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
    const providers = new Map(collections.map(id => [id, fakeLegacyProvider(id, { started_at: new Date(clock.getTime() - 1000).toISOString() })]));
    const archive = { schema: count ? "mdbase-recovery-set/scoped-hosted-v1" : "mdbase-recovery-set/zero-hosted-v1", environment: "staging",
      bucket: "synthetic-archive", prefix: `legacy-archive/staging/2026/10/23/${cohort}`, backup_id: cohort,
      complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40), migration_batch: capture.binding,
      archive_created_at: clock.toISOString(), archive_completed_at: clock.toISOString(),
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(clock.getTime() + 116 * 86400000).toISOString(), inventory_digest: "d".repeat(64), count: count ? "5" : "2" },
      ...(count ? { scoped_recovery: { inventory_sha256: inventory.inventory_sha256,
        selection_sha256: createHash("sha256").update("mdbase-scoped-archive-selection/v1\n").update(JSON.stringify(inventory.selected.map(v => [v.account_id, v.collection_id]))).digest("hex"),
        source_rows_sha256: "e".repeat(64), recovered_inventory_sha256: "f".repeat(64), original_h6_journal_sha256: "1".repeat(64),
        source_fences: collections.map(collection_id => ({ account_id: account, collection_id, migration_id: providers.get(collection_id)!.source.migration_id,
          started_at: providers.get(collection_id)!.source.started_at, head: 42, in_flight: 0, unresolved: 0, applied_unreceipted: 0,
          notification_watermark: providers.get(collection_id)!.watermark, fence_reply_sha256: "2".repeat(64), drain_reply_sha256: "3".repeat(64) })) } } : {}) };
    await acceptCohortArchive(db, cohort, archive, "staging"); await startAccountMigration(db, account, "staging");
    for (const [id, p] of providers) await writer.query("INSERT INTO hosted_provider_collections VALUES($1,'migrating',$2,$3,42)", [id, p.source.migration_id, p.source.started_at]);
    // One genuine original timer per member exercises SQL snapshot decoding,
    // grant binding, target rows and identity checks, not only empty manifests.
    const application = randomUUID();
    await db.query("INSERT INTO applications(id,canonical_identity,manifest_version,name,homepage,redirect_uris) VALUES($1,$2,1,'Synthetic','https://app.example.test','[]'::jsonb)", [application, `bundle:test:${application}`]);
    for (const id of collections) {
      const grant = randomUUID(), timerId = "original-timer", runtimeId = `connect:${grant}:reminders:timer.${Buffer.from(timerId).toString("hex")}`;
      await db.query(`INSERT INTO grants(id,user_id,application_id,hosted_collection_id,operations,scope,application_origin,application_authorization,application_installation_id)
        VALUES($1,$2,$3,$4,'["reconcile_timers"]'::jsonb,'{"contracts":[]}'::jsonb,'https://app.example.test','{"binding":{"protocol_version":4}}'::jsonb,$5)`, [grant, account, application, id, randomUUID()]);
      const time = "2030-01-01T12:13:14.123456Z", record = { id: runtimeId, generation: 7, status: "scheduled", fire_at: time,
        created_at: time, updated_at: time, fired_at: null, event_contract: { id: "test/timer", version: "1", digest: `sha256:${"a".repeat(64)}` },
        event_source: { application: "original", implementation: "timer", version: "1" }, source_uri: "app:test", subject: timerId,
        data: { grant_id: grant, namespace: "reminders", timer_id: timerId, criterion_id: "reminder", data: { synthetic: true } } };
      await writer.query("INSERT INTO mdbase_runtime_timers(namespace,id,generation,status,fire_at,record_json) VALUES($1,$2,7,'scheduled',$3,$4::jsonb)",
        [`connect-hosted:${id}:notifications`, runtimeId, time, JSON.stringify(record)]);
    }
    const provider = {
      legacyMigrationFence: vi.fn(async () => { throw new Error("Original scoped fence must never be repeated"); }),
      legacyMigrationSource: vi.fn(async (id: string) => providers.get(id)!.legacyMigrationSource(id, { deadline: Date.now() + 1000 })),
      legacyMigrationDrain: async (id: string) => providers.get(id)!.legacyMigrationDrain(id, { deadline: Date.now() + 1000 }),
      legacyMigrationRetain: async (id: string, until: Date) => {
        const reply = await providers.get(id)!.legacyMigrationRetain(id, until, { deadline: Date.now() + 1000 });
        await writer.query("UPDATE hosted_provider_collections SET state='migrated' WHERE id=$1", [id]); return reply;
      }
    };
    const app = Fastify(), token = "synthetic-managed-source-role-".repeat(2); apps.push(app);
    registerMigrationProviderRoutes(app, { db, token, environment: "staging", provider });
    const prepareTarget = vi.fn(async (id: string) => {
      const existing = await db.query("SELECT 1 FROM next_collections WHERE collection_id=$1 AND runtime='shadow'", [id]);
      if (existing.rows.length) return; // Canonical target creator reuses committed SHADOW identity.
      await registerNextCollection(db, { collectionId: id, ownerUserId: account, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16, 17),
        ops: [{ op: "genesis", owner: account, root: Buffer.alloc(16, 17), state: "cloud-copy" }, { op: "member-set", account, role: "owner" }] });
    });
    const connect = postgresLabConnect({ db, source, actor, timers: true, environment: "staging", provider, prepareTarget });
    const runs = new Map<string, { cursor: number; pause: boolean; resumed: boolean }>();
    const failures = new Map<string, "stopped" | "unknown" | "absent">();
    const snapshot = (id: string, step: number, state = "running", reason: string | null = null): WorkerStatus => ({
      run: { state, reason, backup_hold: hold, migration_id: providers.get(id)!.source.migration_id,
        stop_before_flip: runs.get(id)?.pause ?? false, resumed_run_sequence: runs.get(id)?.resumed ? 1 : null },
      native: { run_sequence: 1, checkpoint: { step, fenced: step >= STEP.fenced }, outstanding: null }
    });
    const unused = vi.fn(async (): Promise<WorkerReply> => { throw new Error("Unexpected operator mutation"); });
    const worker: LabWorker = {
      run: vi.fn(async (id, _hold, pause = false) => {
        if (failures.get(id) === "absent") return { kind: "unknown", reason: "worker_unreachable" };
        runs.set(id, { cursor: 0, pause, resumed: false });
        return failures.get(id) === "unknown" ? { kind: "unknown", reason: "worker_unreachable" } : ok(snapshot(id, 0));
      }),
      status: vi.fn(async id => {
        if (["unknown", "absent"].includes(failures.get(id) ?? "")) {
          // Before the original dispatch the Worker is known-empty.
          const intent = await db.query("SELECT 1 FROM audit_events WHERE user_id=$1 AND subject_id=$2 AND event_type='next_migration.worker_run_intent'", [account, id]);
          if (intent.rows.length) return { kind: "unknown", reason: "worker_unreachable" };
        }
        const run = runs.get(id); if (!run) return ok(empty());
        if (failures.get(id) === "stopped") return ok(snapshot(id, STEP.verified, "stopped", "settlement_unknown"));
        if (run.pause && !run.resumed && run.cursor >= 1) return ok(snapshot(id, STEP.verified, "stopped", PAUSE_REASON));
        if (run.cursor++ === 0) {
          const reply = await app.inject({ method: "GET", url: `/internal/v1/next/migration/collections/${id}/source`, headers: { authorization: `Bearer ${token}` } });
          expect(reply.statusCode, reply.body).toBe(200); // Revalidates THIS member against the original accepted H6 context.
          return ok(snapshot(id, STEP.drained));
        }
        await cutOverCollection(db, provider, id, { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) });
        return ok(snapshot(id, STEP.routed, "done"));
      }),
      resume: vi.fn(async id => { runs.get(id)!.resumed = true; return ok(snapshot(id, STEP.verified)); }),
      rollback: unused, restart: unused, resolve: unused
    };
    const deps = { worker, connect, sleep: async () => undefined };
    return { account, collections, cohort, providers, provider, prepareTarget, connect, worker, runs, failures, deps, archive };
  }
  const backend = async (account: string) => (await db.query("SELECT account_backend FROM users WHERE id=$1", [account])).rows[0].account_backend;
  const events = async (account: string, event: string) => (await db.query("SELECT metadata FROM audit_events WHERE user_id=$1 AND event_type=$2 ORDER BY created_at", [account, event])).rows;
  const run = (f: Awaited<ReturnType<typeof fixture>>) => labRun(f.account, hold, f.deps);

  it.each([0, 1])("migrates both active members once, with %i transferred history rows", async transferred => {
    const f = await fixture(2, transferred);
    expect(await run(f)).toEqual({ done: { account_id: f.account, collection_ids: f.collections, backend: "next", migration_complete: true } });
    expect(await backend(f.account)).toBe("next"); expect(f.worker.run).toHaveBeenCalledTimes(2);
    const flip = (await db.query("SELECT collections::text[],evidence_digest FROM next_migration_account_flips WHERE account_id=$1", [f.account])).rows[0];
    expect(flip.collections).toEqual(f.collections); expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    expect(flip.evidence_digest).toBe(flipEvidenceDigest(f.collections.map(collection_id => ({ collection_id, barrier_f: 13, final_digest: "e".repeat(64) }))));
    expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
    expect(await events(f.account, "next_migration.timers_imported")).toHaveLength(2);
    expect((await events(f.account, "next_migration.timers_imported")).every(e => e.metadata.timers === 1)).toBe(true);
    for (const id of f.collections) await requireCompletedAccountMigration(db, id, f.account);
    await run(f); expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.worker.run).toHaveBeenCalledTimes(2); // completion-only retries, including a lost flip reply
  });

  it("all-transferred accounts stop without fabricating an empty migrated array", async () => {
    const f = await fixture(0, 2);
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "managed_inventory_empty" } });
    expect(await backend(f.account)).toBe("legacy"); expect(f.worker.run).not.toHaveBeenCalled();
    expect(await events(f.account, "next_migration.flip")).toHaveLength(0);
  });

  it.each(["stopped", "unknown"] as const)("second member %s retains the first cutover and resumes the original set", async failure => {
    const f = await fixture(), [first, second] = f.collections;
    f.failures.set(second!, failure);
    expect(await run(f)).toMatchObject({ stopped: { collection_id: second, collection_ids: f.collections } });
    expect(await backend(f.account)).toBe("legacy"); expect(f.providers.get(first!)!.source.state).toBe("migrated");
    expect(await events(f.account, "next_migration.flip")).toHaveLength(0);
    const status = await labStatus(f.account, f.deps);
    expect(status.collections).toEqual(f.collections.map(collection_id => expect.objectContaining({ collection_id })));
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "migration_post_cutover", collection_id: first } });
    expect(f.worker.rollback).not.toHaveBeenCalled(); expect(f.worker.restart).not.toHaveBeenCalled();
    f.failures.clear();
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.worker.run).toHaveBeenCalledTimes(2); expect(f.prepareTarget).toHaveBeenCalledTimes(2);
    const original = (await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rows[0].verified_result;
    expect(original).toEqual(f.archive); // Original source context survives partial cutover.
  });

  it("does not replay an UNKNOWN launch even when later status reports no run", async () => {
    const f = await fixture(), second = f.collections[1]!; f.failures.set(second, "absent");
    expect(await run(f)).toHaveProperty("stopped"); f.failures.clear();
    expect(await run(f)).toMatchObject({ stopped: { reason: "worker_run_outcome_unknown", collection_id: second } });
    expect(f.worker.run).toHaveBeenCalledTimes(2); expect(await backend(f.account)).toBe("legacy");
  });

  it("serializes concurrent original launch reservations on the existing account row", async () => {
    const f = await fixture(); await f.connect.bindRun!(f.account, f.collections, hold, false);
    const reservations = await Promise.all([f.connect.claimWorkerRun!(f.account, f.collections[0]!), f.connect.claimWorkerRun!(f.account, f.collections[0]!)]);
    expect(reservations.sort()).toEqual([false, true]);
    expect(await events(f.account, "next_migration.worker_run_intent")).toHaveLength(1); expect(f.worker.run).not.toHaveBeenCalled();
  });

  it("a lost CP intent COMMIT stops before dispatch and its durable intent prevents replay", async () => {
    const f = await fixture(); let loseCommit = true;
    const lossy: DatabasePool = { ...db, async connect() {
      const client = await db.connect(), query = client.query.bind(client); let intent = false;
      client.query = (async (sql: string, values?: unknown[], timeout?: number) => {
        const reply = await query(sql, values, timeout);
        if (sql.includes("INSERT INTO audit_events") && values?.[2] === "next_migration.worker_run_intent") intent = true;
        if (sql === "COMMIT" && intent && loseCommit) { loseCommit = false; throw Object.assign(new Error("Synthetic lost COMMIT ACK"), { code: "08006" }); }
        return reply;
      }) as typeof client.query;
      return client;
    } };
    f.deps.connect = postgresLabConnect({ db: lossy, source, actor, timers: true, environment: "staging", provider: f.provider, prepareTarget: f.prepareTarget });
    expect(await run(f)).toMatchObject({ stopped: { step: "worker_run", reason: "postgres_08006" } });
    expect(f.worker.run).not.toHaveBeenCalled(); expect(await events(f.account, "next_migration.worker_run_intent")).toHaveLength(1);
    expect(await run(f)).toMatchObject({ stopped: { reason: "worker_run_outcome_unknown" } });
    expect(f.worker.run).not.toHaveBeenCalled(); expect(await backend(f.account)).toBe("legacy");
  });

  it("rejects subset, duplicate, changed hold and changed held-set bindings", async () => {
    const f = await fixture();
    await expect(f.connect.bindRun!(f.account, [f.collections[0]!], hold, false)).rejects.toHaveProperty("code", "collections_mismatch");
    await expect(f.connect.bindRun!(f.account, [f.collections[0]!, f.collections[0]!], hold, false)).rejects.toHaveProperty("code", "collections_mismatch");
    f.failures.set(f.collections[1]!, "stopped"); await run(f);
    await expect(f.connect.flip(f.account, [f.collections[0]!])).rejects.toHaveProperty("code", "collections_mismatch");
    await expect(f.connect.flip(f.account, [f.collections[0]!, f.collections[0]!])).rejects.toHaveProperty("code", "collections_duplicated");
    expect(await labRun(f.account, randomUUID(), f.deps)).toMatchObject({ stopped: { reason: "managed_run_conflict" } });
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'drift','mdbase')", [randomUUID(), f.account]);
    expect(await run(f)).toMatchObject({ stopped: { reason: "collections_mismatch" } });
    expect(await backend(f.account)).toBe("legacy");
  });

  it("refreshes every manifest when the second member changes the first member's timer watermark", async () => {
    const f = await fixture(), original = f.connect.cutover.bind(f.connect);
    f.connect.cutover = async id => {
      await original(id);
      if (id === f.collections[1]) f.providers.get(f.collections[0]!)!.watermark = `"mdbase-legacy-notifications-v1:${"1".repeat(64)}"` as LegacyNotificationWatermark;
    };
    expect(await run(f)).toHaveProperty("done.migration_complete", true);
    const imports = await events(f.account, "next_migration.timers_imported");
    expect(imports).toHaveLength(4);
    expect(imports.slice(2).map(e => e.metadata.collection_id)).toEqual(f.collections);
    expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
  });

  it("pauses every member, resumes each original sequence, then flips once", async () => {
    const f = await fixture();
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { reason: PAUSE_REASON, collection_ids: f.collections } });
    expect(f.worker.run).toHaveBeenCalledTimes(2); expect(await backend(f.account)).toBe("legacy");
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.worker.resume).toHaveBeenCalledTimes(2); expect(f.worker.run).toHaveBeenCalledTimes(2);
  });

  it("managed resume can start a later member after an interrupted pause pass", async () => {
    const f = await fixture(), prepare = f.connect.prepareTarget.bind(f.connect); let interrupted = false;
    f.connect.prepareTarget = async id => {
      if (id === f.collections[1] && !interrupted) { interrupted = true; throw Object.assign(new Error("Synthetic target stop"), { code: "migration_target_unavailable" }); }
      return prepare(id);
    };
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { step: "prepare_target", collection_id: f.collections[1] } });
    expect(f.worker.run).toHaveBeenCalledTimes(1);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.worker.run).toHaveBeenCalledTimes(2); expect(f.worker.resume).toHaveBeenCalledTimes(2);
  });

  it.each([16, 17])("the %i-member boundary is enforced through the real adapter", async count => {
    const f = await fixture(count), result = await run(f);
    if (count === 16) {
      expect(result).toHaveProperty("done.migration_complete", true); expect(f.worker.run).toHaveBeenCalledTimes(16);
      expect(await events(f.account, "next_migration.timers_imported")).toHaveLength(16);
    } else {
      expect(result).toMatchObject({ stopped: { step: "preflight", reason: "managed_inventory_over_cap" } });
      expect(f.worker.run).not.toHaveBeenCalled(); expect(await backend(f.account)).toBe("legacy");
    }
  });
});
