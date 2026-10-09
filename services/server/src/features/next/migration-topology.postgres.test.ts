import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedAuthorityRegistry } from "../../hosted.js";
import { deleteAccountLocally, drainDeferredAccountDeletions } from "../../account-management.js";
import { createHostedCollectionForUser, deleteHostedCollectionForUser, renameHostedCollectionForUser } from "../hosted/service.js";
import { acceptCohortArchive, accountMigrationView, addToCohort, cohortArchiveBinding, createCohort, flipAccountBackend, flipEvidenceDigest, migrationCandidates, migrationsInProgress, recordCollectionCutover, releaseCohort, setCohortFrozen, setPaused, startAccountMigration } from "./migration-rollout.js";
import { requireAccountNotMigrationFrozen } from "./migration-topology.js";
import { recoverExpiredAuthorityTransfers } from "../authority-transfer/lifecycle.js";
import { recoverExpiredAuthorityAdoptions } from "../authority-adoption/adoption-store.js";
import { recoverAccountImportCancellation } from "../authority-transfer/account-cancellation.js";
import { audit } from "../../platform/audit-events.js";
import { ProviderRevocationWorker, quarantineMissingHostedCollection, quarantineMissingHostedCollectionOnTransaction } from "../../hosted-capability-lifecycle.js";
import { HostedProviderClient, HostedProviderResponseError, HostedProviderUnavailableError } from "../../hosted-provider.js";
import { materializePublicSignupEntitlement, reconcileHostedAccountCollections } from "../../entitlements.js";

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
      retention: { mode: "GOVERNANCE", days: 116, retain_until: new Date(Date.parse(clock) + 116 * 86_400_000).toISOString(), inventory_digest: "d".repeat(64), count: "3" } };
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

  async function hosted(account: string) {
    return createHostedCollectionForUser({ db, hostedCollections: true }, new HostedAuthorityRegistry(db), "https://synthetic.example.test", account, "Synthetic", "mdbase", "UTC");
  }
  async function acceptedBatch(accounts: string[]) {
    const name = await batch(accounts);
    await releaseCohort(db, name, OP);
    await setCohortFrozen(db, name, true, "capture", OP);
    const body = await metadata(name);
    await acceptCohortArchive(db, name, body, "production");
    await setPaused(db, false, "synthetic migration", OP);
    return { name, body };
  }
  async function assertNeverMigrated(account: string, collections: string[] = []) {
    expect((await db.query("SELECT 1 FROM audit_events WHERE subject_id=ANY($1::text[]) AND event_type IN ('next_migration.cutover','next_migration.flip')", [[account, ...collections]])).rowCount).toBe(0);
  }

  it("terminal-excludes a nonempty hosted account without altering archive coverage, then completes the batch without its witness/cutover/flip across restart", async () => {
    const a = await user(), b = await user(), collection = await hosted(a);
    const { name, body } = await acceptedBatch([a, b]);
    await startAccountMigration(db, a, "production");
    await startAccountMigration(db, b, "production");
    await deletion(a);
    expect(await cohortArchiveBinding(db, name)).toEqual(body.migration_batch);
    expect(await accountMigrationView(db, a)).toMatchObject({ backend: "legacy", terminal_excluded: true, hosted_collections: [collection.id] });
    expect(await migrationsInProgress(db, 100)).not.toContain(a);
    expect(await migrationCandidates(db, 100)).not.toContain(a);
    await expect(startAccountMigration(db, a, "production")).rejects.toMatchObject({ code: "account_deletion_accepted" });
    await expect(recordCollectionCutover(db, collection.id, { s_final: 3, cutover_seq: 10, barrier_f: 10, final_digest: "a".repeat(64) })).rejects.toMatchObject({ code: "account_deletion_accepted" });
    await expect(flipAccountBackend(db, a, [collection.id], flipEvidenceDigest([]))).rejects.toMatchObject({ code: "account_deletion_accepted" });
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [collection.id])).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id])).rowCount).toBe(0);
    const connect = db.connect.bind(db);
    const fault = vi.spyOn(db, "connect").mockImplementationOnce(connect).mockRejectedValueOnce(new Error("synthetic interruption after batch completion"));
    try {
      await expect(flipAccountBackend(db, b, [], flipEvidenceDigest([]))).rejects.toThrow("synthetic interruption");
    } finally { fault.mockRestore(); }
    const work = (await db.query("SELECT ready_at,ready_revision::text FROM next_migration_deferred_account_deletions WHERE account_id=$1", [a])).rows[0];
    expect(work.ready_at).not.toBeNull(); expect(work.ready_revision).toBe(body.migration_batch.membership_revision);
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [a])).rows[0].account_backend).toBe("legacy");
    expect((await db.query("SELECT account_backend FROM users WHERE id=$1", [b])).rows[0].account_backend).toBe("next");
    expect(await cohortArchiveBinding(db, name)).toEqual(body.migration_batch);
    await assertNeverMigrated(a, [collection.id]);
    await db.end(); db = await createDatabase(databaseUrl);
    expect(await drainDeferredAccountDeletions(db)).toBe(1);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [a])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [collection.id])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id])).rowCount).toBe(1);
    await db.query("DELETE FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id]);
  });

  it("makes the last unfinished member's terminal exclusion ready without a future flip or user retry", async () => {
    const a = await user(), b = await user(), collection = await hosted(a);
    const { name, body } = await acceptedBatch([a, b]);
    await startAccountMigration(db, b, "production");
    await flipAccountBackend(db, b, [], flipEvidenceDigest([]));
    await deletion(a); // Never started: even discovery/start must exclude it.
    expect(await cohortArchiveBinding(db, name)).toEqual(body.migration_batch);
    expect(await migrationCandidates(db, 100)).not.toContain(a);
    expect((await db.query("SELECT ready_at FROM next_migration_deferred_account_deletions WHERE account_id=$1", [a])).rows[0].ready_at).not.toBeNull();
    await assertNeverMigrated(a, [collection.id]);
    await db.end(); db = await createDatabase(databaseUrl);
    expect(await drainDeferredAccountDeletions(db)).toBe(1);
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [a])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id])).rowCount).toBe(1);
    await db.query("DELETE FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id]);
  });

  it("completes an all-terminal batch after archive acceptance without starting or flipping any member", async () => {
    const a = await user(), b = await user(), ca = await hosted(a), cb = await hosted(b), name = await batch([a, b]);
    await setCohortFrozen(db, name, true, "capture", OP);
    const body = await metadata(name);
    await deletion(a); await deletion(b);
    expect(await cohortArchiveBinding(db, name)).toEqual(body.migration_batch);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    await acceptCohortArchive(db, name, body, "production");
    for (const account of [a, b]) {
      expect((await db.query("SELECT 1 FROM users WHERE id=$1", [account])).rowCount).toBe(0);
      await assertNeverMigrated(account, [account === a ? ca.id : cb.id]);
    }
    const accepted = (await db.query("SELECT verified_result FROM next_migration_archive_acceptances WHERE cohort=$1", [name])).rows[0];
    expect(accepted.verified_result.migration_batch).toEqual(body.migration_batch);
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs WHERE collection_id=ANY($1::uuid[])", [[ca.id, cb.id]])).rowCount).toBe(2);
    await db.query("DELETE FROM provider_collection_deletion_jobs WHERE collection_id=ANY($1::uuid[])", [[ca.id, cb.id]]);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
  });

  it("accepts deletion after the whole batch's final flip and makes erasure ready despite the retained freeze", async () => {
    const excluded = await user(), collection = await hosted(excluded), account = await user();
    const { name, body } = await acceptedBatch([excluded, account]);
    await deletion(excluded);
    await startAccountMigration(db, account, "production");
    await flipAccountBackend(db, account, [], flipEvidenceDigest([]));
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [excluded])).rowCount).toBe(0);
    const batchState = (await db.query("SELECT frozen_at,completed_at,completed_revision::text,membership_revision::text FROM next_migration_cohorts WHERE name=$1", [name])).rows[0];
    expect(batchState.frozen_at).not.toBeNull(); expect(batchState.completed_at).not.toBeNull();
    expect(batchState.completed_revision).toBe(body.migration_batch.membership_revision);
    expect(BigInt(batchState.membership_revision)).toBeGreaterThan(BigInt(batchState.completed_revision));
    await db.end(); db = await createDatabase(databaseUrl);
    await deletion(account);
    expect((await db.query("SELECT ready_at FROM next_migration_deferred_account_deletions WHERE account_id=$1", [account])).rows[0].ready_at).not.toBeNull();
    expect(await drainDeferredAccountDeletions(db)).toBe(1);
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [account])).rowCount).toBe(0);
    await db.query("DELETE FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id]);
    await setCohortFrozen(db, name, false, "completed archive revision changed by terminal erasure", OP);
    const next = await user(); await addToCohort(db, name, [next], OP);
    await setCohortFrozen(db, name, true, "new window must not inherit completion", OP);
    expect((await db.query("SELECT completed_at,completed_revision FROM next_migration_cohorts WHERE name=$1", [name])).rows[0]).toEqual({ completed_at: null, completed_revision: null });
    await deletion(next);
    expect(await drainDeferredAccountDeletions(db)).toBe(0);
    await setCohortFrozen(db, name, false, "cancel new window before archive acceptance", OP);
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
    await expect(setCohortFrozen(db, name, true, "must wait for automatic erasure", OP)).rejects.toMatchObject({ code: "busy" });
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

  it("atomically revokes existing sessions, connectors, grants and replica tokens while preserving frozen hosted topology", async () => {
    const account = await user(), name = await batch([account]), reference = new HostedAuthorityRegistry(db);
    const collection = await createHostedCollectionForUser({ db, hostedCollections: true }, reference, "https://synthetic.example.test", account, "Synthetic", "mdbase", "UTC");
    const session = randomUUID(), connector = randomUUID(), application = randomUUID(), replica = randomUUID(), grant = randomUUID();
    await db.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [session, account, randomUUID()]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Synthetic',$3)", [connector, account, randomUUID()]);
    await db.query("INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'Synthetic','https://synthetic.example.test','[]'::jsonb)", [application, `bundle:synthetic:${application}`]);
    await db.query("INSERT INTO hosted_replicas(id,collection_id,authorized_user_id,name,purpose,mode,token_hash) VALUES($1,$2,$3,'Synthetic','application','read_write',$4)", [replica, collection.id, account, randomUUID()]);
    await db.query("INSERT INTO grants(id,user_id,application_id,hosted_collection_id,hosted_replica_id,operations) VALUES($1,$2,$3,$4,$5,'[\"query\"]'::jsonb)", [grant, account, application, collection.id, replica]);
    for (const table of ["access_tokens", "refresh_tokens"]) await db.query(`INSERT INTO ${table}(id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')`, [randomUUID(), randomUUID(), grant]);
    await setCohortFrozen(db, name, true, "capture", OP);
    await deleteAccountLocally(db, { userId: account, sessionId: session, authorized: true, queueProviderCleanup: true });
    for (const [table, id] of [["sessions", session], ["connectors", connector], ["grants", grant]]) {
      expect((await db.query(`SELECT revoked_at FROM ${table} WHERE id=$1`, [id])).rows[0].revoked_at).not.toBeNull();
    }
    for (const table of ["access_tokens", "refresh_tokens"]) expect((await db.query(`SELECT revoked_at FROM ${table} WHERE grant_id=$1`, [grant])).rows[0].revoked_at).not.toBeNull();
    expect((await db.query("SELECT token_hash FROM hosted_replicas WHERE id=$1", [replica])).rows[0].token_hash).toBeNull();
    expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [collection.id])).rows[0].authority_state).toBe("active");
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id])).rowCount).toBe(0);
    await setCohortFrozen(db, name, false, "cancel before acceptance", OP);
    expect((await db.query("SELECT 1 FROM users WHERE id=$1", [account])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id])).rowCount).toBe(1);
    await db.query("DELETE FROM provider_collection_deletion_jobs WHERE collection_id=$1", [collection.id]);
  });

  function providerWait(ms: number, signal?: AbortSignal | null) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  const provider = () => new HostedProviderClient({ url: "https://bounded-peer.example.test", internalToken: "synthetic-private-boundary" });
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const projection = (id: string) => json({ projection: { collection_id: id, ready: true, head: 0,
    resource_revision: "synthetic", active_generation_id: randomUUID(), building_generation: null } });

  it("commits an actual guarded create after an 11s provider await, retaining the global 10s DB default", async () => {
    const account = await user(); await batch([account]); await materializePublicSignupEntitlement(db, account);
    let created = "", erased = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "PUT" && path.startsWith("/internal/v1/accounts/")) return json({ account: {} });
      if (init?.method === "POST" && path === "/internal/v1/collections") {
        created = JSON.parse(String(init.body)).collection_id;
        await providerWait(11_000, init.signal); return json({});
      }
      if (init?.method === "GET" && path.endsWith("/projection")) return projection(created);
      if (init?.method === "DELETE") { erased++; return json({}); }
      throw new Error("Unexpected synthetic provider request");
    });
    try {
      const result = await createHostedCollectionForUser({ db, hostedCollections: true, hostedProvider: provider() }, undefined,
        "https://synthetic.example.test", account, "Synthetic", "mdbase", "UTC");
      expect(result.id).toBe(created); expect(erased).toBe(0);
      expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [created])).rowCount).toBe(1);
      expect((await db.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout).toBe("10s");
    } finally { vi.unstubAllGlobals(); }
  }, 25_000);

  it("shares the provider 14s create/projection budget, rolls back and retains the guard through an 11s compensation", async () => {
    const account = await user(), name = await batch([account]); await materializePublicSignupEntitlement(db, account);
    const storageBefore = (await db.query("SELECT provider_revision,updated_at FROM account_storage_accounts WHERE user_id=$1", [account])).rows;
    let created = "", erased = 0, projectionStarted = false;
    const started = Date.now();
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "PUT" && path.startsWith("/internal/v1/accounts/")) return json({ account: {} });
      if (init?.method === "POST" && path === "/internal/v1/collections") {
        created = JSON.parse(String(init.body)).collection_id;
        await providerWait(9_000, init.signal); return json({});
      }
      if (init?.method === "GET" && path.endsWith("/projection")) {
        projectionStarted = true; await providerWait(20_000, init.signal); return projection(created);
      }
      if (init?.method === "DELETE" && path.endsWith(created)) {
        // Timeout14 + compensation11 exceeds guarded idle18 without the
        // actual-client liveness query between these operation budgets.
        erased++;
        const freeze = setCohortFrozen(db, name, true, "must remain locked through compensation", OP);
        const outcome = expect(freeze).rejects.toMatchObject({ code: "55P03" });
        await providerWait(11_000, init.signal); await outcome; return json({});
      }
      throw new Error("Unexpected synthetic provider request");
    });
    try {
      await expect(createHostedCollectionForUser({ db, hostedCollections: true, hostedProvider: provider() }, undefined,
        "https://synthetic.example.test", account, "Synthetic", "mdbase", "UTC")).rejects.toBeInstanceOf(HostedProviderUnavailableError);
      expect(projectionStarted).toBe(true); expect(erased).toBe(1); expect(Date.now() - started).toBeGreaterThanOrEqual(24_500);
      expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [created])).rowCount).toBe(0);
      expect((await db.query("SELECT provider_revision,updated_at FROM account_storage_accounts WHERE user_id=$1", [account])).rows).toEqual(storageBefore);
      expect((await db.query("SELECT frozen_at FROM next_migration_cohorts WHERE name=$1", [name])).rows[0].frozen_at).toBeNull();
      expect((await db.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout).toBe("10s");
    } finally { vi.unstubAllGlobals(); }
  }, 40_000);

  it("retains the same guarded transaction across consecutive 11s provider reconciliation RPCs", async () => {
    const account = await user(); await batch([account]); const a = await hosted(account), b = await hosted(account);
    await materializePublicSignupEntitlement(db, account);
    const reconciled: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "PUT" && path.includes("/collections/")) {
        await providerWait(11_000, init.signal); reconciled.push(path.split("/").at(-1)!); return json({});
      }
      if (path.startsWith("/internal/v1/accounts/")) return json({ account: {} });
      throw new Error("Unexpected synthetic provider request");
    });
    try {
      expect(await reconcileHostedAccountCollections(db, provider(), account)).toMatchObject({ reconciledCollections: 2 });
      expect(reconciled.sort()).toEqual([a.id, b.id].sort());
      expect((await db.query("SHOW idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout).toBe("10s");
    } finally { vi.unstubAllGlobals(); }
  }, 35_000);

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
    await recoverExpiredAuthorityTransfers(db, provider);
    expect(expire).not.toHaveBeenCalled();
    expect((await db.query("SELECT state FROM authority_transfers WHERE id=$1", [f.transfer])).rows[0].state).toBe("prepared");
    await setCohortFrozen(db, f.name, false, "cancel before acceptance", OP);
    await recoverExpiredAuthorityTransfers(db, provider);
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

  it("fences provider account adoption/reconciliation and uses the SAME guarded client for missing-collection quarantine", async () => {
    const account = await user(), name = await batch([account]), reference = new HostedAuthorityRegistry(db);
    const collection = await createHostedCollectionForUser({ db, hostedCollections: true }, reference, "https://synthetic.example.test", account, "Synthetic", "mdbase", "UTC");
    await materializePublicSignupEntitlement(db, account);
    const upsert = vi.fn(async () => ({})), usage = vi.fn(async () => ({}));
    const reconcile = vi.fn(async () => { throw new HostedProviderResponseError(404, "hosted_collection_not_found", "Synthetic missing collection"); });
    const provider = { upsertAccount: upsert, accountUsage: usage, reconcileCollectionAccount: reconcile } as unknown as HostedProviderClient;
    const run = () => reconcileHostedAccountCollections(db, provider, account, { onMissingCollection: async (id, client) => {
      expect(id).toBe(collection.id);
      expect(await quarantineMissingHostedCollectionOnTransaction(client, id)).toMatchObject({ changed: true });
    } });
    await setCohortFrozen(db, name, true, "capture", OP);
    await expect(run()).rejects.toMatchObject({ code: "migration_frozen" });
    for (const effect of [upsert, usage, reconcile]) expect(effect).not.toHaveBeenCalled();
    await setCohortFrozen(db, name, false, "cancel before acceptance", OP);
    expect(await run()).toMatchObject({ reconciledCollections: 0 });
    expect(reconcile).toHaveBeenCalledOnce();
    expect((await db.query("SELECT quarantined_at FROM hosted_collections WHERE id=$1", [collection.id])).rows[0].quarantined_at).not.toBeNull();
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
