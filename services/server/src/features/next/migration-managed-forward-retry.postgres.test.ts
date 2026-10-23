// G4: real CP adapter/SQL, synthetic scoped archive and timer-free providers.
// Worker status is READ ONLY: only run/resume execute a modeled Worker action.
// The separate executor regression uses the existing ledger-faithful native fake;
// neither suite claims real Native/Worker deployment qualification.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Route-only executor coverage never opens legacy I/O. Exclude those unused
// adapters (and their deployment-only dependencies) from this hermetic test.
vi.mock("../../../../../runtime/deploy/hosted-worker/src/legacy-source/bindings.ts", () => ({ LegacyBindingError: class extends Error {} }));
vi.mock("../../../../../runtime/deploy/hosted-worker/src/legacy-source/source.ts", () => ({ LegacySourceError: class extends Error {} }));
import { createDatabase, type DatabasePool } from "../../db.js";
import { fakeLegacyProvider, recordEmptyTimerImport } from "./legacy-provider.test-helper.js";
import { labRun, postgresLabConnect, resumeLab, routeBack, PAUSE_REASON, STEP,
  type LabWorker, type WorkerReply, type WorkerStatus } from "./migration-lab.js";
import { acceptCohortArchive, addToCohort, createCohort, cutOverCollection, readCohortCaptureSnapshot,
  releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";
import { inTransaction } from "./bootstrap-common.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { registerNextCollection } from "./policy-outbox.js";
import { MigrationExecutor } from "../../../../../runtime/deploy/hosted-worker/src/migration-executor.js";
import { newRun } from "../../../../../runtime/deploy/hosted-worker/src/migration-run.js";
import { FakeNative, mapStore, providerPlan, HOLD } from "../../../../../runtime/deploy/hosted-worker/test/fixtures/migration-fake-native.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const postgres = testUrl && approved ? describe : describe.skip;
const actor = "g4-owned-forward-retry", hold = "30000000-0000-4000-8000-000000000003";
const ok = (status: WorkerStatus): WorkerReply => ({ kind: "ok", status });
const failure = (code: string) => Object.assign(new Error(code), { code });
const facts = { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) };

