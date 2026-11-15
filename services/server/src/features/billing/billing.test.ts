import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { tokenHash } from "../../security.js";
import { hashPassword } from "../auth/password.js";
import { effectiveEntitlement, materializePublicSignupEntitlement } from "../account/entitlements.js";
import { FAILED_PAYMENT_GRACE_MS, plusSubscriptionState, type Billing } from "./billing.js";
import {
  fakeStripe,
  stripeSubscription,
  testBillingConfig as config,
  type SubscriptionInput
} from "./billing.test-helper.js";

const origin = "https://connect.example";
const DAY = 24 * 60 * 60;
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

const now = () => Math.floor(Date.now() / 1_000);
const at = (seconds: number) => new Date(seconds * 1_000);
const graceAfter = (seconds: number) => new Date(seconds * 1_000 + FAILED_PAYMENT_GRACE_MS);

describe("Plus grant from a subscription", () => {
  const start = 1_800_000_000;
  const end = start + 30 * DAY;

  it("lasts through a paid period and the failed-payment grace", () => {
    expect(plusSubscriptionState(stripeSubscription({ periodStart: start, periodEnd: end }), config.prices)).toEqual({
      status: "active",
      startsAt: at(start),
      currentPeriodEnd: at(end),
      cancelsAt: null,
      grantEndsAt: graceAfter(end)
    });
    const yearly = plusSubscriptionState(
      stripeSubscription({ periodStart: start, periodEnd: start + 365 * DAY, price: config.prices.year }),
      config.prices
    );
    expect(yearly?.grantEndsAt).toEqual(graceAfter(start + 365 * DAY));
  });

  it("keeps the paid period when cancelling at its end", () => {
    const portalStyle = plusSubscriptionState(
      stripeSubscription({ periodStart: start, periodEnd: end, cancelAt: end }),
      config.prices
    );
    const flagStyle = plusSubscriptionState(
      stripeSubscription({ periodStart: start, periodEnd: end, cancelAtPeriodEnd: true }),
      config.prices
    );
    for (const state of [portalStyle, flagStyle]) {
      expect(state).toMatchObject({ status: "active", cancelsAt: at(end), grantEndsAt: graceAfter(end) });
    }
  });

  it("counts an unpaid renewal's grace from the start of the period it bills", () => {
    // Stripe moves the period forward when it bills the renewal, paid or not.
    const renewed = plusSubscriptionState(
      stripeSubscription({ status: "past_due", start, periodStart: end, periodEnd: end + 30 * DAY, invoice: "open" }),
      config.prices
    );
    expect(renewed).toMatchObject({ status: "past_due", startsAt: at(start), grantEndsAt: graceAfter(end) });
  });

  it("ends a cancelled subscription when it ended, if that comes before the paid period's end", () => {
    const afterFailedRenewal = plusSubscriptionState(stripeSubscription({
      status: "canceled", start, periodStart: end, periodEnd: end + 30 * DAY, invoice: "open", endedAt: end + 14 * DAY
    }), config.prices);
    expect(afterFailedRenewal).toMatchObject({ status: "canceled", cancelsAt: null, grantEndsAt: graceAfter(end) });
    const immediately = plusSubscriptionState(stripeSubscription({
      status: "canceled", periodStart: start, periodEnd: end, endedAt: start + 3 * DAY
    }), config.prices);
    expect(immediately?.grantEndsAt).toEqual(graceAfter(start + 3 * DAY));
  });

  it("grants nothing before the first payment and ignores other prices", () => {
    for (const status of ["incomplete", "incomplete_expired", "paused"] as const) {
      expect(plusSubscriptionState(
        stripeSubscription({ status, periodStart: start, periodEnd: end, invoice: "open" }),
        config.prices
      )?.grantEndsAt).toBeNull();
    }
    expect(plusSubscriptionState(
      stripeSubscription({ periodStart: start, periodEnd: end, price: "price_other" }),
      config.prices
    )).toBeNull();
  });

  it("refuses a subscription read without its latest invoice", () => {
    const unexpanded = { ...stripeSubscription({ periodStart: start, periodEnd: end }), latest_invoice: "in_latest" };
    expect(() => plusSubscriptionState(unexpanded as Stripe.Subscription, config.prices)).toThrow(TypeError);
  });
});

