// Real product adapter, rollout SQL, timer importer, CP fence/source/rollback
// routes, timer cleanup and terminal readback. Synthetic trusted archive intake
// and a modeled pause-mode Worker that drives those real CP routes; no
// runtime/cloud qualification.
import { createHash, randomUUID } from "node:crypto";
import { ensureDevelopmentEntitlement } from "../../entitlements.js";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, openDatabase, type DatabasePool } from "../../db.js";
import { HostedProviderResponseError } from "../../hosted-provider.js";
import type { LegacyMigrationRollbackReceipt, LegacyNotificationWatermark } from "../../hosted-provider-replies.js";
import { fakeLegacyProvider } from "./legacy-provider.test-helper.js";
import { labRun, labStatus, postgresLabConnect, resumeLab, routeBack, PAUSE_REASON, STEP,
  type LabWorker, type WorkerReply, type WorkerStatus } from "./migration-lab.js";
import { migrationDeployments, migrationRoute, type MigrationRouting } from "./migration-routing.js";
import { inTransaction } from "./bootstrap-common.js";
import { latchPhase, readManagedRun } from "./migration-managed-ledger.js";
import { claim, registerMigrationProviderRoutes } from "./migration-provider.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, cutOverCollection, flipEvidenceDigest,
  readCohortCaptureSnapshot, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";
import { requireCompletedAccountMigration } from "./migration-sharing.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const actor = "synthetic-managed-array", hold = "30000000-0000-4000-8000-000000000003";
const CLI = "pnpm --filter @mdbase/connect-server next:migration-lab";
const ok = (status: WorkerStatus): WorkerReply => ({ kind: "ok", status });
const refused = (code: string): WorkerReply => ({ kind: "refused", code });
const lost: WorkerReply = { kind: "unknown", reason: "worker_unreachable" };
const empty = (): WorkerStatus => ({ run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } });

/** Scripted Worker faults, per member:
 * - `stop_prepare`: the original run stops once drained, before the pause (phase 1);
 * - `absent`: the dispatch reply is lost and no run exists (intent, no run);
 * - `lost_resume_reply`: resume takes effect but its reply is lost;
 * - `delayed_resume`: the resume reply is lost and the request has not arrived yet
 *   (`deliver()` lets the original request arrive later);
 * - `stop_cutover`: after resume the run stops at cutover intent with an
 *   outstanding forward action the driver cannot settle (phase 2). */
type Fault = "stop_prepare" | "absent" | "lost_resume_reply" | "delayed_resume" | "stop_cutover";
type ModelRun = { hold: string; pause: boolean; seq: number; step: number; state: string; reason: string | null;
  resumed: number | null; outstanding: { sequence: number; kind: number } | null; migration: string };

suite("managed two-phase driver through postgresLabConnect and the real CP routes", () => {
  let admin: pg.Pool, writer: pg.Pool, db: DatabasePool, source: DatabasePool;
  const schemas: string[] = [], apps: FastifyInstance[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
  beforeAll(async () => {
    const url = new URL(testUrl!);
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
      CREATE TABLE hosted_provider_mutation_journal(replica_id uuid,state text,lease_expires_at timestamptz);
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

  async function fixture(count = 2, transferred = 0, environment: "lab" | "staging" | "production" = "staging", contract: "ordinary" | "fixture" = "ordinary", missing = 0) {
    const account = randomUUID(), collections = Array.from({ length: count }, (): string => randomUUID()).sort(), cohort = `managed-${randomUUID()}`;
    const storage = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic managed')", [account, `${account}@example.test`]);
    await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)", [account, storage]);
    for (const id of collections)
      await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic','mdbase','https://provider.example','active')", [id, account]);
    // Transferred history as an ordinary promotion leaves it: the SAME id is now an
    // active local collection of the owner's connector, linked from the hosted row.
    const transferredIds = Array.from({ length: transferred }, () => randomUUID()).sort();
    if (transferred) await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Synthetic transfer daemon',$3)", [account, account, randomUUID()]);
    for (const id of transferredIds) {
      const local = randomUUID();
      await db.query(`INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,enabled,present,authority_state,authority_epoch)
        VALUES($1,$2,$2,$3,'Promoted','0.3.0',true,true,'active',2)`, [local, account, id]);
      await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state,authority_epoch,transferred_collection_id)
        VALUES($1,$2,'Synthetic','mdbase','https://provider.example','transferred',2,$3)`, [id, account, local]);
    }
    for (let i = 0; i < missing; i++)
      await db.query(`INSERT INTO hosted_collections(id,user_id,display_name,template,quarantined_at,quarantine_reason)
        VALUES($1,$2,'Missing','mdbase',now(),'provider_collection_missing')`, [randomUUID(), account]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor); await releaseCohort(db, cohort, actor);
    await setCohortFrozen(db, cohort, true, "synthetic freeze", actor);
    const capture = await inTransaction(db, client => readCohortCaptureSnapshot(client, cohort)), inventory = prearchiveInventory(capture);
    const clock = (await db.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
    const providers = new Map(collections.map(id => [id, fakeLegacyProvider(id, { started_at: new Date(clock.getTime() - 1000).toISOString() })]));
    const archive = { schema: count ? "mdbase-recovery-set/scoped-hosted-v1" : "mdbase-recovery-set/zero-hosted-v1", environment,
      bucket: "synthetic-archive", prefix: `legacy-archive/${environment}/2026/10/23/${cohort}`, backup_id: cohort,
      complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40), migration_batch: capture.binding,
      archive_created_at: clock.toISOString(), archive_completed_at: clock.toISOString(),
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(clock.getTime() + 116 * 86400000).toISOString(), inventory_digest: "d".repeat(64), count: count ? "5" : "2" },
      ...(count ? { scoped_recovery: { inventory_sha256: inventory.inventory_sha256,
        selection_sha256: createHash("sha256").update("mdbase-scoped-archive-selection/v1\n").update(JSON.stringify(inventory.selected.map(v => [v.account_id, v.collection_id]))).digest("hex"),
        source_rows_sha256: "e".repeat(64), recovered_inventory_sha256: "f".repeat(64), original_h6_journal_sha256: "1".repeat(64),
        source_fences: collections.map(collection_id => ({ account_id: account, collection_id, migration_id: providers.get(collection_id)!.source.migration_id,
          started_at: providers.get(collection_id)!.source.started_at, head: 42, in_flight: 0, unresolved: 0, applied_unreceipted: 0,
          notification_watermark: providers.get(collection_id)!.watermark, fence_reply_sha256: "2".repeat(64), drain_reply_sha256: "3".repeat(64) })) } } : {}) };
    await acceptCohortArchive(db, cohort, archive, environment);
    await startAccountMigration(db, account, environment, contract === "fixture" ? capture.binding : undefined);
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
    const receipts = new Map<string, LegacyMigrationRollbackReceipt>();
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected provider effect"); };
    const rollbackConflict = () => new HostedProviderResponseError(409, "legacy_rollback_binding_conflict", "Synthetic conflict.");
    const provider = {
      legacyMigrationFence: vi.fn(async () => { throw new Error("Original scoped fence must never be repeated"); }),
      legacyMigrationSource: vi.fn(async (id: string) => providers.get(id)!.legacyMigrationSource(id, { deadline: Date.now() + 1000 })),
      legacyMigrationDrain: async (id: string) => providers.get(id)!.legacyMigrationDrain(id, { deadline: Date.now() + 1000 }),
      legacyMigrationRetain: async (id: string, until: Date) => {
        const reply = await providers.get(id)!.legacyMigrationRetain(id, until, { deadline: Date.now() + 1000 });
        await writer.query("UPDATE hosted_provider_collections SET state='migrated' WHERE id=$1", [id]); return reply;
      },
      legacyMigrationRevokedReplicas: async (id: string) => {
        const s = providers.get(id)!.source;
        if (s.state !== "migrating" || !s.migration_id) throw new HostedProviderResponseError(409, "legacy_migration_not_started", "Not fenced.");
        return { collection_id: id, migration_id: s.migration_id, revoked: [] as string[] };
      },
      // Provider semantics: physical owner, one receipt per run, exact binding on replay/read.
      legacyMigrationRollback: vi.fn(async (id: string, envelope: { provider_account_id: string; binding: LegacyMigrationRollbackReceipt["binding"] }) => {
        if (envelope.provider_account_id !== storage) throw rollbackConflict();
        const existing = receipts.get(id);
        if (existing) { if (JSON.stringify(existing.binding) !== JSON.stringify(envelope.binding)) throw rollbackConflict(); return existing; }
        const s = providers.get(id)!.source;
        if (s.state !== "migrating" || s.migration_id !== envelope.binding.provider_migration_id || envelope.binding.fixed_head !== s.head) throw rollbackConflict();
        Object.assign(s, { state: "active", migration_id: null, started_at: null });
        await writer.query("UPDATE hosted_provider_collections SET state='active',legacy_migration_id=NULL,legacy_migration_started_at=NULL WHERE id=$1", [id]);
        const made = { collection_id: id, binding: { ...envelope.binding }, restored_ids: [], recorded_at: new Date().toISOString() };
        receipts.set(id, made); return made;
      }),
      legacyMigrationRollbackReceipt: async (id: string) => {
        const found = receipts.get(id);
        if (!found) throw new HostedProviderResponseError(404, "legacy_rollback_receipt_unknown", "No receipt.");
        return found;
      },
      legacyMigrationReplicas: unexpected, legacyMigrationRevokeReplicas: unexpected,
      legacyMigrationRestoreReplicas: unexpected,
      legacyMigrationUnfence: vi.fn(async (id: string) => {
        const s = providers.get(id)!.source;
        if (s.state !== "migrating") throw new HostedProviderResponseError(409, "legacy_migration_not_started", "Not fenced.");
        Object.assign(s, { state: "active", migration_id: null, started_at: null });
        await writer.query("UPDATE hosted_provider_collections SET state='active',legacy_migration_id=NULL,legacy_migration_started_at=NULL WHERE id=$1", [id]);
        return { collection_id: id, state: "active" as const, migration_id: null, started_at: null, retain_until: null };
      })
    };
    const app = Fastify(), token = "synthetic-managed-source-role-".repeat(2); apps.push(app);
    registerMigrationProviderRoutes(app, { db, token, environment, provider });
    registerMigrationReplicaRoutes(app, { db, token, provider });
    const cp = (method: "GET" | "POST", id: string, kind: string, payload?: Record<string, unknown>) => app.inject({ method,
      url: `/internal/v1/next/migration/collections/${id}/${kind}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    const prepareTarget = vi.fn(async (id: string) => {
      const existing = await db.query("SELECT 1 FROM next_collections WHERE collection_id=$1 AND runtime='shadow'", [id]);
      if (existing.rows.length) return; // Canonical target creator reuses committed SHADOW identity.
      await registerNextCollection(db, { collectionId: id, ownerUserId: account, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16, 17),
        ops: [{ op: "genesis", owner: account, root: Buffer.alloc(16, 17), state: "cloud-copy" }, { op: "member-set", account, role: "owner" }] });
    });
    const connect = postgresLabConnect({ db, source, actor, timers: true, environment, provider, prepareTarget });

    // The modeled Worker: one original run per collection, idempotent for the same
    // hold and pause mode. Its first wake takes the original fence and reads the
    // source through the real CP routes; a pause-mode run stops at the verified
    // pre-cutover pause until resumed; rollback goes through the real CP route.
    const runs = new Map<string, ModelRun>(), faults = new Map<string, Fault>(), order: string[] = [], delayed: (() => Promise<WorkerReply>)[] = [];
    const snapshot = (id: string): WorkerStatus => {
      const r = runs.get(id); if (!r) return empty();
      return { run: { state: r.state, reason: r.reason, backup_hold: r.hold, migration_id: r.migration, stop_before_flip: r.pause, resumed_run_sequence: r.resumed },
        native: { run_sequence: r.seq, checkpoint: { step: r.step, fenced: r.step >= STEP.fenced && r.step < STEP.rollingBack }, outstanding: r.outstanding } };
    };
    const advance = async (id: string, r: ModelRun) => {
      if (r.state !== "running") return;
      if (r.step === 0) {
        const fence = await cp("POST", id, "fence");
        expect(fence.statusCode, fence.body).toBe(200); expect(fence.json().migration_id).toBe(r.migration);
        const read = await cp("GET", id, "source");
        expect(read.statusCode, read.body).toBe(200); // Revalidates THIS member against the original accepted H6 context.
        r.step = STEP.drained;
      } else if (r.step === STEP.drained) {
        if (faults.get(id) === "stop_prepare") Object.assign(r, { state: "stopped", reason: "settlement_unknown" });
        else {
          r.step = STEP.verified;
          if (r.pause && r.resumed === null) { Object.assign(r, { state: "stopped", reason: PAUSE_REASON }); order.push(`pause:${id}`); }
        }
      } else if (r.step === STEP.verified) {
        if (faults.get(id) === "stop_cutover") {
          Object.assign(r, { step: STEP.cutoverIntent, state: "stopped", reason: "settlement_unknown", outstanding: { sequence: 9, kind: 19 } });
          return;
        }
        await cutOverCollection(db, provider, id, { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) });
        order.push(`cutover:${id}`);
        Object.assign(r, { step: STEP.routed, state: "done" });
      }
    };
    const unused = vi.fn(async (): Promise<WorkerReply> => { throw new Error("Unexpected operator mutation"); });
    const worker: LabWorker = {
      run: vi.fn(async (id, runHold, pause = false) => {
        const existing = runs.get(id);
        if (existing) return existing.hold !== runHold ? refused("migration_run_exists") : existing.pause !== pause ? refused("migration_pause_mode_conflict") : ok(snapshot(id));
        if (faults.get(id) === "absent") return lost;
        runs.set(id, { hold: runHold, pause, seq: 1, step: 0, state: "running", reason: null, resumed: null, outstanding: null,
          migration: providers.get(id)!.source.migration_id! });
        order.push(`run:${id}`);
        return ok(snapshot(id));
      }),
      status: vi.fn(async id => {
        const r = runs.get(id); if (r) await advance(id, r);
        return ok(snapshot(id));
      }),
      resume: vi.fn(async (id, sequence) => {
        if (faults.get(id) === "delayed_resume") {
          faults.delete(id); delayed.push(() => worker.resume(id, sequence)); return lost;
        }
        const r = runs.get(id);
        if (!r || r.seq !== sequence || r.state !== "stopped" || r.reason !== PAUSE_REASON || r.resumed !== null) return refused("migration_not_paused");
        Object.assign(r, { resumed: sequence, state: "running", reason: null }); order.push(`resume:${id}`);
        return faults.get(id) === "lost_resume_reply" ? lost : ok(snapshot(id));
      }),
      rollback: vi.fn(async (id, sequence) => {
        const r = runs.get(id);
        if (!r || r.seq !== sequence || r.state === "running" || r.step >= STEP.cutoverIntent) return refused("migration_rollback_refused");
        const current = await claim(db, id);
        const reply = await cp("POST", id, "rollback", { owner_account: current.account, started_us: current.started_us, migration_id: r.migration,
          fixed_head: 42, driver_id: hold, action_id: randomUUID(), replica_ids: [] });
        if (reply.statusCode !== 200) return refused(reply.json().error.code);
        Object.assign(r, { step: STEP.rolledBack, state: "stopped", reason: "rolled_back", outstanding: null }); order.push(`rollback:${id}`);
        return ok(snapshot(id));
      }),
      restart: unused, resolve: unused
    };
    const deps = { worker, connect, sleep: async () => undefined };
    return { account, collections, transferredIds, cohort, providers, provider, prepareTarget, connect, worker, runs, faults, order, delayed, deps, archive, environment, cp };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const backend = async (account: string) => (await db.query("SELECT account_backend FROM users WHERE id=$1", [account])).rows[0].account_backend;
  const events = async (account: string, event: string) => (await db.query("SELECT metadata FROM audit_events WHERE user_id=$1 AND event_type=$2 ORDER BY created_at", [account, event])).rows;
  const cutOvers = async (account: string) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM next_migration_collections WHERE account_id=$1", [account])).rows[0]!.n;
  const timers = async (collection: string) => (await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM next_timers t JOIN grants g ON g.id=t.grant_id WHERE g.hosted_collection_id=$1", [collection])).rows[0]!.n;
  const run = (f: Fixture) => labRun(f.account, hold, f.deps);
  const twoPhaseOrder = (ids: readonly string[]) => [...ids.flatMap(id => [`run:${id}`, `pause:${id}`]), ...ids.flatMap(id => [`resume:${id}`, `cutover:${id}`])];

  it.each([["staging", 0], ["staging", 1], ["lab", 1], ["production", 0]] as const)("%s ordinary start: every member reaches the verified pause before any cutover, then one flip (%i transferred)", async (environment, transferred) => {
    const f = await fixture(2, transferred, environment);
    expect(await run(f)).toEqual({ done: { account_id: f.account, collection_ids: f.collections, backend: "next", migration_complete: true } });
    expect(f.order).toEqual(twoPhaseOrder(f.collections));
    expect(await backend(f.account)).toBe("next"); expect(f.worker.run).toHaveBeenCalledTimes(2);
    expect(f.worker.run).toHaveBeenCalledWith(f.collections[0], hold, true);
    const flip = (await db.query("SELECT collections::text[],evidence_digest FROM next_migration_account_flips WHERE account_id=$1", [f.account])).rows[0];
    expect(flip.collections).toEqual(f.collections); expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    expect(flip.evidence_digest).toBe(flipEvidenceDigest(f.collections.map(collection_id => ({ collection_id, barrier_f: 13, final_digest: "e".repeat(64) }))));
    expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
    // Each member's timers: once before the barrier, once more right before its cutover.
    const imports = await events(f.account, "next_migration.timers_imported");
    expect(imports.map(e => e.metadata.collection_id)).toEqual([...f.collections, ...f.collections]);
    expect(imports.every(e => e.metadata.timers === 1)).toBe(true);
    expect(await events(f.account, "next_migration.managed_run")).toEqual([{ metadata: { binding: "two-phase-v1", collections: f.collections,
      backup_hold: hold, operator_stop_before_flip: false, started_us: expect.stringMatching(/^[1-9][0-9]*$/u) } }]);
    expect((await events(f.account, "next_migration.worker_run_intent")).map(e => e.metadata.worker_pause)).toEqual([true, true]);
    for (const id of f.collections) await requireCompletedAccountMigration(db, id, f.account);
    await run(f); expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.worker.run).toHaveBeenCalledTimes(2); // completion-only retries, including a lost flip reply
  });

  it("a plain one-member LAB ordinary scoped start completes end to end as a one-element array", async () => {
    const f = await fixture(1, 0, "lab"), [only] = f.collections;
    expect(await f.connect.preflight(f.account)).toMatchObject({ job: "managed", collections: [only], archive_scoped: true, intents: [] });
    expect(await run(f)).toEqual({ done: { account_id: f.account, collection_ids: [only], backend: "next", migration_complete: true } });
    expect(f.order).toEqual(twoPhaseOrder([only!])); expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
    await requireCompletedAccountMigration(db, only!, f.account);
  });

  it.each(["staging", "lab"] as const)("%s all-transferred accounts stop without fabricating an empty migrated array", async environment => {
    const f = await fixture(0, 2, environment);
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "managed_inventory_empty" } });
    expect(await backend(f.account)).toBe("legacy"); expect(f.worker.run).not.toHaveBeenCalled();
    expect(await events(f.account, "next_migration.flip")).toHaveLength(0);
  });

  it.each(["lab", "staging"] as const)("%s routes only held members to the migration Worker; promoted local history keeps its ordinary route", async environment => {
    const f = await fixture(2, 1, environment), [local] = f.transferredIds, native = randomUUID();
    const routing: MigrationRouting = { environment, accounts: new Set(), inboundToken: "i".repeat(40),
      hosted: { url: `https://mdbase-next-hosted-mig-${environment}.synthetic.workers.dev`, token: "m".repeat(40) } };
    const normal = { hosted: { url: "https://hosted.example.test", token: "h".repeat(40) }, escrow: { url: "https://escrow.example.test", token: "e".repeat(40) } };
    const cloudCopy = (collectionId: string, owner: string) => registerNextCollection(db, { collectionId, ownerUserId: owner, runtime: "next", sync: "cloud_copy",
      rootKeyId: Buffer.alloc(16, 18), ops: [{ op: "genesis", owner, root: Buffer.alloc(16, 18), state: "cloud-copy" }, { op: "member-set", account: owner, role: "owner" }] });
    await ensureDevelopmentEntitlement(db, f.account);
    await cloudCopy(native, f.account); // A CP-native cloud copy the owner already had.
    const routes = () => Promise.all([...f.collections, local!, native].map(id => migrationRoute(db, routing, id)));
    const expected = ["migration", "migration", "default", "default"];
    expect(await routes()).toEqual(expected); // Frozen, released and started; still legacy.
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { reason: PAUSE_REASON, collection_ids: f.collections } });
    expect(await routes()).toEqual(expected);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(await backend(f.account)).toBe("next"); expect(await routes()).toEqual(expected);
    for (const id of f.collections) await requireCompletedAccountMigration(db, id, f.account);
    // Start, flip and completion leave the promoted local authority and its connector untouched.
    expect((await db.query(`SELECT c.authority_state, c.authority_epoch::int AS epoch, k.revoked_at FROM collections c JOIN connectors k ON k.id=c.connector_id
      WHERE c.local_id=$1`, [local])).rows).toEqual([{ authority_state: "active", epoch: 2, revoked_at: null }]);
    // Cloud-copy creation admits the owner's own local id; after the flip it gets the ordinary deployments.
    await cloudCopy(local!, f.account);
    expect(await migrationRoute(db, routing, local!)).toBe("default");
    expect(await migrationDeployments(db, normal, routing, local!)).toBe(normal);
    expect(await migrationDeployments(db, normal, routing, f.collections[0]!)).toEqual({ ...normal, hosted: routing.hosted });
    // Transferred history still counts as authoritative ownership for the ambiguity guard.
    const other = randomUUID(), history = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic other')", [other, `${other}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$2,'History','mdbase','transferred')", [history, f.account]);
    await ensureDevelopmentEntitlement(db, other);
    await cloudCopy(history, other);
    await expect(migrationRoute(db, routing, history)).rejects.toThrow("ambiguous_collection_owner");
  });

  it("skips missing-provider quarantines through archive, binding, flip and whole-account completion", async () => {
    const f = await fixture(2, 0, "staging", "ordinary", 1);
    const before = (await db.query("SELECT * FROM hosted_collections WHERE user_id=$1 AND quarantined_at IS NOT NULL", [f.account])).rows;
    expect(before).toHaveLength(1);
    expect(await run(f)).toHaveProperty("done.migration_complete", true);
    for (const id of f.collections) await requireCompletedAccountMigration(db, id, f.account);
    expect(await cutOvers(f.account)).toBe(2);
    expect((await db.query("SELECT * FROM hosted_collections WHERE user_id=$1 AND quarantined_at IS NOT NULL", [f.account])).rows).toEqual(before);
    expect((await db.query("SELECT collections::text[] FROM next_migration_account_flips WHERE account_id=$1", [f.account])).rows[0].collections).toEqual(f.collections);
    expect((await source.query("SELECT 1 FROM hosted_provider_collections WHERE id=$1", [before[0].id])).rows).toEqual([]);
  });

  it("stop-before-flip returns at the shared barrier with nothing cut over; resume crosses it once", async () => {
    const f = await fixture();
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { reason: PAUSE_REASON, phase: "prepare",
      collection_ids: f.collections, resume: `${CLI} resume ${f.account}` } });
    expect(f.order).toEqual(f.collections.flatMap(id => [`run:${id}`, `pause:${id}`]));
    expect(await cutOvers(f.account)).toBe(0); expect(await backend(f.account)).toBe("legacy");
    expect(f.collections.map(id => f.providers.get(id)!.source.state)).toEqual(["migrating", "migrating"]);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.order).toEqual(twoPhaseOrder(f.collections));
    expect(f.worker.resume).toHaveBeenCalledTimes(2); expect(f.worker.run).toHaveBeenCalledTimes(2);
  });

  it("resume refuses an interrupted pause pass; lab-run completes the pass first", async () => {
    const f = await fixture(), prepare = f.connect.prepareTarget.bind(f.connect); let interrupted = false;
    f.connect.prepareTarget = async id => {
      if (id === f.collections[1] && !interrupted) { interrupted = true; throw Object.assign(new Error("Synthetic target stop"), { code: "migration_target_unavailable" }); }
      return prepare(id);
    };
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { step: "prepare_target", collection_id: f.collections[1], phase: "prepare" } });
    expect(await resumeLab(f.account, f.deps)).toMatchObject({ stopped: { step: "resume", reason: "managed_pause_incomplete", collection_id: f.collections[1] } });
    expect(f.worker.resume).not.toHaveBeenCalled(); expect(f.worker.run).toHaveBeenCalledTimes(1);
    expect(await labRun(f.account, hold, f.deps, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.order).toEqual(twoPhaseOrder(f.collections));
  });

  it("phase 1 failure: route-back rolls back every dispatched member through the real CP route, restores legacy, removes imported timers and never restarts a scoped archive", async () => {
    const f = await fixture(), [first, second] = f.collections;
    f.faults.set(second!, "stop_prepare");
    expect(await run(f)).toMatchObject({ stopped: { step: "worker_status", reason: "settlement_unknown", phase: "prepare",
      collection_id: second, collection_ids: f.collections } });
    expect(await cutOvers(f.account)).toBe(0); expect(f.worker.resume).not.toHaveBeenCalled();
    expect(f.collections.map(id => f.runs.get(id)!.reason)).toEqual([PAUSE_REASON, "settlement_unknown"]);
    expect(await timers(first!)).toBe(1); expect(await timers(second!)).toBe(1);
    const back = await routeBack(f.account, f.deps);
    expect(back).toEqual({ done: { account_id: f.account, collection_ids: f.collections, not_dispatched: [], disposition: "legacy_post_bulk_follow_up",
      collections: f.collections.map(collection_id => ({ account_id: f.account, collection_id, rolled_back: true, legacy_verified: true, run_sequence: 1 })) } });
    expect(f.order.filter(e => e.startsWith("rollback:"))).toEqual(f.collections.map(id => `rollback:${id}`));
    for (const id of f.collections) {
      expect(f.providers.get(id)!.source).toMatchObject({ state: "active", migration_id: null, started_at: null });
      expect(await timers(id)).toBe(0);
    }
    expect(await events(f.account, "next_migration.rollback")).toHaveLength(2);
    expect(await events(f.account, "next_migration.timers_rollback_cleanup")).toHaveLength(2);
    expect(f.worker.restart).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled();
    // Why no restart: the CP fence refuses once route-back has latched (and the restored source is no longer the archived one).
    const refence = await f.cp("POST", first!, "fence");
    expect(refence.statusCode).toBe(409); expect(refence.json().error.code).toBe("managed_route_back_started");
    expect(await backend(f.account)).toBe("legacy"); expect(await events(f.account, "next_migration.flip")).toHaveLength(0);
    // Idempotent: a repeated route-back re-verifies, records nothing new and calls no provider rollback.
    expect(await routeBack(f.account, f.deps)).toEqual(back);
    expect(f.provider.legacyMigrationRollback).toHaveBeenCalledTimes(2); expect(await events(f.account, "next_migration.rollback")).toHaveLength(2);
    // The route-back latch is terminal for this attempt: lab-run neither dispatches again nor resumes.
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "managed_route_back_started", resume: `${CLI} route-back ${f.account}` } });
    expect(await events(f.account, "next_migration.managed_route_back")).toEqual([{ metadata: { binding: "two-phase-v1", backup_hold: hold,
      started_us: expect.stringMatching(/^[1-9][0-9]*$/u) } }]);
    expect(await events(f.account, "next_migration.managed_cutover")).toHaveLength(0);
    expect(f.worker.run).toHaveBeenCalledTimes(2);
  });

  it("route-back unfences a never-dispatched member (no run, no native state, no intent) through the canonical started-claim unfence", async () => {
    const f = await fixture(), [first, second] = f.collections;
    f.faults.set(first!, "stop_prepare");
    expect(await run(f)).toMatchObject({ stopped: { reason: "settlement_unknown", collection_id: first, phase: "prepare" } });
    expect(f.worker.run).toHaveBeenCalledTimes(1); expect(f.prepareTarget).toHaveBeenCalledTimes(1);
    const back = await routeBack(f.account, f.deps);
    expect(back).toMatchObject({ done: { not_dispatched: [second], disposition: "legacy_post_bulk_follow_up",
      collections: [{ collection_id: first, rolled_back: true }, { collection_id: second, not_dispatched: true, legacy_verified: true }] } });
    // Its original prearchive fence is lifted by the existing unfence step, bound to that run.
    for (const id of f.collections) expect(f.providers.get(id)!.source).toMatchObject({ state: "active", migration_id: null, started_at: null });
    expect(await events(f.account, "next_migration.unfence")).toEqual([{ metadata: { migration_id: f.archive.scoped_recovery!.source_fences[1]!.migration_id } }]);
    expect(await events(f.account, "next_migration.rollback_intent")).toEqual([{ metadata: expect.objectContaining({ migration_id: f.runs.get(first!)!.migration }) }]);
    expect(f.worker.run).toHaveBeenCalledTimes(1); expect(f.order).toEqual([`run:${first}`, `rollback:${first}`]);
    // No dispatch under this attempt any more; a rerun re-verifies without a second unfence.
    await expect(f.connect.claimWorkerRun!(f.account, second!)).rejects.toHaveProperty("code", "managed_route_back_started");
    expect(await events(f.account, "next_migration.worker_run_intent")).toHaveLength(1);
    expect(await routeBack(f.account, f.deps)).toEqual(back);
    expect(f.provider.legacyMigrationUnfence).toHaveBeenCalledTimes(1); expect(await backend(f.account)).toBe("legacy");
  });

  it("a scoped route-back with nothing dispatched still restores every prearchive-fenced member", async () => {
    const f = await fixture(), prepare = vi.fn(async () => { throw Object.assign(new Error("Synthetic target stop"), { code: "migration_target_unavailable" }); });
    f.connect.prepareTarget = prepare;
    expect(await run(f)).toMatchObject({ stopped: { step: "prepare_target", collection_id: f.collections[0] } });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ done: { not_dispatched: f.collections, disposition: "legacy_post_bulk_follow_up" } });
    for (const id of f.collections) expect(f.providers.get(id)!.source).toMatchObject({ state: "active", migration_id: null });
    expect(await events(f.account, "next_migration.managed_route_back")).toHaveLength(1);
    expect(await events(f.account, "next_migration.unfence")).toHaveLength(2);
    expect(f.worker.run).not.toHaveBeenCalled(); expect(f.worker.rollback).not.toHaveBeenCalled();
  });

  it("an intent with no visible run stays UNKNOWN: no target re-entry, no dispatch and no route-back mutation", async () => {
    const f = await fixture(), [first, second] = f.collections;
    f.faults.set(second!, "absent");
    expect(await run(f)).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_missing", collection_id: second } });
    expect(f.prepareTarget).toHaveBeenCalledTimes(2); expect(f.worker.run).toHaveBeenCalledTimes(2);
    f.faults.delete(second!); // Even a Worker that would now accept a dispatch is never asked.
    expect(await run(f)).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_outcome_unknown", collection_id: second, phase: "prepare" } });
    expect(f.prepareTarget).toHaveBeenCalledTimes(2); expect(f.worker.run).toHaveBeenCalledTimes(2);
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "worker_run_outcome_unknown", collection_id: second } });
    expect(f.worker.rollback).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled();
    expect(f.runs.get(first!)!.reason).toBe(PAUSE_REASON);
    const status = await labStatus(f.account, f.deps);
    expect(status).toMatchObject({ intents: f.collections, collections: [
      { collection_id: first, intent: true, worker: { run: { reason: PAUSE_REASON } } },
      { collection_id: second, intent: true, worker: { run: null } }] });
  });

  /** Wait until a request blocks on a row lock (the account lock another transaction holds). */
  const blocked = async (fragment: string) => {
    for (let i = 0; i < 300; i++) {
      if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1", [`%${fragment}%`])).rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("The request never waited on the account lock.");
  };
  const ageIntent = (f: Fixture, id: string, seconds: number) => db.query(`UPDATE audit_events SET created_at=now()-make_interval(secs => $3)
    WHERE user_id=$1 AND subject_id=$2 AND event_type='next_migration.worker_run_intent'`, [f.account, id, seconds]);

  it("a runless intent past the 420 s quiet period routes back as never dispatched; the original run's late fence then refuses", async () => {
    const f = await fixture(), [first, second] = f.collections;
    f.faults.set(second!, "absent");
    expect(await run(f)).toMatchObject({ stopped: { step: "worker_run", reason: "worker_run_missing", collection_id: second } });
    await ageIntent(f, second!, 419); // Database clock, not the driver's.
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "worker_run_outcome_unknown", collection_id: second } });
    expect(await events(f.account, "next_migration.managed_route_back")).toHaveLength(0);
    await ageIntent(f, second!, 421);
    expect(await routeBack(f.account, f.deps)).toMatchObject({ done: { not_dispatched: [second], disposition: "legacy_post_bulk_follow_up",
      collections: [{ collection_id: first, rolled_back: true }, { collection_id: second, not_dispatched: true, legacy_verified: true }] } });
    for (const id of f.collections) expect(f.providers.get(id)!.source).toMatchObject({ state: "active", migration_id: null, started_at: null });
    // The original dispatch arrives late: its first forward effect refuses before any provider call.
    f.faults.delete(second!);
    const late = await f.cp("POST", second!, "fence");
    expect(late.statusCode).toBe(409); expect(late.json().error.code).toBe("managed_route_back_started");
    expect(f.provider.legacyMigrationFence).not.toHaveBeenCalled(); expect(await events(f.account, "next_migration.fence")).toHaveLength(1);
    expect(await backend(f.account)).toBe("legacy"); expect(await cutOvers(f.account)).toBe(0);
  });

  it("the CP fence rechecks the route-back latch after the account lock it waited on; reads and the canonical unfence stay open", async () => {
    const f = await fixture(), [first] = f.collections;
    await f.connect.bindRun!(f.account, f.collections, hold, true);
    const holder = await db.connect();
    try {
      await holder.query("BEGIN"); await holder.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [f.account]);
      const fence = f.cp("POST", first!, "fence");
      await blocked("FOR SHARE OF h,u,m");
      await latchPhase(holder, f.account, "route_back", (await readManagedRun(holder, f.account))!);
      await holder.query("COMMIT");
      const reply = await fence;
      expect(reply.statusCode).toBe(409); expect(reply.json().error.code).toBe("managed_route_back_started");
    } finally { holder.release(); }
    expect(await events(f.account, "next_migration.fence")).toHaveLength(0);
    expect((await f.cp("GET", first!, "source")).statusCode).toBe(200);
    const current = await claim(db, first!);
    const unfence = await f.cp("POST", first!, "unfence", { owner_account: current.account, started_us: current.started_us,
      migration_id: f.providers.get(first!)!.source.migration_id });
    expect(unfence.statusCode, unfence.body).toBe(200);
    expect(f.providers.get(first!)!.source).toMatchObject({ state: "active", migration_id: null });
  });

  it("the cutover latch rechecks the held set after the account lock it waited on, naming the collection and predicate", async () => {
    const f = await fixture(), [, second] = f.collections;
    await f.connect.bindRun!(f.account, f.collections, hold, true);
    const holder = await db.connect();
    let latched: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN"); await holder.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [f.account]);
      latched = f.connect.latchPhase!(f.account, "cutover").then(() => "latched", (error: unknown) => error);
      await blocked("FOR NO KEY UPDATE");
      await holder.query("UPDATE hosted_collections SET quarantined_at=now() WHERE id=$1", [second]);
      await holder.query("COMMIT");
    } finally { holder.release(); }
    expect(await latched).toMatchObject({ code: "collections_unsettled", details: { unsettled: [{ collection_id: second, predicate: "quarantined" }] } });
    expect(await events(f.account, "next_migration.managed_cutover")).toHaveLength(0);
  });

  it.each(["lab-run", "resume"] as const)("a phase 2 interruption only moves forward through %s: one flip, no new dispatch, no rollback", async entry => {
    const f = await fixture(), [first, second] = f.collections, cutover = f.connect.cutover.bind(f.connect); let failed = false;
    f.connect.cutover = async id => {
      if (id === second && !failed) { failed = true; throw Object.assign(new Error("Synthetic provider loss"), { code: "migration_source_unavailable" }); }
      return cutover(id);
    };
    expect(await run(f)).toMatchObject({ stopped: { step: "cutover", reason: "migration_source_unavailable", phase: "cutover",
      collection_id: second, resume: `${CLI} resume ${f.account}` } });
    expect(f.providers.get(first!)!.source.state).toBe("migrated"); expect(await backend(f.account)).toBe("legacy");
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { step: "preflight", reason: "managed_cutover_started" } });
    expect(f.worker.rollback).not.toHaveBeenCalled();
    expect(await (entry === "resume" ? resumeLab(f.account, f.deps) : run(f))).toHaveProperty("done.migration_complete", true);
    expect(f.order).toEqual(twoPhaseOrder(f.collections)); expect(f.worker.run).toHaveBeenCalledTimes(2);
    expect(f.worker.resume).toHaveBeenCalledTimes(2); expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
    const original = (await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [f.cohort])).rows[0].verified_result;
    expect(original).toEqual(f.archive); // Original source context survives partial cutover.
  });

  it("a lost resume reply is reconciled from status on the next run, never re-sent", async () => {
    const f = await fixture(), second = f.collections[1]!;
    f.faults.set(second, "lost_resume_reply");
    expect(await run(f)).toMatchObject({ stopped: { step: "resume", reason: "operator_outcome_unknown:worker_unreachable", collection_id: second, phase: "cutover" } });
    expect(await run(f)).toHaveProperty("done.migration_complete", true);
    expect(f.worker.resume).toHaveBeenCalledTimes(2); expect(f.order).toEqual(twoPhaseOrder(f.collections));
  });

  it("a first resume that has not arrived yet makes the account forward only; its late arrival completes the set", async () => {
    const f = await fixture(), [first] = f.collections;
    f.faults.set(first!, "delayed_resume");
    expect(await run(f)).toMatchObject({ stopped: { step: "resume", reason: "operator_outcome_unknown:worker_unreachable",
      collection_id: first, phase: "cutover", resume: `${CLI} resume ${f.account}` } });
    // Nothing is resumed or cut over anywhere, yet route-back never treats the unknown resume as absent.
    expect(f.collections.map(id => f.runs.get(id)!.reason)).toEqual([PAUSE_REASON, PAUSE_REASON]); expect(await cutOvers(f.account)).toBe(0);
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { step: "preflight", reason: "managed_cutover_started", resume: `${CLI} resume ${f.account}` } });
    expect(f.worker.rollback).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled();
    expect(await events(f.account, "next_migration.managed_route_back")).toHaveLength(0);
    expect(await labStatus(f.account, f.deps)).toMatchObject({ phase_latch: "cutover" });
    expect(await f.delayed.shift()!()).toMatchObject({ kind: "ok" }); // The original request arrives after the checks.
    expect(await run(f)).toHaveProperty("done.migration_complete", true);
    expect(f.order).toEqual(twoPhaseOrder(f.collections)); expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
  });

  it("route-back that passed its inspection loses to a phase 2 latch committed meanwhile, before any rollback", async () => {
    const f = await fixture(), status = f.worker.status.bind(f.worker); let raced = false;
    expect(await labRun(f.account, hold, f.deps, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    f.worker.status = vi.fn(async id => {
      const reply = await status(id);
      // A concurrent resume command commits its latch while route-back inspects the last member.
      if (id === f.collections[1] && !raced) { raced = true; await f.connect.latchPhase!(f.account, "cutover"); }
      return reply;
    });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { step: "preflight", reason: "managed_cutover_started" } });
    expect(f.worker.rollback).not.toHaveBeenCalled(); expect(f.provider.legacyMigrationRollback).not.toHaveBeenCalled();
    expect(await events(f.account, "next_migration.managed_route_back")).toHaveLength(0);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done.migration_complete", true);
    expect(f.order).toEqual(twoPhaseOrder(f.collections));
  });

  it("phase 2 that read no latch loses to a route-back latch committed meanwhile and sends no resume", async () => {
    const f = await fixture(), preflight = f.connect.preflight.bind(f.connect);
    expect(await labRun(f.account, hold, f.deps, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    f.connect.preflight = async (account, options) => {
      const pre = await preflight(account, options);
      await f.connect.latchPhase!(account, "route_back"); // Committed after this resume's preflight read.
      return pre;
    };
    expect(await resumeLab(f.account, f.deps)).toMatchObject({ stopped: { step: "cutover_latch", reason: "managed_route_back_started",
      resume: `${CLI} route-back ${f.account}` } });
    expect(f.worker.resume).not.toHaveBeenCalled(); expect(await events(f.account, "next_migration.managed_cutover")).toHaveLength(0);
    f.connect.preflight = preflight;
    expect(await routeBack(f.account, f.deps)).toHaveProperty("done.disposition", "legacy_post_bulk_follow_up");
    expect(f.order.filter(e => e.startsWith("rollback:"))).toEqual(f.collections.map(id => `rollback:${id}`));
  });

  it("the two latches exclude each other under the account lock; each is idempotent", async () => {
    const f = await fixture();
    expect(await labRun(f.account, hold, f.deps, true)).toHaveProperty("stopped.reason", PAUSE_REASON);
    const blocker = await db.connect();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [f.account]);
      const both = Promise.allSettled([f.connect.latchPhase!(f.account, "route_back"), f.connect.latchPhase!(f.account, "cutover")]);
      await new Promise(resolve => setTimeout(resolve, 200)); // Both now wait on the same account lock.
      await blocker.query("COMMIT");
      const settled = await both, won = settled.findIndex(r => r.status === "fulfilled");
      expect(settled.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const winner = won === 0 ? "route_back" : "cutover", loser = settled[1 - won] as PromiseRejectedResult;
      expect(loser.reason).toHaveProperty("code", `managed_${winner}_started`);
      await f.connect.latchPhase!(f.account, winner); // Idempotent.
      await expect(f.connect.latchPhase!(f.account, winner === "cutover" ? "route_back" : "cutover")).rejects.toHaveProperty("code", `managed_${winner}_started`);
      const recorded = await db.query("SELECT event_type FROM audit_events WHERE user_id=$1 AND event_type IN ('next_migration.managed_cutover','next_migration.managed_route_back')", [f.account]);
      expect(recorded.rows).toEqual([{ event_type: `next_migration.managed_${winner}` }]);
    } finally { blocker.release(); }
  });

  it("a Worker stop at cutover intent after a sibling cut over is forward only: route-back refuses and nothing rolls back", async () => {
    const f = await fixture(), [first, second] = f.collections;
    f.faults.set(second!, "stop_cutover");
    expect(await run(f)).toMatchObject({ stopped: { step: "worker_status", reason: "settlement_unknown", phase: "cutover",
      collection_id: second, resume: `${CLI} resume ${f.account}` } });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { step: "preflight", reason: "managed_cutover_started" } });
    expect(f.worker.rollback).not.toHaveBeenCalled(); expect(f.worker.resolve).not.toHaveBeenCalled();
    expect(f.providers.get(first!)!.source.state).toBe("migrated"); expect(f.providers.get(second!)!.source.state).toBe("migrating");
    // Settling the outstanding forward action needs a Worker operation the driver does not have.
    expect(await resumeLab(f.account, f.deps)).toMatchObject({ stopped: { reason: "settlement_unknown", collection_id: second } });
    expect(await backend(f.account)).toBe("legacy"); expect(await events(f.account, "next_migration.flip")).toHaveLength(0);
    // The flip still admits only the complete distinct set.
    await expect(f.connect.flip(f.account, [first!])).rejects.toHaveProperty("code", "collections_mismatch");
    await expect(f.connect.flip(f.account, [first!, first!])).rejects.toHaveProperty("code", "collections_duplicated");
  });

  it("an unversioned managed binding fails closed in every command; status still lists the set", async () => {
    const f = await fixture(), member = (await db.query<{ us: string }>(
      "SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS us FROM next_migration_cohort_members WHERE account_id=$1", [f.account])).rows[0]!;
    await db.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata) VALUES($1,$2,'next_migration.managed_run',$3,$4::jsonb)",
      [randomUUID(), f.account, f.account, JSON.stringify({ collections: f.collections, backup_hold: hold, stop_before_flip: false, started_us: member.us })]);
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "managed_run_legacy_binding" } });
    expect(await resumeLab(f.account, f.deps)).toMatchObject({ stopped: { reason: "managed_run_legacy_binding" } });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "managed_run_legacy_binding" } });
    await expect(f.connect.bindRun!(f.account, f.collections, hold, false)).rejects.toHaveProperty("code", "managed_run_legacy_binding");
    await expect(f.connect.claimWorkerRun!(f.account, f.collections[0]!)).rejects.toHaveProperty("code", "managed_run_legacy_binding");
    expect(await labStatus(f.account, f.deps)).toMatchObject({ refusal: { code: "managed_run_legacy_binding" }, run: null,
      collections: f.collections.map(collection_id => ({ collection_id, intent: false, worker: { run: null } })) });
    expect(f.worker.run).not.toHaveBeenCalled(); expect(await events(f.account, "next_migration.worker_run_intent")).toHaveLength(0);
  });

  it("an unsettled member refuses with bounded details; status reports them and the set", async () => {
    const f = await fixture(), second = f.collections[1]!;
    await db.query("UPDATE hosted_collections SET quarantined_at=now(),quarantine_reason=NULL WHERE id=$1", [second]);
    const details = { unsettled: [{ collection_id: second, predicate: "quarantined" }] };
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "collections_unsettled", details } });
    expect(await labStatus(f.account, f.deps)).toMatchObject({ refusal: { code: "collections_unsettled", details }, collection_ids: f.collections });
    expect(f.worker.run).not.toHaveBeenCalled();
  });

  it("bindRun's account lock admits a hosted writer's foreign-key check instead of deadlocking", async () => {
    const f = await fixture(), hosted = await db.connect();
    try {
      await hosted.query("BEGIN");
      const pid = (await hosted.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      // A hosted writer locks its row first (e.g. hosted approval), then writes an FK row.
      await hosted.query("SELECT 1 FROM hosted_collections WHERE id=$1 FOR UPDATE", [f.collections[0]]);
      const bound = f.connect.bindRun!(f.account, f.collections, hold, false);
      for (let i = 0; ; i++) {
        const waiting = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rows[0]!.n;
        if (waiting) break;
        if (i > 400) throw new Error("bindRun never waited on the hosted row");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await hosted.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata) VALUES($1,$2,'synthetic.hosted_write',$3,'{}'::jsonb)",
        [randomUUID(), f.account, f.collections[0]]);
      await hosted.query("COMMIT");
      await bound;
    } finally { hosted.release(); }
    expect(await events(f.account, "next_migration.managed_run")).toHaveLength(1);
  });

  it("one LAB adapter independently selects fixture and ordinary account contracts under concurrent calls", async () => {
    const ordinary = await fixture(2, 1, "lab"), singleton = await fixture(1, 0, "lab", "fixture");
    const shared = postgresLabConnect({ db, source, actor, timers: true, environment: "lab", provider: ordinary.provider });
    const [managed, lab] = await Promise.all([shared.preflight(ordinary.account), shared.preflight(singleton.account)]);
    expect(managed).toMatchObject({ job: "managed", collections: ordinary.collections });
    expect(lab).toEqual({ collection: singleton.collections[0], backend: "legacy" });
    const outcomes = await Promise.allSettled([
      shared.bindRun!(ordinary.account, ordinary.collections, hold, false),
      shared.bindRun!(singleton.account, singleton.collections, hold, false)
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "start_profile_invalid" } });
    expect(await shared.claimWorkerRun!(ordinary.account, ordinary.collections[0]!)).toBe(true);
    await expect(shared.claimWorkerRun!(singleton.account, singleton.collections[0]!)).rejects.toHaveProperty("code", "start_profile_invalid");
    expect(await events(singleton.account, "next_migration.managed_run")).toHaveLength(0);
    // The fixture keeps its singleton output and its non-pause Worker run.
    expect(await labRun(singleton.account, hold, singleton.deps)).toEqual({ done: {
      account_id: singleton.account, collection_id: singleton.collections[0], backend: "next", lab_complete: true
    } });
    expect(singleton.worker.run).toHaveBeenCalledWith(singleton.collections[0], hold, false);
  });

  it("the recorded fixture contract still refuses a second held member", async () => {
    const f = await fixture(1, 0, "lab", "fixture");
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Synthetic drift','mdbase')", [randomUUID(), f.account]);
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "lab_inventory_invalid" } });
    expect(f.worker.run).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate-ordinary", "duplicate-fixture", "unknown", "null", "foreign-subject", "foreign-owner"])("refuses %s recorded start evidence", async kind => {
    const f = await fixture(2, 0, "lab");
    if (kind === "missing") await db.query("DELETE FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'", [f.account]);
    if (kind.startsWith("duplicate")) await db.query(`INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata)
      SELECT $2,user_id,event_type,subject_id,$3::jsonb FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'`,
      [f.account, randomUUID(), JSON.stringify(kind === "duplicate-fixture" ? { profile: "lab-fixture-v1" } : {})]);
    if (kind === "unknown" || kind === "null") await db.query("UPDATE audit_events SET metadata=metadata||$2::jsonb WHERE user_id=$1 AND event_type='next_migration.start'",
      [f.account, JSON.stringify({ profile: kind === "unknown" ? "future-profile" : null })]);
    if (kind === "foreign-subject") await db.query("UPDATE audit_events SET subject_id=$2 WHERE user_id=$1 AND event_type='next_migration.start'", [f.account, randomUUID()]);
    if (kind === "foreign-owner") {
      const owner = randomUUID(); await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic other')", [owner, `${owner}@example.test`]);
      await db.query("UPDATE audit_events SET user_id=$2 WHERE user_id=$1 AND event_type='next_migration.start'", [f.account, owner]);
    }
    expect(await run(f)).toMatchObject({ stopped: { step: "preflight", reason: "start_profile_invalid" } });
    expect(f.worker.run).not.toHaveBeenCalled(); expect(await events(f.account, "next_migration.managed_run")).toHaveLength(0);
  });

  it.each(["staging", "production"] as const)("%s refuses even a single fixture marker in every managed admission", async environment => {
    const f = await fixture(1, 0, environment);
    await db.query("UPDATE audit_events SET metadata=metadata||'{\"profile\":\"lab-fixture-v1\"}'::jsonb WHERE user_id=$1 AND event_type='next_migration.start'", [f.account]);
    expect(await run(f)).toHaveProperty("stopped.reason", "start_profile_invalid");
    await expect(f.connect.bindRun!(f.account, f.collections, hold, false)).rejects.toHaveProperty("code", "start_profile_invalid");
    await expect(f.connect.claimWorkerRun!(f.account, f.collections[0]!)).rejects.toHaveProperty("code", "start_profile_invalid");
    expect(f.worker.run).not.toHaveBeenCalled();
  });

  it("bind and claim revalidate recorded contracts inside their account transactions", async () => {
    const f = await fixture(1, 0, "lab");
    expect(await f.connect.preflight(f.account)).toHaveProperty("job", "managed");
    await db.query("UPDATE audit_events SET metadata=metadata||'{\"profile\":\"lab-fixture-v1\"}'::jsonb WHERE user_id=$1 AND event_type='next_migration.start'", [f.account]);
    await expect(f.connect.bindRun!(f.account, f.collections, hold, false)).rejects.toHaveProperty("code", "start_profile_invalid");
    expect(await events(f.account, "next_migration.managed_run")).toHaveLength(0);
    await db.query("UPDATE audit_events SET metadata=metadata-'profile' WHERE user_id=$1 AND event_type='next_migration.start'", [f.account]);
    await f.connect.bindRun!(f.account, f.collections, hold, false);
    await db.query(`INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata)
      SELECT $2,user_id,event_type,subject_id,metadata FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'`, [f.account, randomUUID()]);
    await expect(f.connect.claimWorkerRun!(f.account, f.collections[0]!)).rejects.toHaveProperty("code", "start_profile_invalid");
    expect(await events(f.account, "next_migration.worker_run_intent")).toHaveLength(0);
  });

  it("ordinary LAB completion requires an accepted archive, never the fixture completion fallback", async () => {
    const f = await fixture(2, 1, "lab");
    // Acceptances are immutable: model a coverage revision with no accepted archive landing just before the flip.
    const connect = { ...f.connect, flip: async (account: string, collections: string | readonly string[]) => {
      await db.query("UPDATE next_migration_cohorts SET membership_revision=membership_revision+1 WHERE name=$1", [f.cohort]);
      return f.connect.flip(account, collections);
    } };
    expect(await labRun(f.account, hold, { ...f.deps, connect })).toMatchObject({ stopped: { step: "verify_completion", reason: "lab_completion_missing" } });
    expect(await backend(f.account)).toBe("next");
    expect((await db.query("SELECT completed_at FROM next_migration_cohorts WHERE name=$1", [f.cohort])).rows[0].completed_at).toBeNull();
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.lab_complete' AND subject_id=$1", [f.cohort])).rows).toHaveLength(0);
    // A forged, otherwise well-formed LAB completion still cannot complete an ordinary start.
    const binding = await cohortArchiveBinding(db, f.cohort);
    await db.query("UPDATE next_migration_cohorts SET completed_at=clock_timestamp(),completed_revision=$2::bigint WHERE name=$1", [f.cohort, binding.membership_revision]);
    await db.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata) VALUES($1,NULL,'next_migration.lab_complete',$2,$3::jsonb)",
      [randomUUID(), f.cohort, JSON.stringify({ cohort: f.cohort, membership_revision: binding.membership_revision, membership_digest: binding.membership_digest })]);
    expect(await run(f)).toMatchObject({ stopped: { step: "verify_completion", reason: "lab_completion_missing" } });
    expect(f.worker.run).toHaveBeenCalledTimes(2);
    // Control: only a bound fixture start would make that same forged completion pass the readback.
    await db.query(`UPDATE audit_events SET metadata=metadata||jsonb_build_object('profile','lab-fixture-v1','inventory',$2::jsonb)
      WHERE user_id=$1 AND event_type='next_migration.start'`, [f.account, JSON.stringify(binding)]);
    await requireCompletedAccountMigration(db, f.collections[0]!, f.account, { suspendedOwner: true });
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
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "worker_run_outcome_unknown", collection_id: f.collections[0] } });
  });

  it("rejects subset, duplicate, changed hold, changed pause intent and changed held-set bindings", async () => {
    const f = await fixture();
    await expect(f.connect.bindRun!(f.account, [f.collections[0]!], hold, false)).rejects.toHaveProperty("code", "collections_mismatch");
    await expect(f.connect.bindRun!(f.account, [f.collections[0]!, f.collections[0]!], hold, false)).rejects.toHaveProperty("code", "collections_mismatch");
    f.faults.set(f.collections[1]!, "stop_prepare"); await run(f);
    expect(await labRun(f.account, randomUUID(), f.deps)).toMatchObject({ stopped: { reason: "managed_run_conflict" } });
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { reason: "managed_run_conflict" } });
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
    expect(imports).toHaveLength(6);
    expect(imports.slice(4).map(e => e.metadata.collection_id)).toEqual(f.collections);
    expect(await events(f.account, "next_migration.flip")).toHaveLength(1);
  });

  it.each([["staging", 16], ["staging", 17], ["lab", 16], ["lab", 17]] as const)("%s %i-member boundary is enforced through the real adapter", async (environment, count) => {
    const f = await fixture(count, 0, environment), result = await run(f);
    if (count === 16) {
      expect(result).toHaveProperty("done.migration_complete", true); expect(f.worker.run).toHaveBeenCalledTimes(16);
      expect(f.order).toEqual(twoPhaseOrder(f.collections));
      expect(await events(f.account, "next_migration.timers_imported")).toHaveLength(32);
    } else {
      expect(result).toMatchObject({ stopped: { step: "preflight", reason: "managed_inventory_over_cap" } });
      expect(f.worker.run).not.toHaveBeenCalled(); expect(await backend(f.account)).toBe("legacy");
    }
  });
});
