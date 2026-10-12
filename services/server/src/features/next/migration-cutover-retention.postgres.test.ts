// The cutover route moves legacy to `migrated` only after a committed cutover
// record, idempotently, and never before. Isolated real PostgreSQL with an
// in-memory legacy provider; not the Rust provider or a native migration.
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedProviderUnavailableError } from "../../hosted-provider.js";
import { fakeLegacyProvider, type FakeLegacyProvider } from "./legacy-provider.test-helper.js";
import {
  acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, recordCollectionCutover,
  registerMigrationRolloutRoutes, releaseCohort, setCohortFrozen, setPaused, startAccountMigration
} from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const token = "r".repeat(40);
const OP = "test-operator";
const digest = (n: number) => n.toString(16).padStart(64, "0");
const facts = { s_final: 3, cutover_seq: 10, barrier_f: 10, final_digest: digest(1) };
const DAY = 86_400_000;

describePg("cutover starts legacy retention after the committed record (dedicated local Postgres)", () => {
  let db: DatabasePool; let admin: pg.Pool; let schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test Postgres required");
    schema = `migration_cutover_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  /** A started account with one hosted collection and its preserved-id cloud copy. */
  async function fixture({ start = true, copy = true } = {}) {
    const user = randomUUID(), collection = randomUUID(), cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state) VALUES($1,$2,'C','mdbase','active')", [collection, user]);
    await createCohort(db, cohort, OP); await addToCohort(db, cohort, [user], OP); await releaseCohort(db, cohort, OP);
    await setCohortFrozen(db, cohort, true, "synthetic archive capture", OP);
    const binding = await cohortArchiveBinding(db, cohort);
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0].now).toISOString();
    await acceptCohortArchive(db, cohort, {
      schema: "mdbase-recovery-set/v4", environment: "production", bucket: "test-migration-archives",
      prefix: `production/2026/10/12/${cohort}`, backup_id: cohort, complete_sha256: digest(90), manifest_sha256: digest(91),
      source_commit: "a".repeat(40), migration_batch: binding, archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * DAY).toISOString(),
        inventory_digest: digest(92), count: "3" }
    }, "production");
    await setPaused(db, false, "go", OP);
    if (start) await startAccountMigration(db, user, "production");
    if (copy) await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [collection, user, Buffer.alloc(16)]);
    const legacy = fakeLegacyProvider(collection);
    const app = Fastify();
    registerMigrationRolloutRoutes(app, { db, token, environment: "production", provider: legacy });
    const cut = (payload: object = facts) => app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${collection}/cutover`,
      headers: { authorization: `Bearer ${token}` }, payload });
    const recorded = async () => (await db.query("SELECT count(*)::int AS n FROM next_migration_collections WHERE collection_id=$1", [collection])).rows[0].n as number;
    return { user, collection, legacy, app, cut, recorded };
  }
  const retains = (legacy: FakeLegacyProvider) => legacy.calls.filter(call => call.startsWith("retain:")).length;

  it("records, then starts retention on the same run; a retry repeats only the idempotent step", async () => {
    const f = await fixture(); try {
      let committedAtRetain: number | undefined;
      f.legacy.before = async call => { if (call === "retain") committedAtRetain = await f.recorded(); };
      const first = await f.cut();
      expect(first.statusCode, first.body).toBe(200);
      // Native decodes this body with an exact key set.
      expect(first.json()).toEqual({ collection_id: f.collection, account_id: f.user });
      expect(committedAtRetain).toBe(1);
      expect(f.legacy.calls).toEqual([`drain:${f.collection}`, `retain:${f.collection}`]);
      expect(f.legacy.source.state).toBe("migrated");
      const retained = Date.parse(f.legacy.source.retain_until!);
      expect(retained).toBeGreaterThanOrEqual(Date.now() + 90 * DAY);
      const retry = await f.cut();
      expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toEqual(first.json());
      expect(retains(f.legacy)).toBe(2); expect(await f.recorded()).toBe(1);
      expect(Date.parse(f.legacy.source.retain_until!)).toBeGreaterThanOrEqual(retained);
    } finally { await f.app.close(); }
  });

  it.each([
    ["active", { state: "active", migration_id: null, started_at: null }],
    ["undrained", { in_flight: 1 }],
    ["missing run", { migration_id: null }],
    ["missing start", { started_at: null }],
    ["retained but still migrating", { retain_until: "2027-01-01T00:00:00.000Z" }],
    ["migrated without retention", { state: "migrated" }],
    ["foreign source", { collection_id: randomUUID() }],
    ["unknown state", { state: "deleted" }]
  ] as const)("never records or retains when legacy is not fenced and drained: %s", async (_, source) => {
    const f = await fixture(); try {
      Object.assign(f.legacy.source, source);
      const result = await f.cut();
      expect(result.statusCode, result.body).toBe(409); expect(result.json().error.code).toBe("migration_source_not_drained");
      expect(await f.recorded()).toBe(0); expect(retains(f.legacy)).toBe(0);
    } finally { await f.app.close(); }
  });

  it("never retains when the cutover record is refused or conflicts", async () => {
    const notStarted = await fixture({ start: false }); try {
      const result = await notStarted.cut(); expect(result.json().error.code).toBe("account_not_started");
      expect(retains(notStarted.legacy)).toBe(0); expect(notStarted.legacy.source.state).toBe("migrating");
    } finally { await notStarted.app.close(); }
    const noCopy = await fixture({ copy: false }); try {
      const result = await noCopy.cut(); expect(result.json().error.code).toBe("next_collection_missing");
      expect(retains(noCopy.legacy)).toBe(0); expect(noCopy.legacy.source.state).toBe("migrating");
    } finally { await noCopy.app.close(); }
    const conflict = await fixture(); try {
      await recordCollectionCutover(db, conflict.collection, facts);
      const result = await conflict.cut({ ...facts, final_digest: digest(2) });
      expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("cutover_conflict");
      expect(retains(conflict.legacy)).toBe(0); expect(conflict.legacy.source.state).toBe("migrating");
      const invalid = await conflict.cut({ ...facts, barrier_f: 1 });
      expect(invalid.statusCode).toBe(400); expect(conflict.legacy.calls).toEqual([`drain:${conflict.collection}`]);
    } finally { await conflict.app.close(); }
  });

  it("refuses before any record when the provider is absent or unreadable", async () => {
    const f = await fixture(); try {
      const bare = Fastify(); registerMigrationRolloutRoutes(bare, { db, token, environment: "production" });
      const missing = await bare.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.collection}/cutover`,
        headers: { authorization: `Bearer ${token}` }, payload: facts });
      expect(missing.statusCode).toBe(503); expect(missing.json().error.code).toBe("migration_source_unavailable");
      await bare.close();
      f.legacy.before = call => { if (call === "drain") throw new HostedProviderUnavailableError(new Error("synthetic")); };
      const unreadable = await f.cut();
      expect(unreadable.statusCode).toBe(503); expect(unreadable.json().error.code).toBe("migration_source_unavailable");
      expect(await f.recorded()).toBe(0); expect(retains(f.legacy)).toBe(0);
    } finally { await f.app.close(); }
  });

  it("completes retention on retry after a failure or crash between the record and the transition", async () => {
    // Failure: the transition is unavailable after the record committed.
    const failed = await fixture(); try {
      let fail = true;
      failed.legacy.before = call => { if (call === "retain" && fail) { fail = false; throw new HostedProviderUnavailableError(new Error("synthetic")); } };
      const first = await failed.cut();
      expect(first.statusCode).toBe(503); expect(first.json().error.code).toBe("legacy_retention_pending");
      expect(await failed.recorded()).toBe(1); expect(failed.legacy.source.state).toBe("migrating");
      const retry = await failed.cut();
      expect(retry.statusCode, retry.body).toBe(200); expect(failed.legacy.source.state).toBe("migrated");
      expect(await failed.recorded()).toBe(1);
    } finally { await failed.app.close(); }
    // Crash: the process died after the record committed, before any transition.
    const crashed = await fixture(); try {
      await recordCollectionCutover(db, crashed.collection, facts);
      expect(crashed.legacy.source.state).toBe("migrating");
      const retry = await crashed.cut();
      expect(retry.statusCode, retry.body).toBe(200); expect(crashed.legacy.source.state).toBe("migrated");
    } finally { await crashed.app.close(); }
    // Lost reply: the transition landed but its response did not.
    const lost = await fixture(); try {
      const retain = lost.legacy.legacyMigrationRetain;
      let drop = true;
      lost.legacy.legacyMigrationRetain = async (...args) => {
        const result = await retain(...args);
        if (drop) { drop = false; throw new HostedProviderUnavailableError(new Error("lost reply")); }
        return result;
      };
      expect((await lost.cut()).json().error.code).toBe("legacy_retention_pending");
      expect(lost.legacy.source.state).toBe("migrated");
      const retry = await lost.cut();
      expect(retry.statusCode, retry.body).toBe(200); expect(await lost.recorded()).toBe(1);
    } finally { await lost.app.close(); }
  });

  it("surfaces a provider refusal or a replaced provider run instead of acknowledging retention", async () => {
    const refused = await fixture(); try {
      // New notification work appeared after the pre-read: the provider refuses.
      refused.legacy.before = call => { if (call === "retain") refused.legacy.source.in_flight = 1; };
      const result = await refused.cut();
      expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("legacy_retention_pending");
      expect(await refused.recorded()).toBe(1); expect(refused.legacy.source.state).toBe("migrating");
      refused.legacy.before = undefined; refused.legacy.source.in_flight = 0;
      expect((await refused.cut()).statusCode).toBe(200);
    } finally { await refused.app.close(); }
    const replaced = await fixture(); try {
      // Legacy was unfenced and fenced again between the pre-read and the transition.
      replaced.legacy.before = call => { if (call === "retain") replaced.legacy.source.migration_id = randomUUID(); };
      const result = await replaced.cut();
      expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_source_changed");
    } finally { await replaced.app.close(); }
  });
});
