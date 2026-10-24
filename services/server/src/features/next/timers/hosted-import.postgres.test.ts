import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, openDatabase, type DatabasePool } from "../../../db.js";
import type { LegacyMigrationDrain } from "../../../hosted-provider.js";
import type { LegacyNotificationWatermark } from "../../../hosted-provider-replies.js";
import { audit } from "../../../platform/audit-events.js";
import { registerNextCollection } from "../policy-outbox.js";
import { flipAccountBackend, flipEvidenceDigest, recordCollectionCutover, type TimerFlipGate } from "../migration-rollout.js";
import { legacyTimerGrantResolver } from "./grants.js";
import { importHostedCollectionTimers, type TimerSourceProvider } from "./hosted-import.js";
import { cleanUpRolledBackTimerImport, registerMigrationTimerCleanupRoute } from "../migration-timer-cleanup.js";
import { postgresLabConnect } from "../migration-lab.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const time = "2030-01-01T12:13:14.123456Z";
const nano = "2030-01-01T12:13:14.123456789Z";
const started = "2026-10-12T00:00:00.123456Z";
const mark = (n: number) => `"mdbase-legacy-notifications-v1:${n.toString(16).padStart(64, "0")}"` as LegacyNotificationWatermark;

suite("strict hosted timer import and the account-flip timer gate (synthetic PostgreSQL)", () => {
  let admin: pg.Pool, writer: pg.Pool, sourcePool: DatabasePool, db: DatabasePool;
  const schemas: string[] = [];
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Dedicated local test PostgreSQL required");
    }
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    const [control, provider] = ["timer_import_cp", "timer_import_src"].map(prefix => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    schemas.push(control!, provider!);
    for (const schema of schemas) await admin.query(`CREATE SCHEMA "${schema}"`);
    const controlUrl = new URL(url); controlUrl.searchParams.set("options", `-csearch_path=${control}`);
    db = await createDatabase(controlUrl.toString());
    const providerUrl = new URL(url); providerUrl.searchParams.set("options", `-csearch_path=${provider}`);
    writer = new pg.Pool({ connectionString: providerUrl.toString(), max: 2 });
    // Physical provider columns the reader selects (see hosted-copy.postgres.test.ts).
    await writer.query(`
      CREATE TABLE hosted_provider_collections(id uuid PRIMARY KEY, state text NOT NULL,
        legacy_migration_id uuid, legacy_migration_started_at timestamptz, head bigint NOT NULL);
      CREATE TABLE mdbase_runtime_schema(singleton boolean PRIMARY KEY CHECK(singleton), version integer NOT NULL);
      INSERT INTO mdbase_runtime_schema VALUES(TRUE,2);
      CREATE TABLE mdbase_runtime_timers(namespace text NOT NULL,id text NOT NULL,generation bigint NOT NULL,
        status text NOT NULL,fire_at timestamptz NOT NULL,lease_worker text,lease_token text,
        lease_expires_at timestamptz,record_json jsonb NOT NULL,PRIMARY KEY(namespace,id));
      CREATE TABLE mdbase_runtime_runs(namespace text NOT NULL,id text NOT NULL,status text NOT NULL,
        lease_worker text,lease_token text,lease_expires_at timestamptz,record_json jsonb,PRIMARY KEY(namespace,id));
      CREATE TABLE hosted_provider_runtime_outbox(collection_id uuid NOT NULL,processed_at timestamptz,
        lease_token text,leased_until timestamptz);
      CREATE TABLE hosted_provider_replicas(id uuid PRIMARY KEY,collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id));
      CREATE TABLE hosted_provider_mutation_journal(replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id),state text NOT NULL);
    `);
    providerUrl.searchParams.set("options", `-csearch_path=${provider} -cdefault_transaction_read_only=on`);
    sourcePool = await openDatabase(providerUrl.toString());
  }, 60_000);
  afterAll(async () => {
    await sourcePool?.end(); await writer?.end(); await db?.end();
    for (const schema of schemas) await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  /** One started account with one hosted collection, its cloud copy, a bound
   * grant, a fenced legacy source holding `count` timers, and a fake provider. */
  async function fixture(count: number) {
    const [user, collection, application, grant, migration] = Array.from({ length: 5 }, () => randomUUID());
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'User')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO applications(id,canonical_identity,manifest_version,name,homepage,redirect_uris) VALUES($1,$2,1,'Test','https://app.example.test','[]'::jsonb)", [application, `bundle:test:${application}`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url,authority_state) VALUES($1,$2,'Synthetic original','mdbase','https://provider.example','active')", [collection, user]);
    await db.query(`INSERT INTO grants(id,user_id,application_id,hosted_collection_id,operations,scope,application_origin,application_authorization,application_installation_id)
      VALUES($1,$2,$3,$4,'["reconcile_timers"]'::jsonb,'{"contracts":[]}'::jsonb,'https://app.example.test','{"binding":{"protocol_version":4}}'::jsonb,$5)`, [grant, user, application, collection, randomUUID()]);
    await registerNextCollection(db, { collectionId: collection, ownerUserId: user, runtime: "shadow", sync: "cloud_copy", rootKeyId: Buffer.alloc(16, 17), ops: [{ op: "genesis", owner: user, root: Buffer.alloc(16, 17), state: "cloud-copy" }, { op: "member-set", account: user, role: "owner" }] });
    const cohort = `c${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await db.query("INSERT INTO next_migration_cohorts(name,released_at) VALUES($1,now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,now())", [user, cohort]);
    // The start's audit event: this account has no starter reservation.
    await audit(db, user, "next_migration.start", user, { starter_reservation: null });
    const namespace = `connect-hosted:${collection}:notifications`;
    await writer.query("INSERT INTO hosted_provider_collections VALUES($1,'migrating',$2,$3,7)", [collection, migration, started]);
    for (let index = 0; index < count; index++) await sourceTimer(namespace, grant, index);
    const provider = {
      drain: { collection_id: collection, state: "migrating", migration_id: migration, head: 7, started_at: "2026-10-12T00:00:00.123456Z",
        retain_until: null, in_flight: 0, unresolved: 0, applied_unreceipted: 0 } as LegacyMigrationDrain,
      watermarks: [] as LegacyNotificationWatermark[], current: mark(1),
      async legacyMigrationSource() {
        return { drain: { ...provider.drain }, notificationWatermark: provider.watermarks.shift() ?? provider.current };
      }
    };
    return { user, collection, grant, migration, namespace, provider };
  }
  async function sourceTimer(namespace: string, grant: string, index: number, status = ["scheduled", "fired", "cancelled"][index % 3]!) {
    const timer_id = `timer-${String(index).padStart(4, "0")}`;
    const id = `connect:${grant}:reminders:timer.${Buffer.from(timer_id).toString("hex")}`;
    const record = { id, generation: 7, status, fire_at: nano, created_at: nano, updated_at: nano,
      fired_at: status === "fired" ? nano : null,
      event_contract: { id: "test/timer", version: "1", digest: `sha256:${"a".repeat(64)}` },
      event_source: { application: "original", implementation: "timer", version: "1" },
      source_uri: "app:test", subject: timer_id,
      data: { grant_id: grant, namespace: "reminders", timer_id, criterion_id: "reminder", data: { text: "x".repeat(200), n: 0.1 } } };
    await writer.query("INSERT INTO mdbase_runtime_timers(namespace,id,generation,status,fire_at,record_json) VALUES($1,$2,7,$3,$4,$5::jsonb)",
      [namespace, id, status, time, JSON.stringify(record)]);
  }
  const run = (f: Awaited<ReturnType<typeof fixture>>) => importHostedCollectionTimers({
    db, source: sourcePool, provider: f.provider as TimerSourceProvider, resolver: legacyTimerGrantResolver, collection: f.collection, actor: "test-operator"
  });
  const targetRows = async (grant: string) => Number((await db.query("SELECT count(*) AS n FROM next_timers WHERE grant_id=$1 AND legacy_import_origin IS NOT NULL", [grant])).rows[0].n);
  const failure = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);
  /** Record the cutover; the provider moves legacy to `migrated` on the same run. */
  async function cutOver(f: Awaited<ReturnType<typeof fixture>>) {
    await recordCollectionCutover(db, f.collection, { s_final: 7, cutover_seq: 11, barrier_f: 13, final_digest: "e".repeat(64) });
    f.provider.drain = { ...f.provider.drain, state: "migrated", retain_until: "2027-01-12T00:00:00.000Z" };
    return flipEvidenceDigest([{ collection_id: f.collection, barrier_f: 13, final_digest: "e".repeat(64) }]);
  }
  const gate = (f: Awaited<ReturnType<typeof fixture>>): TimerFlipGate => ({ enabled: true, provider: f.provider as TimerSourceProvider });

  it("imports every page exactly once, is idempotent, and the flip passes on the same watermark", async () => {
    const f = await fixture(70);
    const manifest = await run(f);
    expect(manifest).toMatchObject({ collection_id: f.collection, migration_id: f.migration, timers: 70, head: "7",
      notification_watermark: mark(1), started_at: started });
    expect(await targetRows(f.grant)).toBe(70);
    const statuses = (await db.query("SELECT status, count(*)::int AS n FROM next_timers WHERE grant_id=$1 GROUP BY status ORDER BY status", [f.grant])).rows;
    expect(statuses).toEqual([{ status: "cancelled", n: 23 }, { status: "fired", n: 23 }, { status: "scheduled", n: 24 }]);
    expect(await run(f)).toEqual(manifest);
    expect(await targetRows(f.grant)).toBe(70);
    const evidence = await cutOver(f);
    expect((await flipAccountBackend(db, f.user, [f.collection], evidence, gate(f))).backend).toBe("next");
    // The idempotent retry needs no timer reads.
    expect((await flipAccountBackend(db, f.user, [f.collection], evidence, { enabled: false })).backend).toBe("next");
  });

  it("refuses the flip without timers, an import, a migrated source, or the same watermark and run", async () => {
    const f = await fixture(3);
    const evidence = await cutOver(f);
    const flip = (timers: TimerFlipGate) => failure(flipAccountBackend(db, f.user, [f.collection], evidence, timers));
    expect(await flip({ enabled: false, provider: f.provider as TimerSourceProvider })).toBe("next_timers_disabled");
    expect(await flip({ enabled: true })).toBe("migration_source_unavailable");
    expect(await flip(gate(f))).toBe("timers_not_imported");
    f.provider.drain = { ...f.provider.drain, state: "migrating", retain_until: null };
    await run(f);
    expect(await flip(gate(f))).toBe("migration_source_not_migrated");
    f.provider.drain = { ...f.provider.drain, state: "migrated", retain_until: "2027-01-12T00:00:00.000Z" };
    f.provider.current = mark(2);
    expect(await flip(gate(f))).toBe("timers_source_changed");
    f.provider.current = mark(1);
    const original = f.provider.drain;
    f.provider.drain = { ...original, migration_id: randomUUID() };
    expect(await flip(gate(f))).toBe("timers_source_changed");
    f.provider.drain = original;
    // Target drift after import: a changed or missing row.
    await db.query("UPDATE next_timers SET status='cancelled' WHERE grant_id=$1 AND status='scheduled'", [f.grant]);
    expect(await flip(gate(f))).toBe("timers_identity_mismatch");
    await db.query("UPDATE next_timers SET status='scheduled' WHERE grant_id=$1 AND fired_at IS NULL AND legacy_import_origin->>'status'='scheduled'", [f.grant]);
    expect((await flipAccountBackend(db, f.user, [f.collection], evidence, gate(f))).backend).toBe("next");
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [f.user])).rows[0].account_backend).toBe("next");
  });

  it("records no manifest when the watermark moves during the import, and a stable retry completes", async () => {
    const f = await fixture(2);
    f.provider.watermarks = [mark(1), mark(9)];
    expect(await failure(run(f))).toBe("timer_source_changed");
    const evidence = await cutOver(f);
    expect(await failure(flipAccountBackend(db, f.user, [f.collection], evidence, gate(f)))).toBe("timers_not_imported");
    f.provider.drain = { ...f.provider.drain, state: "migrating", retain_until: null };
    expect((await run(f)).timers).toBe(2);
  });

  it("refuses an undrained source, an unstarted account, an unbound grant and a stale extra target row", async () => {
    const undrained = await fixture(1);
    undrained.provider.drain = { ...undrained.provider.drain, in_flight: 1 };
    expect(await failure(run(undrained))).toBe("migration_source_not_drained");
    expect(await targetRows(undrained.grant)).toBe(0);

    const unstarted = await fixture(1);
    await db.query("UPDATE next_migration_cohort_members SET started_at=NULL WHERE account_id=$1", [unstarted.user]);
    expect(await failure(run(unstarted))).toBe("account_not_started");
    expect(await targetRows(unstarted.grant)).toBe(0);

    // A source timer naming another collection's grant never imports.
    const other = await fixture(0);
    const unbound = await fixture(1);
    await sourceTimer(unbound.namespace, other.grant, 5);
    expect(await failure(run(unbound))).toBe("timer_grant_unbound");
    expect(await targetRows(unbound.grant) + await targetRows(other.grant)).toBe(0);

    // A timer removed from the source after an earlier import leaves a target
    // row the source no longer has: the import refuses rather than ignoring it.
    const stale = await fixture(2);
    await run(stale);
    await writer.query("DELETE FROM mdbase_runtime_timers WHERE namespace=$1 AND id=(SELECT min(id) FROM mdbase_runtime_timers WHERE namespace=$1)", [stale.namespace]);
    expect(await failure(run(stale))).toBe("timer_import_mismatch");
  });

  // ---- LAB rollback cleanup of one provider run's imported rows ----
  const token = "t".repeat(40);
  type F = Awaited<ReturnType<typeof fixture>>;
  async function cleanupApp(f: F, environment: string | undefined) {
    const app = Fastify();
    registerMigrationTimerCleanupRoute(app, { db, token, environment, provider: { async legacyMigrationDrain() { return { ...f.provider.drain }; } } });
    return app;
  }
  async function cleanup(f: F, options: { environment?: string; auth?: string; migration?: string; startedUs?: string } = {}) {
    const app = await cleanupApp(f, "environment" in options ? options.environment : "lab");
    const startedUs = options.startedUs ?? (await db.query("SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS us FROM next_migration_cohort_members WHERE account_id=$1", [f.user])).rows[0].us;
    try {
      return await app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.collection}/timers/rollback-cleanup`,
        headers: options.auth === "" ? {} : { authorization: `Bearer ${options.auth ?? token}` },
        payload: { owner_account: f.user, started_us: startedUs, migration_id: options.migration ?? f.migration } });
    } finally { await app.close(); }
  }
  /** Move the provider (and its physical row) to another fenced run. */
  async function refence(f: F, migration = randomUUID()) {
    await writer.query("UPDATE hosted_provider_collections SET state='migrating',legacy_migration_id=$2,legacy_migration_started_at=$3 WHERE id=$1", [f.collection, migration, started]);
    f.provider.drain = { ...f.provider.drain, state: "migrating", migration_id: migration, started_at: started };
    return migration;
  }
  /** A settled pre-cutover rollback of `migration`: Connect recorded its unfence, and the source is active with no run. */
  async function rolledBack(f: F, migration: string) {
    await audit(db, f.user, "next_migration.unfence", f.collection, { migration_id: migration });
    f.provider.drain = { ...f.provider.drain, state: "active", migration_id: null, started_at: null };
  }
  const allRows = async (grant: string) => (await db.query("SELECT timer_id, generation::text, legacy_import_origin IS NULL AS native FROM next_timers WHERE grant_id=$1 ORDER BY timer_id", [grant])).rows;

  it("deletes only the rolled-back run's imported rows, keeps evidence, and lets a later run re-import", async () => {
    const f = await fixture(70);
    await run(f);
    await db.query("INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at) VALUES($1,'reminders','native-timer','reminder',now()+interval '1 day')", [f.grant]);
    // A second run imports one more timer (the others are identical and stay).
    const second = await refence(f);
    await sourceTimer(f.namespace, f.grant, 70);
    await run(f);
    await rolledBack(f, f.migration);
    // The source changed after the rollback: without cleanup a new run conflicts.
    await writer.query(`UPDATE mdbase_runtime_timers SET generation=8, record_json=jsonb_set(record_json,'{generation}','8')
      WHERE namespace=$1 AND id=(SELECT min(id) FROM mdbase_runtime_timers WHERE namespace=$1)`, [f.namespace]);
    await refence(f);
    expect(await failure(run(f))).toBe("timer_import_conflict");
    await rolledBack(f, second);
    const manifests = (await db.query("SELECT id FROM audit_events WHERE subject_id=$1 AND event_type LIKE 'next_migration.timers_%' ORDER BY id", [f.collection])).rows;
    const cleaned = await cleanup(f);
    expect(cleaned.statusCode, cleaned.body).toBe(200);
    expect(cleaned.json()).toEqual({ collection_id: f.collection, migration_id: f.migration, deleted: 70 });
    // The other run's timer and the native timer survive; all earlier evidence stays.
    expect(await allRows(f.grant)).toEqual([{ timer_id: "native-timer", generation: "1", native: true }, { timer_id: "timer-0070", generation: "7", native: false }]);
    const after = (await db.query("SELECT id FROM audit_events WHERE subject_id=$1 AND event_type LIKE 'next_migration.timers_%' ORDER BY id", [f.collection])).rows;
    expect(after).toEqual(expect.arrayContaining(manifests));
    expect((await db.query("SELECT metadata FROM audit_events WHERE subject_id=$1 AND event_type='next_migration.timers_rollback_cleanup'", [f.collection])).rows)
      .toEqual([{ metadata: expect.objectContaining({ migration_id: f.migration, deleted: 70 }) }]);
    // Idempotent: nothing more to delete, no second cleanup event.
    expect((await cleanup(f)).json().deleted).toBe(0);
    await refence(f);
    expect((await run(f)).timers).toBe(71);
    expect((await allRows(f.grant)).find(row => row.timer_id === "timer-0000")!.generation).toBe("8");
  });

  it.each(["staging", "production"])("the %s job cleans up a rolled-back run through its own port; the HTTP route stays LAB-only", async environment => {
    const f = await fixture(3);
    await run(f);
    await rolledBack(f, f.migration);
    const provider = { ...f.provider, async legacyMigrationDrain() { return { ...f.provider.drain }; } };
    expect((await cleanup(f, { environment })).json().error.code).toBe("migration_lab_only");
    const startedUs = (await db.query("SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS us FROM next_migration_cohort_members WHERE account_id=$1", [f.user])).rows[0].us;
    for (const environment of ["Production", "local", "LAB", undefined]) {
      expect(await failure(cleanUpRolledBackTimerImport(db, provider, environment, f.collection,
        { owner_account: f.user, started_us: startedUs, migration_id: f.migration }))).toBe("migration_lab_only");
    }
    expect(await targetRows(f.grant)).toBe(3);
    const connect = postgresLabConnect({ db, source: sourcePool, actor: "test-operator", timers: true, environment,
      provider: provider as unknown as Parameters<typeof postgresLabConnect>[0]["provider"] });
    expect(await connect.cleanupTimers(f.collection, f.migration)).toEqual({ collection_id: f.collection, migration_id: f.migration, deleted: 3 });
    expect(await targetRows(f.grant)).toBe(0);
  });

  it("refuses an unauthenticated, non-LAB, unbound or unsettled cleanup and deletes nothing", async () => {
    const f = await fixture(3);
    await run(f);
    expect((await cleanup(f, { auth: "" })).statusCode).toBe(401);
    expect((await cleanup(f, { auth: "x".repeat(40) })).statusCode).toBe(401);
    for (const environment of ["staging", "production", "LAB", undefined]) {
      const refused = await cleanup(f, { environment });
      expect(refused.statusCode).toBe(403); expect(refused.json().error.code).toBe("migration_lab_only");
    }
    // Still fenced on the run, no recorded unfence: not a settled rollback.
    expect((await cleanup(f)).json().error.code).toBe("migration_rollback_not_settled");
    await audit(db, f.user, "next_migration.unfence", f.collection, { migration_id: f.migration });
    expect((await cleanup(f)).json().error.code).toBe("migration_rollback_not_settled");
    // Source settled, but the recorded unfence names another run.
    const other = await fixture(0);
    f.provider.drain = { ...f.provider.drain, state: "active", migration_id: null, started_at: null };
    expect((await cleanup(f, { migration: other.migration })).json().error.code).toBe("migration_rollback_not_settled");
    expect((await cleanup(f, { startedUs: "1" })).json().error.code).toBe("migration_claim_not_current");
    expect(await targetRows(f.grant)).toBe(3);
  });

  it("stops without deleting when a run's row drifted or emitted an event", async () => {
    for (const drift of ["status", "event"] as const) {
      const f = await fixture(3);
      await run(f);
      await rolledBack(f, f.migration);
      const row = (await db.query("SELECT namespace,timer_id,criterion_id FROM next_timers WHERE grant_id=$1 AND status='scheduled' LIMIT 1", [f.grant])).rows[0];
      if (drift === "status") await db.query("UPDATE next_timers SET status='cancelled' WHERE grant_id=$1 AND timer_id=$2", [f.grant, row.timer_id]);
      else await db.query(`INSERT INTO next_timer_events(event_id,grant_id,criterion_id,namespace,timer_id,generation,scheduled_for,fired_at,late_by_ms)
        VALUES($1,$2,$3,$4,$5,7,now(),now(),0)`, [randomUUID(), f.grant, row.criterion_id, row.namespace, row.timer_id]);
      const refused = await cleanup(f);
      expect(refused.statusCode).toBe(409); expect(refused.json().error.code).toBe("timer_cleanup_drifted");
      expect(await targetRows(f.grant)).toBe(3);
    }
  });
});
