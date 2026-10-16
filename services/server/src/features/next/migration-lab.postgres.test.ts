// lab-run end to end against PostgreSQL: the real control-plane port (preflight,
// cutover confirmation, timer-gated flip, LAB completion) with a scripted Worker
// and an in-memory legacy provider. Not native migration or a live Worker.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { fakeLegacyProvider, recordEmptyTimerImport } from "./legacy-provider.test-helper.js";
import { labRun, postgresLabConnect, STEP, type LabWorker, type WorkerStatus } from "./migration-lab.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, cutOverCollection, releaseCohort, setCohortFrozen, setPaused,
  startAccountMigration } from "./migration-rollout.js";
import { requireCompletedAccountMigration } from "./migration-sharing.js";
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
  async function fixture(archived = false) {
    const user = randomUUID(), collection = randomUUID(), cohort = `lab-${randomUUID()}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic LAB')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic','mdbase','https://provider.example','active')", [collection, user]);
    await createCohort(db, cohort, actor); await addToCohort(db, cohort, [user], actor);
    await setCohortFrozen(db, cohort, true, "synthetic freeze", actor); await releaseCohort(db, cohort, actor); await setPaused(db, false, "synthetic", actor);
    if (archived) {
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
    await startAccountMigration(db, user, "lab", await cohortArchiveBinding(db, cohort));
    await registerNextCollection(db, { collectionId: collection, ownerUserId: user, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16, 17),
      ops: [{ op: "genesis", owner: user, root: Buffer.alloc(16, 17), state: "cloud-copy" }, { op: "member-set", account: user, role: "owner" }] });
    const provider = fakeLegacyProvider(collection);
    const connect = postgresLabConnect({ db, source: db, actor, timers: true, provider,
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
    return {
      run: async () => ({ kind: "ok", status: status("running", 0) }),
      async status() {
        const next = script.length > 1 ? script.shift()! : script[0]!;
        if (next.native && "checkpoint" in next.native && next.native.checkpoint?.step === STEP.routed) {
          await cutOverCollection(db, f.provider, f.collection, { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) });
        }
        return { kind: "ok", status: next };
      },
      rollback: unused, restart: unused, resolve: unused
    };
  }
  const deps = (f: Fixture, script: WorkerStatus[]) => ({ worker: worker(f, script), connect: f.connect, sleep: async () => undefined });
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

  it("stops at the flip when the start's starter reservation drifted", async () => {
    const f = await fixture();
    await db.query("INSERT INTO account_onboarding(user_id,starter_collection_id,template_version,timezone) VALUES($1,$2,'v1','UTC')", [f.user, randomUUID()]);
    expect(await labRun(f.user, hold, deps(f, routed()))).toMatchObject({ stopped: { step: "flip", reason: "starter_reservation_changed" } });
    expect(await backend(f.user)).toBe("legacy");
  });
});
