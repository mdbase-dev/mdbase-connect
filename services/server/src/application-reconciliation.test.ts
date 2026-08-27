import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import type { RelayHub } from "./relay.js";
import {
  ApplicationReconciliationWorker,
  PERMANENT_QUARANTINE_ATTEMPTS,
  RECONCILIATION_TIMING
} from "./application-reconciliation.js";

const databases: DatabasePool[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((db) => db.end())); });
const relay = { pushPolicy: vi.fn(async () => undefined) } as unknown as RelayHub;
const timing = { ...RECONCILIATION_TIMING, leaseMs: 120, heartbeatMs: 20, closeMs: 10,
  retryBaseMs: 1, retryMaxMs: 2, quarantineProbeMs: 1_000, scanMs: 60_000 };

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
    const reconcile = vi.fn(async (_db, _relay, _provider, _application, grantId?: string) => {
      calls.set(grantId!, (calls.get(grantId!) ?? 0) + 1);
      if (grantId === deterministic) throw new TypeError("bad proof https://secret/id");
      if ((calls.get(grantId!) ?? 0) < 3) throw new Error("temporary body=secret");
    });
    const worker = new ApplicationReconciliationWorker(fixture.db, relay, undefined,
      (event) => events.push(event), 60_000, 60_000, reconcile, timing);
    await worker.seedMissingJobs();
    for (let i = 0; i < PERMANENT_QUARANTINE_ATTEMPTS; i += 1) {
      await worker.drainUntilIdle();
      await fixture.db.query("UPDATE application_reconciliation_results SET next_retry_at=now() WHERE status='retryable'");
      await fixture.db.query("UPDATE application_reconciliation_jobs SET state='pending',phase='retry',available_at=now(),next_scan_at=NULL WHERE application_id=$1", [fixture.applications[0]]);
    }
    const result = await fixture.db.query<{ status: string; next_retry_at: Date }>(
      "SELECT status,next_retry_at FROM application_reconciliation_results WHERE grant_id=$1", [deterministic]);
    expect(result.rows[0].status).toBe("quarantined");
    expect(result.rows[0].next_retry_at).toBeTruthy();
    const eventCount = events.length;
    await fixture.db.query("UPDATE application_reconciliation_results SET next_retry_at=now() WHERE grant_id=$1", [deterministic]);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET state='pending',phase='retry',available_at=now() WHERE application_id=$1", [fixture.applications[0]]);
    await worker.drainUntilIdle();
    expect(events).toHaveLength(eventCount);
    await fixture.db.query("UPDATE grants SET revoked_at=now() WHERE id=$1", [deterministic]);
    await fixture.db.query("UPDATE application_reconciliation_jobs SET state='pending',phase='scan',available_at=now() WHERE application_id=$1", [fixture.applications[0]]);
    await worker.drainUntilIdle();
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