postgres("G4 original-attempt operator retry through canonical CP steps", () => {
  let admin: pg.Pool, db: DatabasePool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname))
      throw new Error("Explicit owned loopback test PostgreSQL required");
    schema = `g4_forward_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await setPaused(db, false, "synthetic G4", actor);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  async function fixture(fault: "confirm_once" | "lost_confirm" | "permanent" | "timer_import" | "no_manifest" | "lost_worker_route") {
    const account = randomUUID(), collections: string[] = [randomUUID(), randomUUID()].sort(), cohort = `g4-${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic G4')", [account, `${account}@example.test`]);
    for (const id of collections) await db.query(`INSERT INTO hosted_collections
      (id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'G4','mdbase','https://provider.example','active')`, [id, account]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [account], actor);
    await releaseCohort(db, cohort, actor); await setCohortFrozen(db, cohort, true, "synthetic G4", actor);
    const capture = await inTransaction(db, c => readCohortCaptureSnapshot(c, cohort));
    const inventory = prearchiveInventory(capture);
    const clock = (await db.query<{ now: Date }>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0]!.now;
    const providers = new Map(collections.map(id => [id, fakeLegacyProvider(id, { started_at: new Date(clock.getTime() - 1000).toISOString() })]));
    await acceptCohortArchive(db, cohort, {
      schema: "mdbase-recovery-set/scoped-hosted-v1", environment: "staging", bucket: "synthetic-g4",
      prefix: `legacy-archive/staging/2026/10/23/${cohort}`, backup_id: cohort,
      complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "c".repeat(40),
      migration_batch: capture.binding, archive_created_at: clock.toISOString(), archive_completed_at: clock.toISOString(),
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(clock.getTime() + 116 * 86400000).toISOString(), inventory_digest: "d".repeat(64), count: "5" },
      scoped_recovery: { inventory_sha256: inventory.inventory_sha256,
        selection_sha256: createHash("sha256").update("mdbase-scoped-archive-selection/v1\n")
          .update(JSON.stringify(inventory.selected.map(v => [v.account_id, v.collection_id]))).digest("hex"),
        source_rows_sha256: "e".repeat(64), recovered_inventory_sha256: "f".repeat(64), original_h6_journal_sha256: "1".repeat(64),
        source_fences: collections.map(collection_id => ({ account_id: account, collection_id,
          migration_id: providers.get(collection_id)!.source.migration_id, started_at: providers.get(collection_id)!.source.started_at,
          head: 42, in_flight: 0, unresolved: 0, applied_unreceipted: 0, notification_watermark: providers.get(collection_id)!.watermark,
          fence_reply_sha256: "2".repeat(64), drain_reply_sha256: "3".repeat(64) })) }
    }, "staging");
    await startAccountMigration(db, account, "staging");
    const order: string[] = [], confirmations: string[] = [], imports: string[] = [], dispatches: unknown[][] = [], resumes: unknown[][] = [];
    let importUnavailable = fault === "timer_import";
    const events: string[] = [];
    const unused = async (): Promise<never> => { throw new Error("No rollback/restart/resolve in G4"); };
    const provider = {
      legacyMigrationDrain: (id: string, options: { deadline?: number }) => providers.get(id)!.legacyMigrationDrain(id, options),
      legacyMigrationRetain: (id: string, until: Date, options: { deadline?: number }) => providers.get(id)!.legacyMigrationRetain(id, until, options),
      legacyMigrationSource: (id: string, options: { deadline?: number }) => providers.get(id)!.legacyMigrationSource(id, options)
    };
    const connect = postgresLabConnect({ db, source: db, actor, timers: true, environment: "staging", provider,
      prepareTarget: async id => {
        await registerNextCollection(db, { collectionId: id, ownerUserId: account, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16, 17),
          ops: [{ op: "genesis", owner: account, root: Buffer.alloc(16, 17), state: "cloud-copy" }, { op: "member-set", account, role: "owner" }] });
      },
      // Timer-free fixture; the canonical flip still checks the bound manifest
      // against every current source. Import replay must preserve that binding.
      importTimers: async id => {
        events.push(`import:${id}`);
        if (id === collections[1] && importUnavailable) throw failure("timer_grant_unbound");
        imports.push(id); await recordEmptyTimerImport(db, account, providers.get(id)!.source, providers.get(id)!.watermark);
      }
    });
    const canonicalConfirm = connect.cutover.bind(connect), canonicalFlip = connect.flip.bind(connect);
    const canonicalLatch = connect.latchPhase!.bind(connect);
    connect.latchPhase = async (owner, phase) => { events.push(`latch:${phase}`); await canonicalLatch(owner, phase); };
    let failed = false, flipCalls = 0;
    connect.cutover = async id => {
      confirmations.push(id);
      if (id === collections[1] && (["permanent", "confirm_once", "lost_confirm", "lost_worker_route"].includes(fault)) && (fault === "permanent" || !failed)) {
        failed = true;
        if (fault === "lost_confirm") await canonicalConfirm(id); // commit succeeded, reply lost
        throw failure(fault === "permanent" ? "migration_source_changed" : fault === "lost_confirm" ? "migration_source_unavailable" : "legacy_retention_pending");
      }
      await canonicalConfirm(id);
    };
    connect.flip = async (owner, ids) => {
      flipCalls++;
      expect(ids).toEqual(collections);
      expect((await db.query("SELECT collection_id::text FROM next_migration_collections WHERE account_id=$1 ORDER BY collection_id", [account])).rows.map(r => r.collection_id)).toEqual(collections);
      expect(collections.every(id => imports.includes(id) && providers.get(id)!.source.state === "migrated")).toBe(true);
      await canonicalFlip(owner, ids);
    };
    const runs = new Map<string, WorkerStatus>();
    const worker: LabWorker = {
      async run(id, backupHold, pause) {
        dispatches.push([id, backupHold, pause]);
        expect(runs.has(id)).toBe(false); expect(pause).toBe(true);
        const status: WorkerStatus = { run: { state: "stopped", reason: PAUSE_REASON, backup_hold: backupHold,
          migration_id: providers.get(id)!.source.migration_id!, stop_before_flip: true, resumed_run_sequence: null },
          native: { run_sequence: 1, checkpoint: { step: STEP.verified, fenced: true }, outstanding: null } };
        runs.set(id, status); order.push(`pause:${id}`); return ok(structuredClone(status));
      },
      async status(id) { // No advancement, recovery, or effects on a read.
        return ok(structuredClone(runs.get(id) ?? { run: null, native: { run_sequence: null, checkpoint: null, outstanding: null } }));
      },
      async resume(id, sequence) {
        resumes.push([id, sequence]);
        expect(sequence).toBe(1);
        events.push(`resume:${id}`);
        expect(collections.every(c => order.includes(`pause:${c}`))).toBe(true);
        const status = runs.get(id)!;
        expect(status.run!.resumed_run_sequence).toBeNull();
        // A real executor fault, not a status script: C2's canonical Route
        // commits but loses its reply. Keep exactly the resulting run/ledger.
        if (fault === "lost_worker_route" && id === collections[1]) {
          const saved = mapStore();
          saved.saved = { index: 0, seq: 10, step: 12, fenced: true, attempts: 0, baseSeq: 21, revoked: [], outstanding: null, idleUsed: 0 };
          const native = new FakeNative([{ kind: 19, fields: [7, 11, 13, new Uint8Array(32).fill(0xee)], step: STEP.routed, settle: "provider", provider: "cutover" }], saved, {}, id);
          native.owner = account;
          let run = newRun(id, hold, 1, true), calls = 0;
          run.resumeRunSequence = sequence; run.membersBase = true;
          const executor = new MigrationExecutor({ collection: id, host: native,
            store: { load: async () => structuredClone(run), save: async value => { run = structuredClone(value); } },
            connect: () => ({ cutover: async () => {
              await cutOverCollection(db, provider, id, facts);
              if (++calls === 1) throw new TypeError("synthetic lost canonical Route response");
              return { status: 200, code: null, body: { collection_id: id, account_id: account } };
            } }) as unknown as ReturnType<ConstructorParameters<typeof MigrationExecutor>[0]["connect"]>,
            source: unused, sleep: async () => undefined, now: () => 1
          });
          await executor.wake(new AbortController().signal, { actions: 8, ms: 10_000 });
          status.run = { ...status.run!, state: run.state, reason: run.reason, resumed_run_sequence: run.resumeRunSequence };
          status.native = { run_sequence: 1, checkpoint: { step: saved.saved!.step, fenced: true },
            outstanding: saved.saved!.outstanding && { sequence: saved.saved!.outstanding.seq, kind: saved.saved!.outstanding.kind } };
          return ok(structuredClone(status));
        }
        // Modeled original Worker Route; canonical handler supplies idempotence.
        await cutOverCollection(db, provider, id, facts);
        status.run = { ...status.run!, state: "done", reason: null, resumed_run_sequence: sequence };
        status.native = { run_sequence: sequence, checkpoint: { step: STEP.routed, fenced: true }, outstanding: null };
        order.push(`cutover:${id}`); return ok(structuredClone(status));
      },
      rollback: unused, restart: unused, resolve: unused
    };
    const deps = { worker, connect, sleep: async () => undefined };
    const snapshot = async () => ({
      backend: (await db.query("SELECT account_backend FROM users WHERE id=$1", [account])).rows[0].account_backend,
      cutovers: (await db.query("SELECT collection_id::text,cutover_at FROM next_migration_collections WHERE account_id=$1 ORDER BY collection_id", [account])).rows,
      run: (await connect.preflight(account))
    });
    const pauseWithoutManifest = async () => {
      await connect.bindRun!(account, collections, hold, true);
      for (const id of collections) {
        await connect.prepareTarget(id); expect(await connect.claimWorkerRun!(account, id)).toBe(true);
        await worker.run(id, hold, true);
      }
    };
    return { account, collections, providers, order, confirmations, imports, dispatches, resumes, deps, snapshot, events,
      pauseWithoutManifest, repairImport: () => { importUnavailable = false; }, flips: () => flipCalls };
  }

  it.each(["confirm_once", "lost_confirm"] as const)("%s: real SAME lab-run/resume repeats existing steps, then one combined flip", async fault => {
    const f = await fixture(fault), [c1, c2] = f.collections;
    expect(await labRun(f.account, hold, f.deps)).toMatchObject({ stopped: { step: "cutover", phase: "cutover", collection_id: c2 } });
    const before = await f.snapshot();
    expect(before.backend).toBe("legacy"); expect(before.cutovers).toHaveLength(2); expect(f.flips()).toBe(0);
    expect(f.order).toEqual([`pause:${c1}`, `pause:${c2}`, `cutover:${c1}`, `cutover:${c2}`]);
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "managed_cutover_started" } });
    // Reissue the actual operator command, never clear a fault or rewrite status.
    const retried = fault === "confirm_once" ? await labRun(f.account, hold, f.deps) : await resumeLab(f.account, f.deps);
    expect(retried).toHaveProperty("done");
    const after = await f.snapshot();
    expect(after.backend).toBe("next"); expect(after.cutovers).toEqual(before.cutovers);
    expect(after.run).toMatchObject({ run: before.run && "run" in before.run ? before.run.run : null, phase_latch: "cutover" });
    expect(f.dispatches).toEqual(f.collections.map(id => [id, hold, true]));
    expect(f.resumes).toEqual(f.collections.map(id => [id, 1]));
    expect(f.confirmations).toEqual([c1, c2, c1, c2]);
    expect(f.imports).toEqual([c1, c2, c1, c2, c1, c2]);
    expect(f.flips()).toBe(1);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done"); expect(f.flips()).toBe(1);
  });

  it("G4: actual C2 executor loses Route response after C1 cutover; SAME operator retry must converge", async () => {
    const f = await fixture("lost_worker_route");
    await labRun(f.account, hold, f.deps);
    const before = await f.snapshot();
    expect(before.cutovers).toHaveLength(2); expect(before.backend).toBe("legacy"); expect(f.flips()).toBe(0);
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "managed_cutover_started" } });
    // No run/ledger edits or failure clearing: the executor retried its idempotent Route
    // while still holding the ticket (b986 stopped here instead).
    const retried = await resumeLab(f.account, f.deps);
    expect.soft(retried).toHaveProperty("done");
    expect(f.dispatches).toEqual(f.collections.map(id => [id, hold, true]));
    expect(f.resumes).toEqual(f.collections.map(id => [id, 1]));
    expect.soft(f.flips()).toBe(1);
    if ("stopped" in retried) expect(retried.stopped.reason).toBe("effect_unknown:19");
  });

  it("R2: last import refusal at ALL-paused must block explicit resume BEFORE any latch/resume/cutover", async () => {
    const f = await fixture("timer_import");
    expect(await labRun(f.account, hold, f.deps, true)).toMatchObject({ stopped: { step: "import_timers", reason: "timer_grant_unbound" } });
    const original = await f.snapshot();
    expect(original.cutovers).toEqual([]); expect(f.resumes).toEqual([]);
    const refused = await resumeLab(f.account, f.deps);
    // Soft assertions report every forbidden effect.
    expect.soft(refused).toMatchObject({ stopped: { step: "import_timers", reason: "timer_grant_unbound" } });
    expect.soft(f.events.filter(e => e.startsWith("latch:"))).toEqual([]);
    expect.soft(f.resumes).toEqual([]);
    expect.soft((await f.snapshot()).cutovers).toEqual([]);
    f.repairImport(); // external grant/import cause only; no Worker/status change
    const boundary = f.events.length;
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done");
    const retry = f.events.slice(boundary), firstResume = retry.findIndex(e => e.startsWith("resume:"));
    expect.soft(retry.slice(0, firstResume)).toEqual([...f.collections.map(id => `import:${id}`), "latch:cutover"]);
    expect(f.dispatches).toEqual(f.collections.map(id => [id, hold, true]));
    expect(f.resumes).toEqual(f.collections.map(id => [id, 1]));
    expect((await f.snapshot()).run).toMatchObject({ run: "run" in original.run ? original.run.run : null });
    expect(f.flips()).toBe(1);
  });

  it("R2: process loss after ALL-paused with no CP manifests imports ALL before the first latch/resume", async () => {
    const f = await fixture("no_manifest");
    await f.pauseWithoutManifest(); // admitted original runs; process died before importer entry
    const original = await f.snapshot();
    expect(f.imports).toEqual([]); expect(original.cutovers).toEqual([]);
    expect(await resumeLab(f.account, f.deps)).toHaveProperty("done");
    const firstResume = f.events.findIndex(e => e.startsWith("resume:"));
    expect(f.events.slice(0, firstResume)).toEqual([...f.collections.map(id => `import:${id}`), "latch:cutover"]);
    expect(f.dispatches).toEqual(f.collections.map(id => [id, hold, true]));
    expect(f.resumes).toEqual(f.collections.map(id => [id, 1]));
    expect((await f.snapshot()).run).toMatchObject({ run: "run" in original.run ? original.run.run : null });
    expect(f.flips()).toBe(1);
  });

  it("permanent C2 confirmation failure stays stopped; no combined flip or sibling rollback", async () => {
    const f = await fixture("permanent");
    for (const invoke of [() => labRun(f.account, hold, f.deps), () => resumeLab(f.account, f.deps), () => labRun(f.account, hold, f.deps)])
      expect(await invoke()).toMatchObject({ stopped: { reason: "migration_source_changed", collection_id: f.collections[1], phase: "cutover" } });
    expect(await routeBack(f.account, f.deps)).toMatchObject({ stopped: { reason: "managed_cutover_started" } });
    expect((await f.snapshot()).backend).toBe("legacy"); expect(f.flips()).toBe(0);
    expect(f.resumes).toEqual(f.collections.map(id => [id, 1]));
    expect(f.collections.every(id => f.providers.get(id)!.source.state === "migrated")).toBe(true);
  });
});