async function fixture(options: { billing?: boolean } = {}) {
  const stripe = fakeStripe();
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const { app } = await buildApp({
    db,
    publicUrl: origin,
    ...(options.billing === false ? {} : { billing: stripe.billing })
  });
  resources.push(() => app.close());
  return { app, db, ...stripe };
}

async function signup(db: Awaited<ReturnType<typeof createDatabase>>, backend: "next" | "legacy" = "next") {
  const userId = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name, account_backend) VALUES ($1, $2, 'Person', $3)",
    [userId, `${userId}@example.com`, backend]
  );
  await materializePublicSignupEntitlement(db, userId);
  const token = `ses_${randomUUID()}_${randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, user_id, token_hash, provider, account_session_epoch, expires_at, client_name)
     SELECT $1, id, $3, 'session', session_epoch, now() + interval '30 days', 'Test browser'
     FROM users WHERE id = $2`,
    [randomUUID(), userId, tokenHash(token)]
  );
  return { userId, cookie: `__Host-mdbase_session=${token}` };
}

function signedEvent(billing: Billing, type: string, object: unknown) {
  const payload = JSON.stringify({
    id: `evt_${randomUUID()}`,
    object: "event",
    api_version: "2026-10-28.endive",
    created: now(),
    type,
    data: { object }
  });
  const signature = billing.stripe.webhooks.generateTestHeaderString({ payload, secret: config.webhookSecret });
  return { payload, headers: { "content-type": "application/json", "stripe-signature": signature } };
}

/** Delivers a correctly signed event and expects Stripe to be told it was received. */
async function deliver(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  billing: Billing,
  type: string,
  object: unknown
) {
  const event = signedEvent(billing, type, object);
  const response = await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: event.headers, payload: event.payload });
  expect(response.statusCode, response.body).toBe(200);
}

