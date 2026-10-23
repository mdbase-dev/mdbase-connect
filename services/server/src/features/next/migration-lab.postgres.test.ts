// lab-run end to end against PostgreSQL: the real control-plane port (preflight,
// cutover confirmation, timer-gated flip, LAB completion) with a scripted Worker
// and an in-memory legacy provider. Not native migration or a live Worker.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { fakeLegacyProvider, recordEmptyTimerImport } from "./legacy-provider.test-helper.js";
import { labRun, postgresLabConnect, PAUSE_REASON, STEP, type LabWorker, type WorkerStatus } from "./migration-lab.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, cutOverCollection, releaseCohort, setCohortFrozen, setPaused,
  startAccountMigration } from "./migration-rollout.js";
import { requireCompletedAccountMigration, requireCompletedNextAccountMigration } from "./migration-sharing.js";
import { registerNextCollection } from "./policy-outbox.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const actor = "synthetic-lab-run", hold = "30000000-0000-4000-8000-000000000003";

suite("lab-run against the control plane (synthetic PostgreSQL, scripted Worker)", () => {
  let admin: pg.Pool, db: DatabasePool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_lab_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => { await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  /** One LAB-profile account with one hosted collection, its SHADOW cloud copy and a fenced legacy source. */
  async function fixture(archived = false, environment: "lab" | "staging" = "lab", start: "lab" | "staging" = environment) {
    const user = randomUUID(), collection = randomUUID(), cohort = `lab-${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic LAB')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic','mdbase','https://provider.example','active')", [collection, user]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [user], actor);
    await setCohortFrozen(db, cohort, true, "synthetic freeze", actor); await releaseCohort(db, cohort, actor); await setPaused(db, false, "synthetic", actor);
    if (start === "staging") {
      // The staging deployment's ordinary start: a verified staging (v4) archive, no fixture profile.
      const clock = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
      await acceptCohortArchive(db, cohort, { schema: "mdbase-recovery-set/v4", environment: "staging", bucket: "synthetic-archives",
        prefix: `legacy-archive/staging/2026/10/10/${cohort}`, backup_id: cohort,
        complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "f".repeat(40),
        migration_batch: await cohortArchiveBinding(db, cohort), archive_created_at: clock, archive_completed_at: clock,
        retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: "c".repeat(64), count: "1" } }, "staging");
    } else if (archived) {
      // A verified LAB archive is accepted, so the cohort completes on it, not on the LAB completion event.
      const clock = new Date((await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now).toISOString();
      const component = (name: string, hex: string) => ({ commit: hex.repeat(40), image_digest: `sha256:${hex.repeat(64)}`, service_id: `srv-synthetic${name}` });
      await acceptCohortArchive(db, cohort, { schema: "mdbase-recovery-set/lab-cohort-v1", environment: "lab", bucket: "synthetic-archives",
        prefix: `legacy-archive/lab/2026/10/10/${cohort}`, backup_id: cohort,
        complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), source_commit: "f".repeat(40),
        migration_batch: await cohortArchiveBinding(db, cohort), archive_created_at: clock, archive_completed_at: clock,
        retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: "c".repeat(64), count: "1" },
        runtime_provenance: { connect: component("connect", "a"), hosted_provider: component("provider", "b"), relay: component("relay", "c"), mcp: component("mcp", "d") } }, "lab");
    }
    if (start === "staging") await startAccountMigration(db, user, "staging");
    else await startAccountMigration(db, user, "lab", await cohortArchiveBinding(db, cohort));
    await registerNextCollection(db, { collectionId: collection, ownerUserId: user, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16, 17),
      ops: [{ op: "genesis", owner: user, root: Buffer.alloc(16, 17), state: "cloud-copy" }, { op: "member-set", account: user, role: "owner" }] });
    const provider = fakeLegacyProvider(collection);
    const connect = postgresLabConnect({ db, source: db, actor, timers: true, environment, provider,
      // This fixture preinstalls its SHADOW parent; native/device bootstrap is
      // exercised by service-cloud-copy/provider suites, not its scripted Worker.
      prepareTarget: async () => {
        const row = await db.query("SELECT 1 FROM next_collections WHERE collection_id=$1 AND runtime='shadow' AND sync='cloud_copy'", [collection]);
        if (!row.rows.length) throw new Error("Synthetic SHADOW target missing");
      },
      // The importer itself is covered by timers/hosted-import.postgres.test.ts; record a timer-free manifest.
      importTimers: async () => recordEmptyTimerImport(db, user, provider.source) });
    return { user, collection, cohort, provider, connect };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  const status = (state: string, step: number, reason: string | null = null): WorkerStatus => ({
    run: { state, reason, backup_hold: hold, migration_id: null },
    native: { run_sequence: 1, outstanding: null, checkpoint: { step, fenced: step >= STEP.fenced && step < STEP.rollingBack } }
  });
  /** Answers status from a script; reaching `routed` first records the cutover as the Worker's Route does. */
  function worker(f: Fixture, script: WorkerStatus[]): LabWorker {
    const unused = async () => { throw new Error("not used by lab-run"); };
    let started = false;
    return {
      run: async () => { started = true; return { kind: "ok", status: status("running", 0) }; },
      async status() {
        if (!started) return { kind: "ok", status: { run: null, native: { checkpoint: null, outstanding: null, run_sequence: null } } };
        const next = script.length > 1 ? script.shift()! : script[0]!;
        if (next.native && "checkpoint" in next.native && next.native.checkpoint?.step === STEP.routed) {
          await cutOverCollection(db, f.provider, f.collection, { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) });
        }
        return { kind: "ok", status: next };
      },
      rollback: unused, restart: unused, resolve: unused, resume: unused
    };
  }
  /** An ordinary (managed) start's pause-mode run: the verified pause until the
   * one sequence-bound resume, then the same route. */
  function pausingWorker(f: Fixture): LabWorker {
    const unused = async () => { throw new Error("not used by lab-run"); };
    const before = [status("running", 2), status("running", STEP.drained), status("stopped", STEP.verified, PAUSE_REASON)];
    const after = [status("running", 9), status("done", STEP.routed)];
    let started = false, resumed = false;
    const mode = (s: WorkerStatus): WorkerStatus => ({ ...s, run: { ...s.run!, stop_before_flip: true, resumed_run_sequence: resumed ? 1 : null } });
    return {
      run: async (_collection, _hold, pause) => {
        if (pause !== true) throw new Error("managed runs are always in pause mode");
        started = true; return { kind: "ok", status: mode(status("running", 0)) };
      },
      async status() {
        if (!started) return { kind: "ok", status: { run: null, native: { checkpoint: null, outstanding: null, run_sequence: null } } };
        const script = resumed ? after : before, next = script.length > 1 ? script.shift()! : script[0]!;
        if (next.native && "checkpoint" in next.native && next.native.checkpoint?.step === STEP.routed) {
          await cutOverCollection(db, f.provider, f.collection, { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) });
        }
        return { kind: "ok", status: mode(next) };
      },
      resume: async () => { resumed = true; return { kind: "ok", status: mode(status("running", STEP.verified)) }; },
      rollback: unused, restart: unused, resolve: unused
    };
  }
  const deps = (f: Fixture, script: WorkerStatus[]) => ({ worker: worker(f, script), connect: f.connect, sleep: async () => undefined });
  const managedDeps = (f: Fixture) => ({ worker: pausingWorker(f), connect: f.connect, sleep: async () => undefined });
  const backend = async (user: string) => (await db.query("SELECT account_backend FROM users WHERE id=$1", [user])).rows[0].account_backend;
  const routed = () => [status("running", 2), status("running", STEP.drained), status("running", 9), status("done", STEP.routed)];

  it("happy path: Worker routed, timers imported, cutover migrated, flipped and LAB-complete", async () => {
    const f = await fixture();
    expect(await labRun(f.user, hold, deps(f, routed()))).toEqual({ done: { account_id: f.user, collection_id: f.collection, backend: "next", lab_complete: true } });
    expect(await backend(f.user)).toBe("next");
    expect(f.provider.source.state).toBe("migrated");
    await requireCompletedAccountMigration(db, f.collection, f.user);
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.lab_complete' AND subject_id=$1", [f.cohort])).rows).toHaveLength(1);
  });

  it("an accepted LAB archive completes the cohort, and the completion read-back accepts it", async () => {
    const f = await fixture(true);
    expect(await labRun(f.user, hold, deps(f, routed()))).toEqual({ done: { account_id: f.user, collection_id: f.collection, backend: "next", lab_complete: true } });
    await requireCompletedAccountMigration(db, f.collection, f.user);
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.lab_complete' AND subject_id=$1", [f.cohort])).rows).toHaveLength(0);
    expect(await labRun(f.user, hold, deps(f, [status("stopped", 0, "must_not_be_read")]))).toMatchObject({ done: { lab_complete: true } });
  });

  it("resumes after an operator stop, and a repeat only re-reads the completion", async () => {
    const f = await fixture();
    const first = await labRun(f.user, hold, deps(f, [status("running", 3), status("stopped", 4, "outstanding_unknown:AppendBase")]));
    expect(first).toEqual({ stopped: { step: "worker_status", reason: "outstanding_unknown:AppendBase",
      inspect: `pnpm --filter @mdbase/connect-server next:migration-lab status ${f.user}`,
      resume: `pnpm --filter @mdbase/connect-server next:migration-lab lab-run ${f.user} ${hold}` } });
    expect(await backend(f.user)).toBe("legacy");
    expect((await db.query("SELECT 1 FROM next_migration_collections WHERE collection_id=$1", [f.collection])).rows).toHaveLength(0);
    // The operator resolved the run; the same command continues from the Worker's state.
    expect("done" in await labRun(f.user, hold, deps(f, routed()))).toBe(true);
    expect(await labRun(f.user, hold, deps(f, [status("stopped", 0, "must_not_be_read")]))).toMatchObject({ done: { lab_complete: true } });
  });

  it("staging deployment: an ordinary archived start runs, flips as staging and completes on the accepted archive", async () => {
    const f = await fixture(false, "staging");
    expect(await labRun(f.user, hold, managedDeps(f))).toEqual({ done: { account_id: f.user, collection_ids: [f.collection], backend: "next", migration_complete: true } });
    expect(await backend(f.user)).toBe("next");
    expect(f.provider.source.state).toBe("migrated");
    await requireCompletedAccountMigration(db, f.collection, f.user);
    // The staging flip completes the cohort on its archive; no LAB completion event is ever written.
    expect((await db.query("SELECT 1 FROM next_migration_cohorts WHERE name=$1 AND completed_at IS NOT NULL", [f.cohort])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.lab_complete' AND subject_id=$1", [f.cohort])).rows).toHaveLength(0);
  });

  it("staging deployment: a suspended owner migrates and completes, while every product guard still refuses it", async () => {
    const f = await fixture(false, "staging");
    await db.query("UPDATE users SET suspended_at=now(), session_epoch=session_epoch+1 WHERE id=$1", [f.user]);
    expect(await labRun(f.user, hold, managedDeps(f))).toEqual({ done: { account_id: f.user, collection_ids: [f.collection], backend: "next", migration_complete: true } });
    expect(await backend(f.user)).toBe("next");
    await requireCompletedAccountMigration(db, f.collection, f.user, { suspendedOwner: true });
    // Sharing, timers and other post-migration guards keep refusing the suspended owner.
    await expect(requireCompletedAccountMigration(db, f.collection, f.user)).rejects.toMatchObject({ code: "collection_migrating" });
    await expect(requireCompletedNextAccountMigration(db, f.user)).rejects.toMatchObject({ code: "collection_migrating" });
    // Suspension is the ONLY difference: restoring the owner satisfies the product readback unchanged.
    await db.query("UPDATE users SET suspended_at=NULL WHERE id=$1", [f.user]);
    await requireCompletedAccountMigration(db, f.collection, f.user);
    await requireCompletedNextAccountMigration(db, f.user);
    expect((await db.query("SELECT 1 FROM next_migration_cohorts WHERE name=$1 AND completed_at IS NOT NULL", [f.cohort])).rows).toHaveLength(1);
  });

  it("a suspended owner's incomplete migration still fails the migration job's completion readback", async () => {
    const f = await fixture(false, "staging");
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [f.user]);
    await expect(requireCompletedAccountMigration(db, f.collection, f.user, { suspendedOwner: true })).rejects.toMatchObject({ code: "collection_migrating" });
  });

  it("a managed deployment still refuses the LAB fixture start profile", async () => {
    const labStart = await fixture(false, "staging", "lab");
    expect(await labRun(labStart.user, hold, deps(labStart, routed()))).toMatchObject({ stopped: { step: "preflight", reason: "start_profile_invalid" } });
    expect(await backend(labStart.user)).toBe("legacy");
  });

  it("stops at the flip when the start's starter reservation drifted", async () => {
    const f = await fixture();
    await db.query("INSERT INTO account_onboarding(user_id,starter_collection_id,template_version,timezone) VALUES($1,$2,'v1','UTC')", [f.user, randomUUID()]);
    expect(await labRun(f.user, hold, deps(f, routed()))).toMatchObject({ stopped: { step: "flip", reason: "starter_reservation_changed" } });
    expect(await backend(f.user)).toBe("legacy");
  });
});
