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
import { readIntents, readManagedRun, readPhaseLatch } from "./migration-managed-ledger.js";
import { claim, registerMigrationProviderRoutes } from "./migration-provider.js";
import { postgresRearm, rearm } from "./migration-rearm.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { acceptCohortArchive, accountMigrationView, addToCohort, cohortArchiveBinding, createCohort, readCohortCaptureSnapshot, releaseCohort,
  RolloutRefused, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";

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

  function scopedArchive(cohort: string, account: string, collections: readonly string[], sources: ReadonlyMap<string, LegacyMigrationDrain>,
    capture: Awaited<ReturnType<typeof readCohortCaptureSnapshot>>, clock: Date) {
    const inventory = prearchiveInventory(capture);
    return { schema: "mdbase-recovery-set/scoped-hosted-v1", environment,
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
  }

  async function fixture(options: { bind?: boolean; beforeFence?: boolean; missing?: boolean } = {}) {
    const account = randomUUID(), storage = randomUUID(), collections = [randomUUID(), randomUUID()].sort();
    const [first, second] = collections as [string, string], cohort = `routeback-${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic route-back')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)", [account, storage]);
    for (const id of collections) await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state)
      VALUES($1,$2,'Synthetic','mdbase','https://provider.example.test','active')`, [id, account]);
    // A provider-missing quarantine is outside every migration inventory.
    const missing = options.missing ? randomUUID() : null;
    if (missing) await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state,quarantined_at,quarantine_reason)
      VALUES($1,$2,'Synthetic missing','mdbase','https://provider.example.test','active',now(),'provider_collection_missing')`, [missing, account]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor); await releaseCohort(db, cohort, actor);
    await setCohortFrozen(db, cohort, true, "synthetic original scope", actor);
    const capture = await inTransaction(db, client => readCohortCaptureSnapshot(client, cohort));
    const clock = (await db.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
    // Both members were physically fenced BEFORE archive acceptance and CP start,
    // independently of whether a Worker was ever dispatched.
    const sources = new Map<string, LegacyMigrationDrain>(collections.map(id => [id, {
      collection_id: id, state: "migrating", migration_id: randomUUID(), head: 42,
      started_at: new Date(clock.getTime() - 1000).toISOString(), retain_until: null,
      in_flight: 0, unresolved: 0, applied_unreceipted: 0
    } satisfies LegacyMigrationDrain]));
    const archive = scopedArchive(cohort, account, collections, sources, capture, clock);
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
    if (options.bind !== false) await connect.bindRun!(account, collections, hold, false);
    const states = new Map<string, WorkerStatus>(), nativeRollbackSources: LegacyMigrationDrain[][] = [];
    const worker: LabWorker = {
      status: vi.fn(async (id: string): Promise<WorkerReply> => ok(structuredClone(states.get(id) ?? empty()))),
      run: vi.fn(async (id: string, backupHold: string, pause?: boolean): Promise<WorkerReply> => {
        expect(backupHold).toBe(hold); expect(pause).toBe(true);
        if (!options.beforeFence) {
          const fence = await cp("fence", id); expect(fence.statusCode, fence.body).toBe(200);
          expect(fence.json().migration_id).toBe(sources.get(id)!.migration_id);
        }
        // Native BackupHeld = 1: EnsureBackup settled, then prepare failed before
        // Fence. Status reads NEVER progress or heal this stopped native run.
        const state: WorkerStatus = { run: { state: "stopped", reason: options.beforeFence ? "native_unavailable" : "rollback_needs_operator", backup_hold: backupHold,
          migration_id: options.beforeFence ? null : sources.get(id)!.migration_id!, stop_before_flip: true, resumed_run_sequence: null },
          native: { run_sequence: 1, checkpoint: { step: options.beforeFence ? 1 : STEP.drained, fenced: !options.beforeFence }, outstanding: null } };
        states.set(id, state); return ok(structuredClone(state));
      }),
      rollback: vi.fn(async (id: string, sequence: number): Promise<WorkerReply> => {
        const state = states.get(id)!; expect(sequence).toBe(1);
        if (options.beforeFence) {
          // Reachable native rollback with cp.fenced=false has no provider run
          // context: RollingBack -> RolledBack, WITHOUT provider Unfence.
          expect(state).toMatchObject({ run: { migration_id: null }, native: { checkpoint: { step: 1, fenced: false }, outstanding: null } });
          nativeRollbackSources.push(structuredClone([...sources.values()]));
        } else {
          const current = await claim(db, id);
          const reply = await cp("rollback", id, { owner_account: current.account, started_us: current.started_us, migration_id: state.run!.migration_id,
            fixed_head: 42, driver_id: hold, action_id: randomUUID(), replica_ids: [] });
          expect(reply.statusCode, reply.body).toBe(200);
        }
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
    const rearmer = postgresRearm({ db, actor, environment, provider });
    return { account, storage, missing, cohort, collections, first, second, sources, originalSources, archive, provider, unexpected, connect, worker, states, nativeRollbackSources, dispatch, deps, cp, rearmer };
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
    expect((await db.query("SELECT id,authority_state FROM hosted_collections WHERE user_id=$1 AND quarantine_reason IS NULL ORDER BY id", [f.account])).rows)
      .toEqual(f.collections.map(id => ({ id, authority_state: "active" })));
    expect((await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rows[0]!.verified_result).toEqual(f.archive);
  }

  it("R3 P1-1: native BackupHeld rollback without provider Unfence still restores every ORIGINAL prearchive fence", async () => {
    const f = await fixture({ beforeFence: true }); await f.dispatch(f.first);
    expect(f.states.get(f.first)).toMatchObject({ run: { reason: "native_unavailable", migration_id: null },
      native: { checkpoint: { step: 1, fenced: false }, outstanding: null } });
    expect(await canonicalSources(f)).toEqual(f.originalSources);
    const result = await routeBack(f.account, f.deps);
    expect(f.nativeRollbackSources).toEqual([f.originalSources]); // Native rollback itself did NOT restore the provider.
    expect(f.states.get(f.first)).toMatchObject({ run: { reason: "rolled_back", migration_id: null },
      native: { checkpoint: { step: STEP.rolledBack, fenced: false }, outstanding: null } });
    expect(f.worker.rollback).toHaveBeenCalledExactlyOnceWith(f.first, 1);
    expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled();
    expect.soft(result).toMatchObject({ done: { disposition: "legacy_post_bulk_follow_up",
      collections: f.collections.map(collection_id => ({ collection_id, legacy_verified: true })) } });
    expect.soft(await canonicalSources(f)).toEqual(f.originalSources.map(s => ({ ...s, state: "active", migration_id: null, started_at: null })));
    expect.soft(f.provider.legacyMigrationUnfence.mock.calls.map(([id]) => id)).toEqual(f.collections);
    expect(f.worker.run).toHaveBeenCalledTimes(1); await noForwardEffects(f);
  });

  it("R3 P2-1: immediate scoped route-back with NO binding, intent or Worker restores all sources without inventing a hold", async () => {
    const f = await fixture({ bind: false });
    expect(await f.connect.preflight(f.account)).toMatchObject({ run: null, intents: [], archive_scoped: true, phase_latch: null });
    expect(f.states.size).toBe(0); expect(await canonicalSources(f)).toEqual(f.originalSources);
    const result = await routeBack(f.account, f.deps);
    expect.soft(result).toMatchObject({ done: { disposition: "legacy_post_bulk_follow_up", collection_ids: f.collections } });
    expect.soft(await canonicalSources(f)).toEqual(f.originalSources.map(s => ({ ...s, state: "active", migration_id: null, started_at: null })));
    const latch = await events(f, "next_migration.managed_route_back");
    expect.soft(latch).toHaveLength(1);
    for (const event of latch) expect(event.metadata).not.toHaveProperty("backup_hold");
    expect(await events(f, "next_migration.managed_run")).toEqual([]);
    expect(await events(f, "next_migration.worker_run_intent")).toEqual([]);
    expect(f.worker.run).not.toHaveBeenCalled(); expect(f.worker.rollback).not.toHaveBeenCalled();
    expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled(); await noForwardEffects(f);
  });

  it("R3 P2-2: BIND and dispatch reservation freshly refuse whole-set changes AFTER waiting for the user lock", async () => {
    for (const phase of ["bind", "reserve"] as const) {
      const f = await fixture({ bind: phase === "reserve" }), holder = await db.connect(), added = randomUUID();
      expect(await f.connect.preflight(f.account)).toMatchObject({ collections: f.collections, intents: [] });
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query("BEGIN");
        const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await holder.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [f.account]);
        pending = (phase === "bind" ? f.connect.bindRun!(f.account, f.collections, hold, false)
          : f.connect.claimWorkerRun!(f.account, f.first)).then(value => ({ admitted: value }), (error: unknown) => error);
        // Establish actual blocking by THIS test's account-lock holder, not a
        // sleep/race assumption or another connection's unrelated wait.
        let blocked = false;
        for (let i = 0; i < 200; i++) {
          if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%FOR NO KEY UPDATE%'", [pid])).rows.length) {
            blocked = true; break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        if (phase === "bind") await holder.query("UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1", [f.second]);
        else await holder.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state)
          VALUES($1,$2,'Added while reservation waits','mdbase','https://provider.example.test','active')`, [added, f.account]);
        await holder.query("COMMIT");
      } finally {
        await holder.query("ROLLBACK"); holder.release();
        // Always drain the attempt, including when a blocking assertion fails.
        await pending;
      }
      expect.soft(await pending).toMatchObject(phase === "bind"
        ? { code: "collections_unsettled", details: { unsettled: [{ collection_id: f.second, predicate: "quarantined" }] } }
        : { code: "collections_mismatch", details: { added: [added], missing: [] } });
      expect.soft(await events(f, "next_migration.managed_run")).toHaveLength(phase === "bind" ? 0 : 1);
      expect.soft(await events(f, "next_migration.worker_run_intent")).toEqual([]);
      expect(f.worker.run).not.toHaveBeenCalled(); expect(f.unexpected).not.toHaveBeenCalled();
      expect(await canonicalSources(f)).toEqual(f.originalSources);
      expect(await events(f, "next_migration.flip")).toEqual([]);
    }
  });

  it("R3 P2-3: never-dispatched unfence refuses a replacement ORIGINAL run or malformed active source, never adopting it", async () => {
    for (const drift of ["replacement-run", "active-identity", "active-run", "active-start", "active-retention", "valid-active"] as const) {
      const f = await fixture(), source = f.sources.get(f.second)!;
      if (drift === "replacement-run") source.migration_id = randomUUID();
      else {
        Object.assign(source, { state: "active", migration_id: null, started_at: null });
        if (drift === "active-identity") source.collection_id = randomUUID();
        if (drift === "active-run") source.migration_id = randomUUID();
        if (drift === "active-start") source.started_at = f.originalSources[1]!.started_at;
        if (drift === "active-retention") source.retain_until = "2030-01-01T00:00:00.000Z";
      }
      const observed = structuredClone(source);
      expect(await events(f, "next_migration.worker_run_intent")).toEqual([]); expect(f.states.size).toBe(0);
      const outcome = await f.connect.unfence!(f.account, f.second).then(() => null, (error: unknown) => error);
      if (drift === "valid-active") expect(outcome).toBeNull();
      else expect.soft(outcome, drift).toBeInstanceOf(RolloutRefused);
      expect.soft(f.provider.legacyMigrationUnfence, drift).not.toHaveBeenCalled();
      expect.soft((await f.provider.legacyMigrationSource(f.second)).drain, drift).toEqual(observed);
      expect.soft(await events(f, "next_migration.unfence"), drift).toEqual([]);
      expect(f.worker.run).not.toHaveBeenCalled(); expect(f.worker.rollback).not.toHaveBeenCalled(); await noForwardEffects(f);
    }
  });

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

  describe("operator re-arm of a routed-back account", () => {
    const rearms = async (account: string) => (await db.query<{ cohort: string; collections: string[]; retired: number }>(
      "SELECT cohort, collections::text[] AS collections, cardinality(retired_events) AS retired FROM next_migration_rearms WHERE account_id=$1", [account])).rows;
    const revision = async (cohort: string) => (await db.query<{ r: string }>("SELECT membership_revision::text AS r FROM next_migration_cohorts WHERE name=$1", [cohort])).rows[0]!.r;
    const member = async (account: string) => (await db.query("SELECT cohort FROM next_migration_cohort_members WHERE account_id=$1", [account])).rows;
    /** A routed-back E-shaped account: every member dispatched, one provider-missing collection outside the set. */
    async function routedBack() {
      const f = await fixture({ missing: true }); await f.dispatch(f.first); await f.dispatch(f.second);
      expect(await routeBack(f.account, f.deps)).toHaveProperty("done.disposition", "legacy_post_bulk_follow_up");
      return f;
    }
    const code = (error: unknown) => (error as { code?: unknown }).code;

    it("detaches the account into history, keeps the old cohort's accepted binding current, and is idempotent", async () => {
      const f = await routedBack(), before = await revision(f.cohort);
      const result = await rearm(f.account, f.deps, f.rearmer);
      expect(result).toMatchObject({ done: { account_id: f.account, rearmed: true, previous_cohort: f.cohort, collection_ids: f.collections } });
      expect(result).not.toHaveProperty("done.already_rearmed");
      // The old cohort still counts the account: same revision, digest and accepted archive binding.
      expect(await revision(f.cohort)).toBe(before);
      expect(await cohortArchiveBinding(db, f.cohort)).toEqual(f.archive.migration_batch);
      expect(await rearms(f.account)).toEqual([{ cohort: f.cohort, collections: f.collections, retired: 5 }]);
      expect(await member(f.account)).toEqual([]);
      expect(await accountMigrationView(db, f.account)).toMatchObject({ backend: "legacy", cohort: null, released: false, started: false,
        hosted_collections: f.collections, unsettled_collections: [], cut_over_collections: [] });
      // The attempt's ledger is retired: no start, binding, intent or latch remains current.
      expect(await readManagedRun(db, f.account)).toBeNull(); expect(await readPhaseLatch(db, f.account)).toBeNull();
      expect(await readIntents(db, f.account)).toEqual([]);
      expect(await events(f, "next_migration.rearm")).toHaveLength(1);
      // Replay: the recorded re-arm, with no second history row or Worker read.
      vi.mocked(f.worker.status).mockClear();
      expect(await rearm(f.account, f.deps, f.rearmer)).toEqual({ done: { ...(result as { done: object }).done, already_rearmed: true } });
      expect(f.worker.status).not.toHaveBeenCalled(); expect(await rearms(f.account)).toHaveLength(1);
      await noForwardEffects(f);
    });

    it("never adopts the stale archive: the next attempt needs its own cohort, acceptance and start", async () => {
      const f = await routedBack(); await rearm(f.account, f.deps, f.rearmer);
      const oldRevision = await revision(f.cohort);
      expect(code(await startAccountMigration(db, f.account, environment).catch(e => e))).toBe("account_not_released");
      expect(code(await addToCohort(db, f.cohort, [f.account], actor).catch(e => e))).toBe("migration_frozen");
      const next = `rearmed-${randomUUID()}`;
      await createCohort(db, next, actor);
      expect(await addToCohort(db, next, [f.account], actor)).toEqual([f.account]);
      await releaseCohort(db, next, actor); await setCohortFrozen(db, next, true, "synthetic fresh attempt", actor);
      expect(code(await startAccountMigration(db, f.account, environment).catch(e => e))).toBe("backup_missing");
      // New prearchive fences, a new archive over the new cohort's binding, then a fresh start.
      const clock = (await db.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
      for (const id of f.collections) Object.assign(f.sources.get(id)!, { state: "migrating", migration_id: randomUUID(),
        started_at: new Date(clock.getTime() - 1000).toISOString() });
      const capture = await inTransaction(db, client => readCohortCaptureSnapshot(client, next));
      expect(capture.members.map(m => [m.view.account_id, m.export_collections])).toEqual([[f.account, f.collections]]);
      await acceptCohortArchive(db, next, scopedArchive(next, f.account, f.collections, f.sources, capture, clock), environment);
      await startAccountMigration(db, f.account, environment);
      expect(await f.connect.preflight(f.account)).toMatchObject({ job: "managed", run: null, intents: [], phase_latch: null, rearmed: true,
        collections: f.collections });
      const fresh = "60000000-0000-4000-8000-000000000006";
      await f.connect.bindRun!(f.account, f.collections, fresh, false);
      expect(await readManagedRun(db, f.account)).toMatchObject({ backup_hold: fresh });
      expect(await f.connect.claimWorkerRun!(f.account, f.first)).toBe(true);
      expect(await readIntents(db, f.account)).toEqual([f.first]);
      expect(await claim(db, f.first)).toMatchObject({ account: f.account });
      expect(await revision(f.cohort)).toBe(oldRevision);
      expect(await cohortArchiveBinding(db, f.cohort)).toEqual(f.archive.migration_batch);
    });

    it.each(["none", "cutover", "sources", "intent", "held", "flip"] as const)("refuses %s before any change", async refusal => {
      const f = await fixture({ missing: true }); await f.dispatch(f.first);
      const active = () => { for (const s of f.sources.values()) Object.assign(s, { state: "active", migration_id: null, started_at: null }); };
      let collections: readonly string[] = f.collections, expected: string;
      if (refusal === "none") { active(); expected = "rearm_not_routed_back"; }
      else if (refusal === "cutover") { await f.connect.latchPhase!(f.account, "cutover"); active(); expected = "managed_cutover_started"; }
      else if (refusal === "sources") { await f.connect.latchPhase!(f.account, "route_back"); expected = "rearm_source_not_active"; }
      else if (refusal === "intent") {
        await f.connect.claimWorkerRun!(f.account, f.second); await f.connect.latchPhase!(f.account, "route_back"); active();
        expected = "worker_run_outcome_unknown";
      } else {
        expect(await routeBack(f.account, f.deps)).toHaveProperty("done");
        if (refusal === "held") { collections = [f.first]; expected = "collections_mismatch"; }
        else { await db.query("INSERT INTO next_migration_account_flips(account_id,collections,evidence_digest) VALUES($1,$2::uuid[],$3)",
          [f.account, f.collections, "0".repeat(64)]); expected = "rearm_cutover_recorded"; }
      }
      const before = await revision(f.cohort);
      expect(code(await f.rearmer.rearm(f.account, collections, []).catch(e => e))).toBe(expected);
      expect(await rearms(f.account)).toEqual([]); expect(await member(f.account)).toEqual([{ cohort: f.cohort }]);
      expect(await revision(f.cohort)).toBe(before); expect(await events(f, "next_migration.rearm")).toEqual([]);
    });

    it("an ordinary member deletion still changes its cohort's revision", async () => {
      const f = await fixture({ bind: false }), before = BigInt(await revision(f.cohort));
      await db.query("DELETE FROM next_migration_cohort_members WHERE account_id=$1", [f.account]);
      expect(BigInt(await revision(f.cohort))).toBe(before + 1n);
    });
  });
});
