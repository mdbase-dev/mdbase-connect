import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backfillFreeEntitlement } from "./auth-admin-entitlements.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { effectiveEntitlement, grantOperatorEntitlement } from "./entitlements.js";

// Only an explicitly approved, local disposable database is accepted.
const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
let admin: pg.Pool;
let db: DatabasePool;
let schema: string;
const audit = { actor: "operator:test", reason: "free plan rollout test" };

async function user(): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Person')", [id, `${id}@example.com`]);
  return id;
}

describePostgres("free plan entitlement", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Free plan tests require a dedicated local test database.");
    }
    schema = `mdbase_free_plan_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("backfills every account once, in batches, and leaves beta accounts' limits unchanged", async () => {
    const plain = await user();
    const beta = await user();
    await grantOperatorEntitlement(db, { userId: beta, profileCode: "beta_v1", operationId: randomUUID(), ...audit });
    expect(await effectiveEntitlement(db, plain)).toBeNull();
    const betaBefore = await effectiveEntitlement(db, beta);

    const operationId = randomUUID();
    const first = await backfillFreeEntitlement(db, { operationId, ...audit, limit: "1" });
    expect(first.granted).toBe(1);
    expect(first.remaining).toBeGreaterThanOrEqual(1);
    let last = first;
    while (last.remaining > 0) last = await backfillFreeEntitlement(db, { operationId, ...audit, limit: "5000" });
    expect((await backfillFreeEntitlement(db, { operationId, ...audit, limit: undefined })).granted).toBe(0);

    const free = await effectiveEntitlement(db, plain);
    expect(free).toMatchObject({ profileCodes: ["free_v1"], maxHostedCollections: 1, hostedStorageBytes: 262144000, maxCollectionMemberSeats: 1, maxSingleFileBytes: 104857600 });
    const storage = await db.query("SELECT provider_account_id FROM account_storage_accounts WHERE user_id = $1", [plain]);
    expect(storage.rows).toHaveLength(1);

    const betaAfter = await effectiveEntitlement(db, beta);
    expect(betaAfter?.profileCodes).toEqual(["beta_v1", "free_v1"]);
    expect({ ...betaAfter, profileCodes: [] }).toEqual({ ...betaBefore, profileCodes: [] });
    const grants = await db.query("SELECT 1 FROM account_entitlement_grants WHERE profile_code = 'free_v1' AND user_id = ANY($1)", [[plain, beta]]);
    expect(grants.rows).toHaveLength(2);
  });

  it("never re-grants a revoked or expired free plan, skips suspended accounts, and terminates (SEC-039)", async () => {
    const operationId = randomUUID();
    const drain = async () => {
      let runs = 0;
      for (let result = await backfillFreeEntitlement(db, { operationId, ...audit, limit: "5000" }); result.remaining > 0; result = await backfillFreeEntitlement(db, { operationId, ...audit, limit: "5000" })) {
        runs += 1;
        if (runs > 10) throw new Error("backfill does not terminate");
      }
    };
    await drain();
    const revoked = await user();
    const expired = await user();
    const suspended = await user();
    await drain();
    await db.query("UPDATE account_entitlement_grants SET revoked_at = now() WHERE user_id = $1 AND profile_code = 'free_v1'", [revoked]);
    await db.query("UPDATE account_entitlement_grants SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE user_id = $1 AND profile_code = 'free_v1'", [expired]);
    await db.query("DELETE FROM account_entitlement_grants WHERE user_id = $1", [suspended]);
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [suspended]);
    const rerun = await backfillFreeEntitlement(db, { operationId, ...audit, limit: "5000" });
    expect(rerun).toMatchObject({ granted: 0, remaining: 0 });
    expect(await effectiveEntitlement(db, revoked)).toBeNull();
    expect(await effectiveEntitlement(db, expired)).toBeNull();
    expect(await effectiveEntitlement(db, suspended)).toBeNull();
  });

  it("refuses an out-of-range batch size", async () => {
    await expect(backfillFreeEntitlement(db, { operationId: randomUUID(), ...audit, limit: "0" })).rejects.toThrow(/between 1 and 5000/);
  });
});