describe("billing routes", () => {
  it("are absent, and /v1/me says billing is unavailable, without Stripe configuration", async () => {
    const { app, db } = await fixture({ billing: false });
    const account = await signup(db);
    for (const url of ["/v1/billing/checkout", "/v1/billing/portal", "/v1/webhooks/stripe"]) {
      const response = await app.inject({ method: "POST", url, headers: { origin, cookie: account.cookie }, payload: {} });
      expect(response.statusCode, url).toBe(404);
    }
    const me = await app.inject({ url: "/v1/me", headers: { cookie: account.cookie } });
    expect(me.json().billing).toEqual({ available: false, plus_limits: null, plus: null });
  });

  it("opens Managed Payments checkout for the chosen price on the account's one customer", async () => {
    const { app, db, requests } = await fixture();
    const account = await signup(db);
    const checkout = (interval: string) => app.inject({
      method: "POST", url: "/v1/billing/checkout",
      headers: { origin, cookie: account.cookie }, payload: { interval }
    });

    const monthly = await checkout("month");
    expect(monthly.statusCode, monthly.body).toBe(200);
    expect(monthly.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test" });
    expect((await checkout("year")).statusCode).toBe(200);

    const customers = requests.filter(({ path }) => path === "/v1/customers");
    expect(customers).toHaveLength(1);
    expect(customers[0]!.idempotencyKey).toBe(`mdbase-customer-${account.userId}`);
    expect(Object.fromEntries(customers[0]!.body)).toEqual({
      email: `${account.userId}@example.com`,
      "metadata[mdbase_user_id]": account.userId
    });
    const sessions = requests.filter(({ path }) => path === "/v1/checkout/sessions");
    expect(sessions.map(({ body }) => body.get("line_items[0][price]"))).toEqual([config.prices.month, config.prices.year]);
    expect(Object.fromEntries(sessions[0]!.body)).toEqual({
      mode: "subscription",
      "managed_payments[enabled]": "true",
      "line_items[0][price]": config.prices.month,
      "line_items[0][quantity]": "1",
      customer: "cus_1",
      client_reference_id: account.userId,
      "subscription_data[metadata][mdbase_user_id]": account.userId,
      success_url: `${origin}/account?checkout=success`,
      cancel_url: `${origin}/account?checkout=cancelled`
    });
    expect(requests.every(({ path }) => path.startsWith("/v1/"))).toBe(true);

    const me = await app.inject({ url: "/v1/me", headers: { cookie: account.cookie } });
    expect(me.json().billing).toEqual({
      available: true,
      plus_limits: {
        hosted_storage_bytes: 107_374_182_400,
        max_hosted_collections: 10,
        max_single_file_bytes: 262_144_000,
        max_collection_member_seats: 5
      },
      plus: null
    });
  });

  it("refuses checkout from another origin, for a legacy account, and for a bad interval", async () => {
    const { app, db, requests } = await fixture();
    const next = await signup(db);
    const legacy = await signup(db, "legacy");
    const post = (cookie: string, headers: Record<string, string>, payload: unknown) => app.inject({
      method: "POST", url: "/v1/billing/checkout", headers: { cookie, ...headers }, payload: payload as object
    });
    expect((await post(next.cookie, { origin: "https://evil.example" }, { interval: "month" })).statusCode).toBe(403);
    expect((await post(next.cookie, { origin }, { interval: "week" })).statusCode).toBe(400);
    const refused = await post(legacy.cookie, { origin }, { interval: "month" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("plus_unavailable");
    expect((await app.inject({ url: "/v1/me", headers: { cookie: legacy.cookie } })).json().billing.available).toBe(false);
    expect(requests).toEqual([]);
  });

  it("rejects webhooks without a valid signature", async () => {
    const { app, billing, requests } = await fixture();
    const event = signedEvent(billing, "customer.subscription.updated", { id: "sub_plus", object: "subscription", customer: "cus_1" });
    const tampered = await app.inject({
      method: "POST", url: "/v1/webhooks/stripe",
      headers: event.headers, payload: event.payload.replace("sub_plus", "sub_other")
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe("invalid_webhook");
    const unsigned = await app.inject({
      method: "POST", url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json" }, payload: event.payload
    });
    expect(unsigned.statusCode).toBe(400);
    expect(requests).toEqual([]);
  });

  it("turns the subscription into Plus, follows renewals and lapses, and ignores replays and order", async () => {
    const { app, db, billing, subscriptions } = await fixture();
    const account = await signup(db);
    const checkout = await app.inject({
      method: "POST", url: "/v1/billing/checkout",
      headers: { origin, cookie: account.cookie }, payload: { interval: "month" }
    });
    expect(checkout.statusCode).toBe(200);
    const revision = async () => Number((await db.query(
      "SELECT entitlement_revision FROM account_storage_accounts WHERE user_id = $1", [account.userId]
    )).rows[0].entitlement_revision);
    const grant = async () => (await db.query(
      `SELECT profile_code, source, source_reference, ends_at FROM account_entitlement_grants
       WHERE user_id = $1 AND source_reference = 'sub_plus'`, [account.userId]
    )).rows;
    const me = async () => (await app.inject({ url: "/v1/me", headers: { cookie: account.cookie } })).json();

    const start = now() - 60;
    const firstEnd = start + 30 * DAY;
    subscriptions.set("sub_plus", stripeSubscription({ customer: "cus_1", periodStart: start, periodEnd: firstEnd }));
    const created = { id: "sub_plus", object: "subscription", customer: "cus_1" };
    const before = await revision();
    await deliver(app, billing, "checkout.session.completed", {
      id: "cs_test", object: "checkout.session", mode: "subscription", customer: "cus_1", subscription: "sub_plus"
    });
    expect(await grant()).toEqual([{
      profile_code: "plus_v1", source: "subscription", source_reference: "sub_plus", ends_at: graceAfter(firstEnd)
    }]);
    expect(await revision()).toBe(before + 1);
    expect((await effectiveEntitlement(db, account.userId))?.hostedStorageBytes).toBe(107_374_182_400);
    let overview = await me();
    expect(overview.billing.plus).toEqual({
      status: "active",
      current_period_end: at(firstEnd).toISOString(),
      cancels_at: null,
      access_ends_at: graceAfter(firstEnd).toISOString()
    });
    expect(overview.subscription.limits).toMatchObject({ hosted_storage_bytes: 107_374_182_400, max_hosted_collections: 10 });
    expect(overview.subscription.trial).toBeNull();

    // The same state arriving again, by replay or another event type, changes nothing.
    await deliver(app, billing, "checkout.session.completed", {
      id: "cs_test", object: "checkout.session", mode: "subscription", customer: "cus_1", subscription: "sub_plus"
    });
    await deliver(app, billing, "customer.subscription.created", created);
    expect(await revision()).toBe(before + 1);

    const again = await app.inject({
      method: "POST", url: "/v1/billing/checkout",
      headers: { origin, cookie: account.cookie }, payload: { interval: "year" }
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("plus_subscription_exists");

    // A paid renewal moves the end forward.
    const secondEnd = firstEnd + 30 * DAY;
    subscriptions.set("sub_plus", stripeSubscription({ customer: "cus_1", start, periodStart: firstEnd, periodEnd: secondEnd }));
    await deliver(app, billing, "invoice.paid", {
      id: "in_renewal", object: "invoice", customer: "cus_1",
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_plus" } }
    });
    expect((await grant())[0].ends_at).toEqual(graceAfter(secondEnd));
    expect(await revision()).toBe(before + 2);

    // Cancelling at the period end keeps Plus through it.
    subscriptions.set("sub_plus", stripeSubscription({
      customer: "cus_1", start, periodStart: firstEnd, periodEnd: secondEnd, cancelAt: secondEnd
    }));
    await deliver(app, billing, "customer.subscription.updated", created);
    overview = await me();
    expect(overview.billing.plus).toMatchObject({ cancels_at: at(secondEnd).toISOString(), access_ends_at: graceAfter(secondEnd).toISOString() });
    expect((await grant())[0].ends_at).toEqual(graceAfter(secondEnd));

    // A late event from before the cancellation still applies the subscription as it is now.
    await deliver(app, billing, "customer.subscription.created", created);
    expect((await me()).billing.plus.cancels_at).toBe(at(secondEnd).toISOString());
  });

  it("keeps Plus through the grace after a failed renewal, then falls back to the other grants", async () => {
    const { app, db, billing, subscriptions } = await fixture();
    const account = await signup(db);
    await db.query("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_lapse')", [account.userId]);
    // The renewal was billed two days ago and hasn't been paid.
    const renewal = now() - 2 * DAY;
    subscriptions.set("sub_lapse", stripeSubscription({
      id: "sub_lapse", customer: "cus_lapse", status: "past_due", start: renewal - 30 * DAY,
      periodStart: renewal, periodEnd: renewal + 30 * DAY, invoice: "open"
    }));
    await deliver(app, billing, "customer.subscription.updated", { id: "sub_lapse", object: "subscription", customer: "cus_lapse" });
    const overview = (await app.inject({ url: "/v1/me", headers: { cookie: account.cookie } })).json();
    expect(overview.billing.plus).toMatchObject({ status: "past_due", access_ends_at: graceAfter(renewal).toISOString() });
    expect(overview.subscription.limits.hosted_storage_bytes).toBe(107_374_182_400);

    // Retries ran out: Stripe cancelled it after the grace, which has passed.
    const lapsed = now() - 8 * DAY;
    subscriptions.set("sub_lapse", stripeSubscription({
      id: "sub_lapse", customer: "cus_lapse", status: "canceled", start: lapsed - 30 * DAY,
      periodStart: lapsed, periodEnd: lapsed + 30 * DAY, invoice: "open", endedAt: now() - DAY
    }));
    await deliver(app, billing, "customer.subscription.updated", { id: "sub_lapse", object: "subscription", customer: "cus_lapse" });
    const after = (await app.inject({ url: "/v1/me", headers: { cookie: account.cookie } })).json();
    expect(after.billing.plus).toBeNull();
    expect(after.subscription.profiles).toEqual(["free_v1", "trial_v1"]);
    expect(after.subscription.limits.hosted_storage_bytes).toBe(5_368_709_120);
    // A lapsed subscription doesn't stand in the way of buying Plus again.
    const checkout = await app.inject({
      method: "POST", url: "/v1/billing/checkout",
      headers: { origin, cookie: account.cookie }, payload: { interval: "month" }
    });
    expect(checkout.statusCode).toBe(200);
  });

  it("ignores customers it didn't create and subscriptions without a Plus price", async () => {
    const { app, db, billing, subscriptions, requests } = await fixture();
    const account = await signup(db);
    await db.query("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_known')", [account.userId]);
    subscriptions.set("sub_other", stripeSubscription({
      id: "sub_other", customer: "cus_known", price: "price_other", periodStart: now(), periodEnd: now() + 30 * DAY
    }));
    for (const object of [
      { id: "sub_stranger", object: "subscription", customer: "cus_stranger" },
      { id: "sub_other", object: "subscription", customer: "cus_known" }
    ]) {
      await deliver(app, billing, "customer.subscription.updated", object);
    }
    expect(requests.map(({ path }) => path)).toEqual(["/v1/subscriptions/sub_other"]);
    expect((await db.query(
      "SELECT 1 FROM account_entitlement_grants WHERE user_id = $1 AND profile_code = 'plus_v1'", [account.userId]
    )).rows).toEqual([]);
    await deliver(app, billing, "charge.refunded", { id: "ch_1", object: "charge" });
  });

  it("opens the customer portal for an account with a customer", async () => {
    const { app, db, requests } = await fixture();
    const account = await signup(db);
    const portal = () => app.inject({ method: "POST", url: "/v1/billing/portal", headers: { origin, cookie: account.cookie } });
    const missing = await portal();
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe("billing_account_missing");
    await db.query("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_portal')", [account.userId]);
    const opened = await portal();
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ url: "https://billing.stripe.com/p/session/test" });
    expect(Object.fromEntries(requests.at(-1)!.body)).toEqual({ customer: "cus_portal", return_url: `${origin}/account` });
  });

  it("refuses to delete an account while Plus still renews", async () => {
    const { app, db, billing, subscriptions } = await fixture();
    const account = await signup(db);
    await db.query("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES ($1, 'cus_delete')", [account.userId]);
    const sync = async (input: Partial<SubscriptionInput>) => {
      subscriptions.set("sub_delete", stripeSubscription({
        id: "sub_delete", customer: "cus_delete", periodStart: now() - 60, periodEnd: now() + 30 * DAY, ...input
      }));
      await deliver(app, billing, "customer.subscription.updated", { id: "sub_delete", object: "subscription", customer: "cus_delete" });
    };
    await db.query(
      `INSERT INTO email_identities (id, user_id, email, normalized_email, verified_at, is_primary)
       VALUES ($1, $2, $3, $3, now(), true)`,
      [randomUUID(), account.userId, `${account.userId}@example.com`]
    );
    await db.query(
      "INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)",
      [account.userId, await hashPassword("a correct password")]
    );
    await sync({});
    const remove = () => app.inject({
      method: "DELETE", url: "/v1/account",
      headers: { origin, cookie: account.cookie },
      payload: { confirmation: "DELETE", current_password: "a correct password" }
    });
    const refused = await remove();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("plus_subscription_renews");
    await sync({ cancelAtPeriodEnd: true });
    const deleted = await remove();
    expect(deleted.statusCode, deleted.body).toBe(200);
  });
});
