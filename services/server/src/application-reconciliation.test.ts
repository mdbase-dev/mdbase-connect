import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationAuthorizationError,
  MalformedPersistedApplicationAuthorizationError
} from "./application-authorization.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { HostedProviderUnavailableError } from "./hosted-provider.js";
import type { RelayHub } from "./relay.js";
import {
  ApplicationReconciliationWorker,
  PERMANENT_QUARANTINE_ATTEMPTS,
  RECONCILIATION_TIMING,
  ensureApplicationReconciliation,
  classifyError
} from "./application-reconciliation.js";

const databases: DatabasePool[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.end())); });
const relay = { pushPolicy: vi.fn(async () => undefined) } as unknown as RelayHub;
const timing = { ...RECONCILIATION_TIMING, leaseMs: 120, heartbeatMs: 20, closeMs: 10,
  retryBaseMs: 1, retryMaxMs: 2, quarantineProbeMs: 60_000, scanMs: 60_000 };

describe("application reconciliation worker", () => {
  it("isolates exact applications and advances 49/50/51/exact pages without replaying successes", async () => {
    for (const count of [49, 50, 51, 100]) {
      const fixture = await makeFixture([count, 1]);
      const successful = new Set<string>();
      const failed = fixture.grants[0][0];
      let failOnce = true;
      const reconcile = vi.fn(async (_db, _relay, _provider, application, grantId?: string) => {
        if (grantId === failed && failOnce) { failOnce = false; throw new Error("transient"); }
        successful.add(`${application.id}:${grantId}`);
      });
      const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
        60_000, 60_000, reconcile, timing);
      await worker.seedMissingJobs();
      await worker.drainUntilIdle();
      expect(successful.size).toBe(count + 1);
      expect(reconcile.mock.calls.filter((call) => call[4] === fixture.grants[1][0])).toHaveLength(1);
      expect(reconcile.mock.calls.filter((call) => call[4] !== failed)).toHaveLength(count);
      const jobs = await fixture.db.query<{ state: string; cursor_grant_id: string | null }>(
        "SELECT state,cursor_grant_id FROM application_reconciliation_jobs");
      expect(jobs.rows.every((job) => job.state === "completed" && job.cursor_grant_id === null)).toBe(true);
    }
  }, 30_000);

  it("caps transient retries, quarantines deterministic failures, quietly probes, and clears inactive results", async () => {
    const fixture = await makeFixture([2]);
    const events: unknown[] = [];
    const deterministic = fixture.grants[0][0];
    const transient = fixture.grants[0][1];
    const calls = new Map<string, number>();
    let deterministicFails = true;
    const reconcile = vi.fn(async (_db, _relay, _provider, _application, grantId?: string) => {
      calls.set(grantId!, (calls.get(grantId!) ?? 0) + 1);
      if (grantId === deterministic && deterministicFails) {
        throw new MalformedPersistedApplicationAuthorizationError();
      }
      if (grantId === transient && (calls.get(grantId!) ?? 0) < 3) throw new Error("temporary body=secret");
    });
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined,
      (event) => events.push(event), 60_000, 60_000, reconcile, timing);
    await worker.seedMissingJobs();
    for (let i = 0; i < PERMANENT_QUARANTINE_ATTEMPTS; i += 1) {
      await worker.drainUntilIdle();
      if (i < PERMANENT_QUARANTINE_ATTEMPTS - 1) {
        await fixture.db.query("UPDATE application_reconciliation_results SET next_retry_at=now() WHERE status='retryable'");
        await fixture.db.query("UPDATE application_reconciliation_jobs SET state='pending',phase='retry',available_at=now(),next_scan_at=NULL WHERE application_id=$1", [fixture.applications[0]]);
      }
    }
    const result = await fixture.db.query<{ status: string; next_retry_at: Date }>(
      "SELECT status,next_retry_at FROM application_reconciliation_results WHERE grant_id=$1", [deterministic]);
    expect(result.rows[0].status).toBe("quarantined");
    expect(result.rows[0].next_retry_at).toBeTruthy();
    expect((await fixture.db.query<{ state: string }>("SELECT state FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows[0].state).toBe("completed");

    // An ordinary scan before the quiet probe skips A but discovers a later grant B.
    const laterGrant = randomUUID();
    await fixture.db.query(`INSERT INTO grants (id,user_id,application_id,hosted_collection_id,operations)
      SELECT $1,user_id,application_id,hosted_collection_id,'["query"]'::jsonb FROM grants WHERE id=$2`, [laterGrant, deterministic]);
    const aCalls = calls.get(deterministic);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET next_scan_at=now(),available_at=now() WHERE application_id=$1", [fixture.applications[0]]);
    await worker.seedMissingJobs(); await worker.drainUntilIdle();
    expect(calls.get(deterministic)).toBe(aCalls);
    expect(calls.get(laterGrant)).toBe(1);
    expect((await fixture.db.query<{ state: string }>("SELECT state FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows[0].state).toBe("completed");

    // A due weekly probe runs immediately after the scan, then fails quietly and completes again.
    const eventCount = events.length;
    await fixture.db.query("UPDATE application_reconciliation_results SET next_retry_at=now() WHERE grant_id=$1", [deterministic]);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET next_scan_at=now(),available_at=now() WHERE application_id=$1", [fixture.applications[0]]);
    await worker.seedMissingJobs(); await worker.drainUntilIdle();
    expect(calls.get(deterministic)).toBe(aCalls! + 1);
    expect(events).toHaveLength(eventCount);
    expect((await fixture.db.query<{ state: string }>("SELECT state FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows[0].state).toBe("completed");

    deterministicFails = false;
    await fixture.db.query("UPDATE application_reconciliation_results SET next_retry_at=now() WHERE grant_id=$1", [deterministic]);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET next_scan_at=now(),available_at=now() WHERE application_id=$1", [fixture.applications[0]]);
    await worker.seedMissingJobs(); await worker.drainUntilIdle();
    expect((await fixture.db.query("SELECT 1 FROM application_reconciliation_results WHERE grant_id=$1", [deterministic])).rows).toEqual([]);
  });

  it("heartbeats across the original lease, prevents a second owner, and bounded close stops renewal", async () => {
    const fixture = await makeFixture([1]);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    let active = 0; let peak = 0;
    const reconcile = vi.fn(async () => { active += 1; peak = Math.max(peak, active); await deferred; active -= 1; });
    const first = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
      60_000, 60_000, reconcile, timing);
    const second = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
      60_000, 60_000, reconcile, timing);
    await first.seedMissingJobs();
    const running = first.drain();
    await wait(170);
    await second.drain();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(peak).toBe(1);
    const before = Date.now();
    await first.close();
    expect(Date.now() - before).toBeLessThan(80);
    const expiry = (await fixture.db.query<{ lease_expires_at: Date }>(
      "SELECT lease_expires_at FROM application_reconciliation_jobs")).rows[0].lease_expires_at.getTime();
    await wait(50);
    const unchanged = (await fixture.db.query<{ lease_expires_at: Date }>(
      "SELECT lease_expires_at FROM application_reconciliation_jobs")).rows[0].lease_expires_at.getTime();
    expect(unchanged).toBe(expiry);
    release(); await running;
  });

  it("recovers an expired lease and serializes simultaneous local drains", async () => {
    const fixture = await makeFixture([1]);
    await fixture.db.query(`INSERT INTO application_reconciliation_jobs
      (application_id,state,phase,lease_token,lease_expires_at) VALUES ($1,'leased','scan',$2,now()-interval '1 second')`,
    [fixture.applications[0], randomUUID()]);
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let active = 0; let peak = 0;
    const reconcile = vi.fn(async () => { active += 1; peak = Math.max(peak, active); started(); await blocked; active -= 1; });
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
      60_000, 60_000, reconcile, timing);
    const first = worker.drain(); const second = worker.drain();
    await entered;
    expect(reconcile).toHaveBeenCalledOnce(); expect(peak).toBe(1);
    release(); await Promise.all([first, second]);
    expect((await fixture.db.query<{ attempts: number; state: string }>("SELECT attempts,state FROM application_reconciliation_jobs")).rows[0])
      .toMatchObject({ attempts: 1, state: "completed" });
  });

  it("emits only closed fields and repeated ensure never resets job state", async () => {
    const fixture = await makeFixture([1]); const events: unknown[] = [];
    const error = Object.assign(new Error("body secret"), { url: "https://secret", applicationId: randomUUID(), body: "secret" });
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined, (event) => events.push(event),
      60_000, 60_000, async () => { throw error; }, timing);
    await worker.seedMissingJobs();
    await fixture.db.query(`UPDATE application_reconciliation_jobs SET state='completed',phase='scan',
      available_at=now()+interval '1 day',next_scan_at=now()+interval '1 day',attempts=7 WHERE application_id=$1`, [fixture.applications[0]]);
    const before = (await fixture.db.query("SELECT * FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows[0];
    await Promise.all([ensureApplicationReconciliation(fixture.db, fixture.applications[0]), ensureApplicationReconciliation(fixture.db, fixture.applications[0])]);
    const after = (await fixture.db.query("SELECT * FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows[0];
    expect(after).toEqual(before);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET state='pending',available_at=now(),next_scan_at=NULL WHERE application_id=$1", [fixture.applications[0]]);
    await worker.drain();
    expect(events).toEqual([{ phase: "scan", errorClass: "internal" }]);
    expect(Object.keys(events[0] as object).sort()).toEqual(["errorClass", "phase"]);
  });

  it("uses consecutive same-class failures and keeps arbitrary type errors internal", async () => {
    expect(classifyError(new TypeError("bug"))).toBe("internal");
    const fixture = await makeFixture([1]);
    const errors = [new HostedProviderUnavailableError(new Error()),
      new HostedProviderUnavailableError(new Error()),
      new ApplicationAuthorizationError(), new MalformedPersistedApplicationAuthorizationError(),
      new ApplicationAuthorizationError()];
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
      60_000, 60_000, async () => { throw errors.shift()!; }, timing);
    await worker.seedMissingJobs();
    for (let index = 0; index < 5; index += 1) {
      await worker.drain();
      const row = (await fixture.db.query<{ error_class: string; consecutive_attempts: number; status: string }>(
        "SELECT error_class,consecutive_attempts,status FROM application_reconciliation_results")).rows[0];
      if (index === 2) expect(row).toMatchObject({ error_class: "ownership", consecutive_attempts: 1, status: "retryable" });
      if (index === 4) expect(row).toMatchObject({ error_class: "ownership", consecutive_attempts: 1, status: "retryable" });
      await fixture.db.query("UPDATE application_reconciliation_results SET next_retry_at=now()");
      await fixture.db.query("UPDATE application_reconciliation_jobs SET state='pending',phase='retry',available_at=now() WHERE application_id=$1", [fixture.applications[0]]);
    }
  });

  it("claims due completed scans on the ordinary poll without a seed call", async () => {
    const fixture = await makeFixture([1]); const reconcile = vi.fn(async () => undefined);
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
      60_000, 6 * 60 * 60_000, reconcile, { ...timing, scanMs: 5 });
    await worker.seedMissingJobs(); await worker.drain();
    reconcile.mockClear(); await wait(10); await worker.drain();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("rejects a reconciliation result paired with another application's grant", async () => {
    const fixture = await makeFixture([1, 1]);
    await expect(fixture.db.query(`INSERT INTO application_reconciliation_results
      (application_id,grant_id,status,error_class,consecutive_attempts,next_retry_at)
      VALUES ($1,$2,'retryable','internal',1,now())`,
    [fixture.applications[0], fixture.grants[1][0]])).rejects.toThrow();
  });

  it("seeds missing jobs, wakes due scans, coalesces registration, and fairly services a small app", async () => {
    const fixture = await makeFixture([60, 1]);
    const order: string[] = [];
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined, () => undefined,
      60_000, 60_000, async (_db, _relay, _provider, app) => { order.push(app.id); }, timing);
    await worker.seedMissingJobs();
    await worker.drainUntilIdle();
    expect(order.indexOf(fixture.applications[1])).toBeLessThan(51);
    await fixture.db.query("DELETE FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]]);
    await worker.seedMissingJobs();
    expect((await fixture.db.query("SELECT 1 FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows).toHaveLength(1);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET state='completed',next_scan_at=now()-interval '1 second',available_at=now()-interval '1 second' WHERE application_id=$1", [fixture.applications[0]]);
    await worker.seedMissingJobs();
    expect((await fixture.db.query<{ state: string }>("SELECT state FROM application_reconciliation_jobs WHERE application_id=$1", [fixture.applications[0]])).rows[0].state).toBe("pending");
  });
});

async function makeFixture(counts: number[]) {
  const db = await createDatabase("memory"); databases.push(db);
  const applications: string[] = []; const grants: string[][] = [];
  const user = randomUUID();
  await db.query("INSERT INTO users (id,email,name) VALUES ($1,$2,'Worker test')", [user, `${user}@example.com`]);
  const collection = randomUUID();
  await db.query("INSERT INTO hosted_collections (id,user_id,display_name,template) VALUES ($1,$2,'Worker collection','mdbase')", [collection, user]);
  for (const count of counts) {
    const app = randomUUID(); applications.push(app);
    await db.query(`INSERT INTO applications (id,canonical_identity,family_identity,name,homepage,redirect_uris,requirements,notifications,manifest_digest)
      VALUES ($1,$2,$3,'Worker app','https://example.com','[]','{"contracts":[]}','{"criteria":[]}',$4)`,
    [app, `https://example.com/${app}`, `bundle:${app}`, "a".repeat(64)]);
    const ids: string[] = []; grants.push(ids);
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID(); ids.push(id);
      await db.query(`INSERT INTO grants (id,user_id,application_id,hosted_collection_id,operations)
        VALUES ($1,$2,$3,$4,'["query"]')`, [id, user, app, collection]);
    }
  }
  return { db, applications, grants };
}
function wait(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }
