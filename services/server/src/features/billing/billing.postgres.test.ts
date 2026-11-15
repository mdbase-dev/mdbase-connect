import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { effectiveEntitlement, materializePublicSignupEntitlement } from "../account/entitlements.js";
import { currentPlusSubscription, FAILED_PAYMENT_GRACE_MS, syncPlusSubscription } from "./billing.js";
import { fakeStripe, stripeSubscription } from "./billing.test-helper.js";

// Only an explicitly approved, local disposable database is accepted.
const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
const DAY = 24 * 60 * 60;
let admin: pg.Pool;
let db: DatabasePool;
let schema: string;

const now = () => Math.floor(Date.now() / 1_000);
const graceAfter = (seconds: number) => new Date(seconds * 1_000 + FAILED_PAYMENT_GRACE_MS);

async function customer(): Promise<{ userId: string; customerId: string }> {
  const userId = randomUUID();
  const customerId = `cus_${userId.replaceAll("-", "")}`;
  await db.query("INSERT INTO users (id, email, name, account_backend) VALUES ($1, $2, 'Person', 'next')", [userId, `${userId}@example.com`]);
  await materializePublicSignupEntitlement(db, userId);
  await db.query("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, $2)", [userId, customerId]);
  return { userId, customerId };
}

async function revision(userId: string): Promise<number> {
  const result = await db.query<{ entitlement_revision: string }>(
    "SELECT entitlement_revision FROM account_storage_accounts WHERE user_id = $1",
    [userId]
  );
  return Number(result.rows[0]!.entitlement_revision);
}

describePostgres("Plus subscription sync", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Billing tests require a dedicated local test database.");
    }
    schema = `mdbase_billing_test_${randomUUID().replaceAll("-", "")}`;
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

  it("grants Plus once however many deliveries race, and follows the subscription after", async () => {
    const { billing, subscriptions } = fakeStripe();
    const { userId, customerId } = await customer();
    const reference = { customerId, subscriptionId: "sub_race" };
    const start = now() - 20 * DAY;
    const end = start + 30 * DAY;
    subscriptions.set("sub_race", stripeSubscription({ id: "sub_race", customer: customerId, periodStart: start, periodEnd: end }));
    const before = await revision(userId);

    const results = await Promise.all(Array.from({ length: 5 }, () => syncPlusSubscription(db, billing, reference)));
    expect(results.filter((result) => result?.changed)).toHaveLength(1);
    expect(await revision(userId)).toBe(before + 1);
    const grants = await db.query(
      "SELECT profile_code, ends_at FROM account_entitlement_grants WHERE user_id = $1 AND source_reference = 'sub_race'",
      [userId]
    );
    expect(grants.rows).toEqual([{ profile_code: "plus_v1", ends_at: graceAfter(end) }]);
    expect(await effectiveEntitlement(db, userId)).toMatchObject({
      hostedStorageBytes: 107_374_182_400,
      retainedFileBytes: 214_748_364_800,
      maxHostedCollections: 10,
      maxSingleFileBytes: 262_144_000,
      maxCollectionMemberSeats: 5,
      maxDocumentBytes: 2_097_152
    });
    const audits = await db.query(
      "SELECT 1 FROM audit_events WHERE user_id = $1 AND event_type = 'entitlement.subscription_synced'",
      [userId]
    );
    expect(audits.rows).toHaveLength(1);

    // Cancelled early in the dashboard: Plus ends with the grace after the cancellation, now past.
    const endedAt = start + DAY;
    subscriptions.set("sub_race", stripeSubscription({
      id: "sub_race", customer: customerId, status: "canceled", periodStart: start, periodEnd: end, endedAt
    }));
    expect(await syncPlusSubscription(db, billing, reference)).toEqual({ userId, changed: true });
    expect(await currentPlusSubscription(db, userId)).toBeNull();
    expect((await effectiveEntitlement(db, userId))?.profileCodes).toEqual(["free_v1", "trial_v1"]);
    const stored = await db.query(
      "SELECT status, cancels_at FROM billing_subscriptions WHERE stripe_subscription_id = 'sub_race'"
    );
    expect(stored.rows).toEqual([{ status: "canceled", cancels_at: null }]);
  });

  it("refuses a subscription that belongs to another customer", async () => {
    const { billing, subscriptions } = fakeStripe();
    const { userId, customerId } = await customer();
    subscriptions.set("sub_foreign", stripeSubscription({
      id: "sub_foreign", customer: "cus_someone_else", periodStart: now(), periodEnd: now() + 30 * DAY
    }));
    await expect(syncPlusSubscription(db, billing, { customerId, subscriptionId: "sub_foreign" }))
      .rejects.toThrow("different Stripe customer");
    const grants = await db.query(
      "SELECT 1 FROM account_entitlement_grants WHERE user_id = $1 AND profile_code = 'plus_v1'",
      [userId]
    );
    expect(grants.rows).toEqual([]);
  });
});