// Minimal lost-Route-response regression: a SAME live native ticket remains
// available inside the executor, and the existing CP /cutover is idempotent.
// b986 stopped and released the ticket instead. Do not simulate status healing or
// invent an operator recovery for an already-released UNKNOWN action.
describe("G4 real executor Route retry boundary (ledger-faithful native fixture)", () => {
  it("reissues the same Route after its committed cutover reply is lost", async () => {
    const store = mapStore(), plan = providerPlan().filter(p => p.kind === 19);
    store.saved = { index: 0, seq: 10, step: 12, fenced: true, attempts: 0, baseSeq: 21, revoked: [], outstanding: null, idleUsed: 0 };
    const native = new FakeNative(plan, store);
    let run = newRun(native.collection, HOLD, 1, true), requests = 0, commits = 0;
    run.resumeRunSequence = 1; run.membersBase = true;
    const seen: unknown[] = [];
    const executor = new MigrationExecutor({ collection: native.collection, host: native,
      store: { load: async () => structuredClone(run), save: async value => { run = structuredClone(value); } },
      // Only Route is reached. This port models the canonical same-facts replay
      // proved above against actual SQL; it never mutates native state itself.
      connect: () => ({ cutover: async (id: string, value: unknown) => {
        requests++; seen.push([id, value]);
        if (requests === 1) { commits++; throw new TypeError("synthetic lost response"); }
        return { status: 200, code: null, body: { collection_id: id, account_id: native.owner } };
      } }) as unknown as ReturnType<ConstructorParameters<typeof MigrationExecutor>[0]["connect"]>,
      source: async () => { throw new Error("No source read for Route"); }, sleep: async () => undefined, now: () => 1
    });
    const result = await executor.wake(new AbortController().signal, { actions: 8, ms: 10_000 });
    expect(result.state).toBe("done");
    expect(requests).toBe(2); expect(commits).toBe(1); expect(seen[1]).toEqual(seen[0]);
    expect(native.calls).toEqual(["prepare:19"]);
    expect(store.saved!.step).toBe(STEP.routed);
    expect(run.backupHold).toBe(HOLD); expect(run.resumeRunSequence).toBe(1);
  });
});
