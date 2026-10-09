import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedAuthorityRegistry } from "../../hosted.js";
import { deleteAccountLocally, drainDeferredAccountDeletions } from "../../account-management.js";
import { createHostedCollectionForUser, deleteHostedCollectionForUser, renameHostedCollectionForUser } from "../hosted/service.js";
import { acceptCohortArchive, addToCohort, cohortArchiveBinding, createCohort, flipAccountBackend, flipEvidenceDigest, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";
import { requireAccountNotMigrationFrozen } from "./migration-topology.js";
import { recoverExpiredAuthorityTransfers } from "../authority-transfer/lifecycle.js";
import { recoverExpiredAuthorityAdoptions } from "../authority-adoption/adoption-store.js";
import { recoverAccountImportCancellation } from "../authority-transfer/account-cancellation.js";
import { audit } from "../../platform/audit-events.js";
import { ProviderRevocationWorker, quarantineMissingHostedCollection } from "../../hosted-capability-lifecycle.js";
import type { HostedProviderClient } from "../../hosted-provider.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const OP = "synthetic-local-pg";
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));

describePg("migration topology freeze (isolated real PostgreSQL; synthetic reference effects only)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string, databaseUrl: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_topology_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    databaseUrl = url.toString();
    db = await createDatabase(databaseUrl);
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function user() {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic')", [id, `${id}@example.test`]);
    return id;
  }
  async function batch(accounts: string[]) {
    const name = `b-${randomUUID().slice(0, 8)}`;
    await createCohort(db, name, OP);
    await addToCohort(db, name, accounts, OP);
    return name;
  }
  async function guard(...accounts: string[]) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await requireAccountNotMigrationFrozen(client, accounts[0]!, ...accounts.slice(1));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async function metadata(name: string) {
    const binding = await cohortArchiveBinding(db, name);
    const clock = new Date((await db.query("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0].now).toISOString();
    return { schema: "mdbase-recovery-set/v4", environment: "production", bucket: "synthetic-archives",
      prefix: `production/2026/10/08/${name}`, backup_id: name, complete_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64),
      source_commit: "c".repeat(40), migration_batch: binding, archive_created_at: clock, archive_completed_at: clock,
      retention: { mode: "GOVERNANCE", days: 120, retain_until: new Date(Date.parse(clock) + 120 * 86_400_000).toISOString(), inventory_digest: "d".repeat(64), count: "3" } };
  }

  it("allows unfrozen/nonmember accounts and refuses either frozen transfer owner without content", async () => {
    const a = await user(), b = await user(), left = await batch([a]), right = await batch([b]);
    await guard(a, b); await guard(b, a); await guard(await user());
    await setCohortFrozen(db, right, true, "capture", OP);
    for (const owners of [[a, b], [b, a]]) await expect(guard(...owners)).rejects.toMatchObject({ code: "migration_frozen", statusCode: 409, message: "Migration topology is frozen.", details: undefined });
    await setCohortFrozen(db, right, false, "cancel before acceptance", OP);
    await setCohortFrozen(db, left, true, "capture", OP);
    await expect(guard(a, b)).rejects.toMatchObject({ code: "migration_frozen" });
  });

  it("requires freeze before binding/capture, preserves freeze time, and permits read-only binding then audited unfreeze", async () => {
    const name = await batch([await user()]);
    await expect(cohortArchiveBinding(db, name)).rejects.toMatchObject({ code: "backup_missing" });
    const first = await setCohortFrozen(db, name, true, "capture", OP);
    expect(await setCohortFrozen(db, name, true, "retry", OP)).toEqual(first);
    expect(Object.keys(await cohortArchiveBinding(db, name)).sort()).toEqual(["batch_id", "membership_changed_at", "membership_digest", "membership_revision"]);
    expect(await setCohortFrozen(db, name, false, "cancel without acceptance", OP)).toEqual({ frozen_at: null });
    expect((await db.query("SELECT 1 FROM audit_events WHERE event_type='next_migration.unfreeze' AND metadata->>'cohort'=$1", [name])).rowCount).toBe(1);
  });

  it("refuses archive capture predating freeze and unfreeze after current-revision acceptance", async () => {
    const name = await batch([await user()]);
    const freeze = await setCohortFrozen(db, name, true, "capture", OP), body = await metadata(name);
    const earlier = new Date(Date.parse(freeze.frozen_at!) - 1).toISOString();
    await expect(acceptCohortArchive(db, name, { ...body, archive_created_at: earlier }, "production")).rejects.toMatchObject({ code: "backup_missing" });
    await acceptCohortArchive(db, name, body, "production");
    await expect(setCohortFrozen(db, name, false, "too late", OP)).rejects.toMatchObject({ code: "migration_frozen" });
    expect((await db.query("SELECT frozen_at FROM next_migration_cohorts WHERE name=$1", [name])).rows[0].frozen_at).not.toBeNull();
  });

  it("rereads frozen state after the parent lock wait instead of filtering the locked row away", async () => {
    const account = await user(), name = await batch([account]), freeze = await db.connect();
    await freeze.query("BEGIN");
    try {
      await freeze.query("UPDATE next_migration_cohorts SET frozen_at=now() WHERE name=$1", [name]);
      let settled = false;
      const mutation = guard(account).then(() => "allowed", (e: { code?: string }) => e.code).finally(() => { settled = true; });
      await delay(); expect(settled).toBe(false);
      await freeze.query("COMMIT");
      expect(await mutation).toBe("migration_frozen");
    } finally { await freeze.query("ROLLBACK").catch(() => undefined); freeze.release(); }
  });

  it("serializes absent-member assignment against the user guard and refuses joining a now-frozen cohort", async () => {
    const account = await user(), name = await batch([]), mutation = await db.connect();
    await mutation.query("BEGIN");
    try {
      await requireAccountNotMigrationFrozen(mutation, account);
      let settled = false;
      const assign = addToCohort(db, name, [account], OP).then(() => "added", (e: { code?: string }) => e.code).finally(() => { settled = true; });
      await delay(); expect(settled).toBe(false);
      await setCohortFrozen(db, name, true, "capture empty batch", OP);
      await mutation.query("COMMIT");
      expect(await assign).toBe("migration_frozen");
      expect((await db.query("SELECT 1 FROM next_migration_cohort_members WHERE account_id=$1", [account])).rowCount).toBe(0);
    } finally { await mutation.query("ROLLBACK").catch(() => undefined); mutation.release(); }
  });

  // Authorization is an input to this service; existing account route tests
  // qualify reauthentication. No fake session/enrolment/native proof is minted.
  const deletion = (account: string) => deleteAccountLocally(db, {
    userId: account, sessionId: randomUUID(), authorized: true, queueProviderCleanup: true
  });

  it("accepts frozen account deletion atomically, revokes credentials now, and erases only after the WHOLE batch final flip", async () => {
    const a = await user(), b = await user(), name = await batch([a, b]);
    await releaseCohort(db, name, OP);
    await setCohortFrozen(db, name, true, "capture", OP);
    const body = await metadata(name);
    await acceptCohortArchive(db, name, body, "production");
    await setPaused(db, false, "synthetic migration", OP);
    await deletion(a); await deletion(b);
    for (const account of [a, b]) {
      expect((await db.query("SELECT suspended_at FROM users WHERE id=$1", [account])).rows[0].suspended_at).not.toBeNull();
      const work = (await db.query("SELECT membership_revision::text,ready_at FROM next_migration_deferred_account_deletions WHERE account_id=$1", [account])).rows[0];
      expect(work.membership_revision).toBe(body.migration_batch.membership_revision); expect(work.ready_at).toBeNull();
      await startAccountMigration(db, account, "production");
    }
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs")).rowCount).toBe(0);
    await flipAccountBackend(db, a, [], flipEvidenceDigest([]));
    expect((await db.query("SELECT 1 FROM users WHERE id=ANY($1::uuid[])", [[a, b]])).rowCount).toBe(2);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    await flipAccountBackend(db, b, [], flipEvidenceDigest([]));
    expect((await db.query("SELECT 1 FROM users WHERE id=ANY($1::uuid[])", [[a, b]])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM next_migration_deferred_account_deletions WHERE cohort=$1", [name])).rowCount).toBe(0);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
  });

  it("never loses accepted deletion across restart after audited unfreeze/readiness commit and before erasure", async () => {
    const account = await user(), name = await batch([account]);
    await setCohortFrozen(db, name, true, "capture", OP);
    await deletion(account);
    const connect = db.connect.bind(db);
    const fault = vi.spyOn(db, "connect").mockImplementationOnce(connect).mockRejectedValueOnce(new Error("synthetic interruption after readiness commit"));
    try {
      await expect(setCohortFrozen(db, name, false, "cancel before acceptance", OP)).rejects.toThrow("synthetic interruption");
    } finally { fault.mockRestore(); }
    const work = (await db.query("SELECT ready_at,ready_revision::text FROM next_migration_deferred_account_deletions WHERE account_id=$1", [account])).rows[0];
    expect(work.ready_at).not.toBeNull(); expect(work.ready_revision).not.toBeNull();
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [account])).rowCount).toBe(1);
    await db.end(); db = await createDatabase(databaseUrl);
    expect(await drainDeferredAccountDeletions(db)).toBe(1);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [account])).rowCount).toBe(0);
  });

  it("keeps account deletion outside a freeze immediate, with no deferred work", async () => {
    const account = await user(); await batch([account]);
    await deletion(account);
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [account])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM next_migration_deferred_account_deletions WHERE account_id=$1", [account])).rowCount).toBe(0);
  });

  it("blocks rename/delete before effects during freeze and permits them after audited unfreeze", async () => {
    const account = await user(), name = await batch([account]);
    const reference = new HostedAuthorityRegistry(db), options = { db, hostedCollections: true };
    const collection = await createHostedCollectionForUser(options, reference, "https://synthetic.example.test", account, "Before", "mdbase", "UTC");
    const erase = vi.spyOn(reference, "delete");
    await setCohortFrozen(db, name, true, "capture", OP);
    await expect(renameHostedCollectionForUser(options, account, collection.id, "After")).rejects.toMatchObject({ code: "migration_frozen" });
    await expect(deleteHostedCollectionForUser(options, reference, account, collection.id)).rejects.toMatchObject({ code: "migration_frozen" });
    expect(erase).not.toHaveBeenCalled();
    expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1", [collection.id])).rows[0].display_name).toBe("Before");
    await setCohortFrozen(db, name, false, "cancel before acceptance", OP);
    expect(await renameHostedCollectionForUser(options, account, collection.id, "After")).toMatchObject({ display_name: "After" });
    expect(await deleteHostedCollectionForUser(options, reference, account, collection.id, "account")).toBe(true);
    expect(erase).toHaveBeenCalledTimes(1);
    expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [collection.id])).rowCount).toBe(0);
  });

  async function transferFixture(direction: "to_hosted" | "to_local") {
    const account = await user(), name = await batch([account]);
    const connector = randomUUID(), local = randomUUID(), hosted = randomUUID(), transfer = randomUUID();
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Synthetic',$3)", [connector, account, randomUUID()]);
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,authority_state) VALUES($1,$2,$3,$4,'Synthetic','0.3.0',$5)",
      [local, account, connector, hosted, direction === "to_hosted" ? "active" : "candidate"]);
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state,authority_epoch) VALUES($1,$2,'Synthetic','mdbase',$3,$4)",
      [hosted, account, direction === "to_hosted" ? "importing" : "transferring", direction === "to_hosted" ? 2 : 1]);
    await db.query("INSERT INTO authority_transfers(id,user_id,hosted_collection_id,local_collection_id,direction,state,expires_at,next_authority_epoch,final_head,manifest_digest) VALUES($1,$2,$3,$4,$5,'prepared',now()-interval '1 hour',2,0,$6)",
      [transfer, account, hosted, local, direction, "e".repeat(64)]);
    return { account, name, connector, local, hosted, transfer };
  }

  it.each(["to_hosted", "to_local"] as const)("leaves frozen %s expiry pending with no provider effects, then resumes after unfreeze", async (direction) => {
    const f = await transferFixture(direction);
    const expire = vi.fn(async () => undefined), provider = { expireAuthorityImport: expire, expireAuthorityTransfer: expire } as unknown as HostedProviderClient;
    await setCohortFrozen(db, f.name, true, "capture", OP);
    await recoverExpiredAuthorityTransfers(db, provider, undefined, f.hosted);
    expect(expire).not.toHaveBeenCalled();
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.transfer])).rows[0].state).toBe("prepared");
    await setCohortFrozen(db, f.name, false, "cancel before acceptance", OP);
    await recoverExpiredAuthorityTransfers(db, provider, undefined, f.hosted);
    expect(expire).toHaveBeenCalledOnce();
    expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [f.hosted])).rows).toEqual(direction === "to_hosted" ? [] : [{ authority_state: "active" }]);
  });

  it("reference transport reads cannot restore an expired transfer while frozen", async () => {
    const f = await transferFixture("to_local"), reference = new HostedAuthorityRegistry(db);
    const transport = await reference.transport(f.hosted, randomUUID());
    await setCohortFrozen(db, f.name, true, "capture", OP);
    await expect(transport.openSession()).rejects.toMatchObject({ code: "authority_transfer_in_progress" });
    expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [f.hosted])).rows[0].authority_state).toBe("transferring");
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.transfer])).rows[0].state).toBe("prepared");
    await setCohortFrozen(db, f.name, false, "cancel before acceptance", OP);
    // The reference authority is intentionally absent: recovery still restores
    // topology before the normal read reports the missing reference data.
    await expect(transport.openSession()).rejects.toMatchObject({ code: "hosted_collection_not_found" });
    expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [f.hosted])).rows[0].authority_state).toBe("active");
  });

  it("defers adoption expiry on GET/scheduler recovery through provider abort and cleanup", async () => {
    const account = await user(), name = await batch([account]), hosted = randomUUID(), adoption = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template,authority_state,authority_epoch) VALUES($1,$2,'Synthetic','mdbase','importing',2)", [hosted, account]);
    await db.query("INSERT INTO authority_adoption_requests(id,secret_hash,collection_id,display_name,source_name,user_id,state,expires_at) VALUES($1,$2,$3,'Synthetic','Synthetic',$4,'prepared',now()-interval '1 hour')", [adoption, randomUUID(), hosted, account]);
    const abort = vi.fn(async () => undefined), provider = { abortAuthorityImport: abort } as unknown as HostedProviderClient;
    await setCohortFrozen(db, name, true, "capture", OP);
    await recoverExpiredAuthorityAdoptions(db, provider);
    expect(abort).not.toHaveBeenCalled();
    expect((await db.query("SELECT state,cleanup_completed FROM authority_adoption_requests WHERE id=$1", [adoption])).rows[0]).toEqual({ state: "prepared", cleanup_completed: false });
    await setCohortFrozen(db, name, false, "cancel before acceptance", OP);
    await recoverExpiredAuthorityAdoptions(db, provider);
    expect(abort).toHaveBeenCalledWith(adoption);
    expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [hosted])).rowCount).toBe(0);
    expect((await db.query("SELECT state,cleanup_completed FROM authority_adoption_requests WHERE id=$1", [adoption])).rows[0]).toEqual({ state: "expired", cleanup_completed: true });
  });

  it("blocks account-cancellation recovery before provider fencing, including historical missing targets", async () => {
    const f = await transferFixture("to_hosted");
    await audit(db, f.account, "authority_transfer.requested", f.transfer, { connector_id: f.connector, collection_id: f.hosted, direction: "to_hosted", authority_epoch: 2 });
    const fence = vi.fn(async () => undefined), provider = { reconcileAuthorityImportCancellation: fence } as unknown as HostedProviderClient;
    await setCohortFrozen(db, f.name, true, "capture", OP);
    const current = { id: f.connector, user_id: f.account };
    await expect(recoverAccountImportCancellation(db, provider, current, f.transfer)).rejects.toMatchObject({ code: "migration_frozen" });
    expect(fence).not.toHaveBeenCalled();
    await setCohortFrozen(db, f.name, false, "cancel before acceptance", OP);
    expect(await recoverAccountImportCancellation(db, provider, current, f.transfer)).toBe(true);
    expect(fence).toHaveBeenCalledOnce();
    await setCohortFrozen(db, f.name, true, "second capture", OP);
    await expect(recoverAccountImportCancellation(db, provider, current, f.transfer)).rejects.toMatchObject({ code: "migration_frozen" });
    expect(fence).toHaveBeenCalledOnce();
  });

  it("fences quarantine and preexisting provider deletion jobs for the actual frozen owner", async () => {
    const account = await user(), name = await batch([account]), reference = new HostedAuthorityRegistry(db);
    const collection = await createHostedCollectionForUser({ db, hostedCollections: true }, reference, "https://synthetic.example.test", account, "Synthetic", "mdbase", "UTC");
    const job = randomUUID();
    await db.query("INSERT INTO provider_collection_deletion_jobs(id,collection_id,reason) VALUES($1,$2,'account_deletion')", [job, collection.id]);
    const erase = vi.fn(async () => undefined), worker = new ProviderRevocationWorker(db, { deleteCollection: erase } as unknown as HostedProviderClient);
    await setCohortFrozen(db, name, true, "capture", OP);
    await expect(quarantineMissingHostedCollection(db, String(collection.id))).rejects.toMatchObject({ code: "migration_frozen" });
    expect(await worker.drain()).toBe(0); expect(erase).not.toHaveBeenCalled();
    expect((await db.query("SELECT quarantined_at FROM hosted_collections WHERE id=$1", [collection.id])).rows[0].quarantined_at).toBeNull();
    expect((await db.query("SELECT completed_at FROM provider_collection_deletion_jobs WHERE id=$1", [job])).rows[0].completed_at).toBeNull();
    await setCohortFrozen(db, name, false, "cancel before acceptance", OP);
    await db.query("UPDATE provider_collection_deletion_jobs SET available_at=now() WHERE id=$1", [job]);
    expect(await worker.drain()).toBe(1); expect(erase).toHaveBeenCalledWith(collection.id);
    expect(await quarantineMissingHostedCollection(db, String(collection.id))).toMatchObject({ changed: true });
  });

  it("serializes two actual creates and a freeze before effects without a parent-lock upgrade deadlock", async () => {
    const a = await user(), b = await user(), name = await batch([a, b]);
    const reference = new HostedAuthorityRegistry(db), actualCreate = reference.create.bind(reference);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let effects = 0;
    const create = vi.spyOn(reference, "create").mockImplementation(async (...args) => {
      effects += 1;
      if (effects === 1) { entered(); await gate; }
      await actualCreate(...args);
    });
    const cleanup = vi.spyOn(reference, "delete");
    const options = { db, hostedCollections: true };
    const first = createHostedCollectionForUser(options, reference, "https://synthetic.example.test", a, "A", "mdbase", "UTC");
    await started;
    const second = createHostedCollectionForUser(options, reference, "https://synthetic.example.test", b, "B", "mdbase", "UTC");
    let frozen = false;
    const freeze = setCohortFrozen(db, name, true, "capture", OP).then((r) => { frozen = true; return r; });
    try {
      await delay(); expect(effects).toBe(1); expect(frozen).toBe(false);
    } finally { release(); }
    const [one, two, stopped] = await Promise.allSettled([first, second, freeze]);
    expect(one.status).toBe("fulfilled"); expect(stopped.status).toBe("fulfilled");
    if (two.status === "rejected") expect(two.reason).toMatchObject({ code: "migration_frozen" });
    else expect(two.value).toMatchObject({ display_name: "B" });
    expect((await db.query("SELECT 1 FROM hosted_collections WHERE user_id=ANY($1::uuid[])", [[a, b]])).rowCount).toBe(two.status === "fulfilled" ? 2 : 1);
    const before = effects;
    await expect(createHostedCollectionForUser(options, reference, "https://synthetic.example.test", a, "refused", "mdbase", "UTC")).rejects.toMatchObject({ code: "migration_frozen", statusCode: 409 });
    expect(effects).toBe(before); expect(cleanup).not.toHaveBeenCalled();
    create.mockRestore(); cleanup.mockRestore();
  });
});
