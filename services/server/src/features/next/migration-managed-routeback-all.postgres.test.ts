// Narrowed F1/G2: real CP SQL + canonical rollback/unfence routes, modeled Worker
// and physical provider. No live runtime, transfer, hold admission or forward retry.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedProviderResponseError, type LegacyMigrationDrain } from "../../hosted-provider.js";
import type { LegacyMigrationRollbackReceipt, LegacyNotificationWatermark } from "../../hosted-provider-replies.js";
import { inTransaction } from "./bootstrap-common.js";
import { labRun, postgresLabConnect, routeBack, STEP, type LabWorker, type WorkerReply, type WorkerStatus } from "./migration-lab.js";
import { claim, registerMigrationProviderRoutes } from "./migration-provider.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { acceptCohortArchive, addToCohort, createCohort, readCohortCaptureSnapshot, releaseCohort,
  setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const actor = "synthetic-routeback-all", hold = "30000000-0000-4000-8000-000000000003";
const environment = "staging"; // Deployment selector DATA, never a staging endpoint.
const watermark = `"mdbase-legacy-notifications-v1:${"0".repeat(64)}"` as LegacyNotificationWatermark;
const empty = (): WorkerStatus => ({ run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } });
const ok = (status: WorkerStatus): WorkerReply => ({ kind: "ok", status });

suite("narrowed F1: restore ALL original held members to legacy", () => {
  let admin: pg.Pool, db: DatabasePool;
  const schema = `routeback_all_${randomUUID().replaceAll("-", "")}`, apps: FastifyInstance[] = [];
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/a4_routeback_all_test" || !url.port || ["28487", "28591"].includes(url.port)) {
      throw new Error("Explicit owned loopback a4_routeback_all_test PostgreSQL required");
    }
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await setPaused(db, false, "synthetic route-back only", actor);
  });
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture() {
    const account = randomUUID(), storage = randomUUID(), collections = [randomUUID(), randomUUID()].sort();
    const [first, second] = collections as [string, string], cohort = `routeback-${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic route-back')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)", [account, storage]);
    for (const id of collections) await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state)
      VALUES($1,$2,'Synthetic','mdbase','https://provider.example.test','active')`, [id, account]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor); await releaseCohort(db, cohort, actor);
    await setCohortFrozen(db, cohort, true, "synthetic original scope", actor);
    const capture = await inTransaction(db, client => readCohortCaptureSnapshot(client, cohort)), inventory = prearchiveInventory(capture);
    const clock = (await db.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
    // Both members were physically fenced BEFORE archive acceptance and CP start,
    // independently of whether a Worker was ever dispatched.
    const sources = new Map<string, LegacyMigrationDrain>(collections.map(id => [id, {
      collection_id: id, state: "migrating", migration_id: randomUUID(), head: 42,
      started_at: new Date(clock.getTime() - 1000).toISOString(), retain_until: null,
      in_flight: 0, unresolved: 0, applied_unreceipted: 0
    } satisfies LegacyMigrationDrain]));
    const archive = { schema: "mdbase-recovery-set/scoped-hosted-v1", environment,
      bucket: "synthetic-archive", prefix: `legacy-archive/${environment}/2026/10/23/${cohort}`, backup_id: cohort,
      complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40), migration_batch: capture.binding,
      archive_created_at: clock.toISOString(), archive_completed_at: clock.toISOString(),
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(clock.getTime() + 116 * 86400000).toISOString(), inventory_digest: "d".repeat(64), count: "5" },
      scoped_recovery: { inventory_sha256: inventory.inventory_sha256,
        selection_sha256: createHash("sha256").update("mdbase-scoped-archive-selection/v1\n").update(JSON.stringify(inventory.selected.map(v => [v.account_id, v.collection_id]))).digest("hex"),
        source_rows_sha256: "e".repeat(64), recovered_inventory_sha256: "f".repeat(64), original_h6_journal_sha256: "1".repeat(64),
        source_fences: collections.map(collection_id => ({ account_id: account, collection_id, migration_id: sources.get(collection_id)!.migration_id,
          started_at: sources.get(collection_id)!.started_at, head: 42, in_flight: 0, unresolved: 0, applied_unreceipted: 0,
          notification_watermark: watermark, fence_reply_sha256: "2".repeat(64), drain_reply_sha256: "3".repeat(64) })) } };
    await acceptCohortArchive(db, cohort, archive, environment);
    await startAccountMigration(db, account, environment); // Ordinary, never lab-fixture-v1.
    const originalSources = structuredClone([...sources.values()]);
    const receipts = new Map<string, LegacyMigrationRollbackReceipt>();
    const unexpected = vi.fn(async (): Promise<never> => { throw new Error("Unexpected forward/provider effect"); });
    const provider = {
      legacyMigrationSource: vi.fn(async (id: string) => ({ drain: { ...sources.get(id)! }, notificationWatermark: watermark })),
      legacyMigrationDrain: vi.fn(async (id: string) => ({ ...sources.get(id)! })),
      legacyMigrationFence: unexpected, legacyMigrationRetain: unexpected,
      legacyMigrationRevokedReplicas: vi.fn(async (id: string) => ({ collection_id: id, migration_id: sources.get(id)!.migration_id!, revoked: [] as string[] })),
      legacyMigrationUnfence: vi.fn(async (id: string) => {
        const source = sources.get(id)!;
        expect(source.state).toBe("migrating");
        Object.assign(source, { state: "active", migration_id: null, started_at: null });
        return { collection_id: id, state: "active" as const, migration_id: null, started_at: null, retain_until: null, restored: [] as string[] };
      }),
      legacyMigrationRollback: vi.fn(async (id: string, envelope: { provider_account_id: string; binding: LegacyMigrationRollbackReceipt["binding"] }) => {
        const conflict = () => new HostedProviderResponseError(409, "legacy_rollback_binding_conflict", "Synthetic binding conflict");
        if (envelope.provider_account_id !== storage) throw conflict();
        const existing = receipts.get(id);
        if (existing) { if (JSON.stringify(existing.binding) !== JSON.stringify(envelope.binding)) throw conflict(); return existing; }
        const source = sources.get(id)!;
        if (source.state !== "migrating" || source.migration_id !== envelope.binding.provider_migration_id || source.head !== envelope.binding.fixed_head) throw conflict();
        Object.assign(source, { state: "active", migration_id: null, started_at: null });
        const receipt = { collection_id: id, binding: { ...envelope.binding }, restored_ids: [], recorded_at: new Date().toISOString() };
        receipts.set(id, receipt); return receipt;
      }),
      legacyMigrationRollbackReceipt: vi.fn(async (id: string) => {
        const receipt = receipts.get(id);
        if (!receipt) throw new HostedProviderResponseError(404, "legacy_rollback_receipt_unknown", "No receipt");
        return receipt;
      }),
      legacyMigrationReplicas: unexpected, legacyMigrationRevokeReplicas: unexpected, legacyMigrationRestoreReplicas: unexpected
    };
    const app = Fastify(), token = "synthetic-owned-routeback-token-".repeat(2); apps.push(app);
    registerMigrationProviderRoutes(app, { db, token, environment, provider });
    registerMigrationReplicaRoutes(app, { db, token, provider });
    const cp = (kind: string, id: string, payload?: Record<string, unknown>) => app.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${id}/${kind}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    // No source DB/timer importer or target creator is exercised in this lane.
    // source=db is an unused required composition slot, not legacy source data.
    const connect = postgresLabConnect({ db, source: db, actor, timers: false, environment, provider, importTimers: unexpected, prepareTarget: unexpected });
    await connect.bindRun!(account, collections, hold, false);
    const states = new Map<string, WorkerStatus>();
    const worker: LabWorker = {
      status: vi.fn(async id => ok(structuredClone(states.get(id) ?? empty()))),
      run: vi.fn(async (id, backupHold, pause) => {
        expect(backupHold).toBe(hold); expect(pause).toBe(true);
        const fence = await cp("fence", id); expect(fence.statusCode, fence.body).toBe(200);
        expect(fence.json().migration_id).toBe(sources.get(id)!.migration_id);
        const state: WorkerStatus = { run: { state: "stopped", reason: "rollback_needs_operator", backup_hold: backupHold,
          migration_id: sources.get(id)!.migration_id, stop_before_flip: true, resumed_run_sequence: null },
          native: { run_sequence: 1, checkpoint: { step: STEP.drained, fenced: true }, outstanding: null } };
        states.set(id, state); return ok(structuredClone(state));
      }),
      rollback: vi.fn(async (id, sequence) => {
        const state = states.get(id)!; expect(sequence).toBe(1);
        const current = await claim(db, id);
        const reply = await cp("rollback", id, { owner_account: current.account, started_us: current.started_us, migration_id: state.run!.migration_id,
          fixed_head: 42, driver_id: hold, action_id: randomUUID(), replica_ids: [] });
        expect(reply.statusCode, reply.body).toBe(200);
        state.run!.reason = "rolled_back";
        state.native = { run_sequence: 1, checkpoint: { step: STEP.rolledBack, fenced: false }, outstanding: null };
        return ok(structuredClone(state));
      }),
      restart: unexpected, resolve: unexpected, resume: unexpected
    };
    const dispatch = async (id: string) => {
      expect(await connect.claimWorkerRun!(account, id)).toBe(true);
      expect(await worker.run(id, hold, true)).toHaveProperty("kind", "ok");
    };
    const deps = { connect, worker, sleep: async () => undefined, now: () => 0 };
    return { account, cohort, collections, first, second, sources, originalSources, archive, provider, unexpected, connect, worker, states, dispatch, deps, cp };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const events = async (f: Fixture, type: string) => (await db.query("SELECT subject_id,metadata FROM audit_events WHERE user_id=$1 AND event_type=$2 ORDER BY subject_id", [f.account, type])).rows;
  async function canonicalSources(f: Fixture) {
    // Not Worker labels: read the same physical provider source API used by CP.
    return Promise.all(f.collections.map(async id => (await f.provider.legacyMigrationSource(id)).drain));
  }
  async function noForwardEffects(f: Fixture) {
    expect(f.unexpected).not.toHaveBeenCalled();
    expect(await events(f, "next_migration.flip")).toEqual([]);
    expect((await db.query("SELECT 1 FROM next_migration_account_flips WHERE account_id=$1", [f.account])).rows).toEqual([]);
    expect((await db.query("SELECT 1 FROM next_migration_collections WHERE account_id=$1", [f.account])).rows).toEqual([]);
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [f.account])).rows).toEqual([{ account_backend: "legacy" }]);
    expect((await db.query("SELECT id,authority_state FROM hosted_collections WHERE user_id=$1 ORDER BY id", [f.account])).rows)
      .toEqual(f.collections.map(id => ({ id, authority_state: "active" })));
    expect((await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rows[0]!.verified_result).toEqual(f.archive);
  }

  it("G2: C1 known pre-cutover + C2 NEVER DISPATCHED restores BOTH physical sources, without restart or archive weakening", async () => {
    const f = await fixture(); await f.dispatch(f.first);
    expect(await canonicalSources(f)).toEqual(f.originalSources);
    expect(await f.worker.status(f.second)).toEqual(ok(empty()));
    expect((await events(f, "next_migration.worker_run_intent")).map(e => e.subject_id)).toEqual([f.first]);
    const result = await routeBack(f.account, f.deps);
    expect(result).toHaveProperty("done");
    await noForwardEffects(f);
    expect(f.worker.run).toHaveBeenCalledTimes(1); expect(f.worker.rollback).toHaveBeenCalledTimes(1);
    expect(f.worker.rollback).toHaveBeenCalledWith(f.first, 1);
    expect.soft(await canonicalSources(f)).toEqual(f.collections.map(collection_id => ({ ...f.originalSources.find(s => s.collection_id === collection_id)!,
      state: "active", migration_id: null, started_at: null, retain_until: null })));
    // A repeated operator command may verify the result, never create a new run.
    expect(await routeBack(f.account, f.deps)).toEqual(result);
    expect(f.provider.legacyMigrationRollback).toHaveBeenCalledTimes(1);
    expect(f.worker.run).toHaveBeenCalledTimes(1); await noForwardEffects(f);
  });

  it("G2 disposition: restored ordinary multi stays legacy for post-bulk follow-up, never fresh-attempt/refence advice", async () => {
    const f = await fixture(); await f.dispatch(f.first); await f.dispatch(f.second);
    const result = await routeBack(f.account, f.deps);
    expect(result).toHaveProperty("done");
    expect(await canonicalSources(f)).toEqual(f.originalSources.map(s => ({ ...s, state: "active", migration_id: null, started_at: null })));
    expect(await events(f, "next_migration.managed_route_back")).toHaveLength(1);
    expect(await labRun(f.account, hold, f.deps)).toHaveProperty("stopped.reason", "managed_route_back_started");
    await noForwardEffects(f);
    // Do not invent a new disposition enum/protocol in tests; reject the old instruction.
    expect(result).not.toHaveProperty("done.disposition", "fresh_attempt_required");
  });

  it("existing canonical started-claim unfence CAN restore C2 with no Worker run or intent", async () => {
    const f = await fixture(), current = await claim(db, f.second);
    expect(await events(f, "next_migration.worker_run_intent")).toEqual([]);
    const reply = await f.cp("unfence", f.second, { owner_account: current.account, started_us: current.started_us,
      migration_id: f.sources.get(f.second)!.migration_id });
    expect(reply.statusCode, reply.body).toBe(200);
    expect((await f.provider.legacyMigrationSource(f.second)).drain).toMatchObject({ state: "active", migration_id: null, started_at: null, retain_until: null });
    expect(f.provider.legacyMigrationUnfence).toHaveBeenCalledWith(f.second, expect.objectContaining({ deadline: expect.any(Number) }));
    expect(await events(f, "next_migration.unfence")).toHaveLength(1);
    expect(f.worker.run).not.toHaveBeenCalled(); expect(f.worker.rollback).not.toHaveBeenCalled(); await noForwardEffects(f);
    // The archive's original-source predicate is still enforced after restoration.
    const refence = await f.cp("fence", f.second);
    expect(refence.statusCode).toBe(409); expect(refence.json().error.code).toBe("migration_archive_source_changed");
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  // This is a conservative refusal check, NOT positive quiet-period eligibility:
  // deps.now controls polling; the quiet period is the intent's DB age (UNKNOWN_QUIET_SECONDS).
  it.each([0, 300_000, 330_000])("UNKNOWN/no-run with driver clock %ims is NOT absence proof or permission to unfence without live-hold revocation", async elapsed => {
    const f = await fixture(); await f.dispatch(f.first);
    expect(await f.connect.claimWorkerRun!(f.account, f.second)).toBe(true); // COMMIT, delivery unknown.
    expect(await routeBack(f.account, { ...f.deps, now: () => elapsed })).toMatchObject({ stopped: {
      reason: "worker_run_outcome_unknown", collection_id: f.second } });
    expect(f.worker.status).toHaveBeenCalledWith(f.second); // Fresh read in EACH invocation.
    expect(await canonicalSources(f)).toEqual(f.originalSources);
    expect(f.provider.legacyMigrationUnfence).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled();
    expect(await events(f, "next_migration.managed_route_back")).toEqual([]); await noForwardEffects(f);
  });

  it.each(["unknown", "refused"] as const)("driver clock >300s+margin never substitutes for a fresh Worker status (%s)", async kind => {
    const f = await fixture(); await f.dispatch(f.first); await f.connect.claimWorkerRun!(f.account, f.second);
    f.worker.status = vi.fn(async (id: string): Promise<WorkerReply> => id === f.second ? kind === "unknown"
      ? { kind: "unknown", reason: "worker_unreachable" } : { kind: "refused", code: "synthetic_status_refused" }
      : ok(structuredClone(f.states.get(id)!)));
    expect(await routeBack(f.account, { ...f.deps, now: () => 330_000 })).toMatchObject({ stopped: {
      collection_id: f.second, reason: kind === "unknown" ? "worker_unreachable" : "synthetic_status_refused" } });
    expect(await canonicalSources(f)).toEqual(f.originalSources);
    expect(f.provider.legacyMigrationUnfence).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled();
    await noForwardEffects(f);
  });

  it.each(["checkpoint", "outstanding"] as const)("no Worker run with native %s is NOT a never-dispatched member", async residue => {
    const f = await fixture(); await f.dispatch(f.first);
    f.states.set(f.second, { ...empty(), native: { run_sequence: 1,
      checkpoint: residue === "checkpoint" ? { step: STEP.drained, fenced: true } : null,
      outstanding: residue === "outstanding" ? { sequence: 1, kind: 11 } : null } });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "worker_run_missing", collection_id: f.second } });
    expect(await canonicalSources(f)).toEqual(f.originalSources);
    expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationUnfence).not.toHaveBeenCalled();
    await noForwardEffects(f);
  });

  it("cutover latch refuses route-back BEFORE any rollback/unfence, even with an advanced clock and no-run sibling", async () => {
    const f = await fixture(); await f.dispatch(f.first); await f.connect.claimWorkerRun!(f.account, f.second);
    await f.connect.latchPhase!(f.account, "cutover"); vi.mocked(f.worker.status).mockClear();
    expect(await routeBack(f.account, { ...f.deps, now: () => 330_000 })).toMatchObject({ stopped: { reason: "managed_cutover_started" } });
    expect(f.worker.status).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationUnfence).not.toHaveBeenCalled();
    expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled(); expect(await canonicalSources(f)).toEqual(f.originalSources);
    expect(await events(f, "next_migration.managed_route_back")).toEqual([]); await noForwardEffects(f);
  });

  it("rechecks the whole set after the route-back latch: a newly visible cutover intent blocks ALL unfencing", async () => {
    const f = await fixture(); await f.dispatch(f.first);
    let reads = 0;
    f.worker.status = vi.fn(async (id: string): Promise<WorkerReply> => {
      if (id === f.second && ++reads === 2) return ok({ ...empty(), native: { run_sequence: 1,
        checkpoint: { step: STEP.cutoverIntent, fenced: true }, outstanding: null } });
      return ok(structuredClone(f.states.get(id) ?? empty()));
    });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { collection_id: f.second, reason: "migration_post_cutover" } });
    expect(reads).toBe(2); expect(await events(f, "next_migration.managed_route_back")).toHaveLength(1);
    expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationUnfence).not.toHaveBeenCalled();
    expect(await canonicalSources(f)).toEqual(f.originalSources); await noForwardEffects(f);
  });
});
