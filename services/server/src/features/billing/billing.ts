import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { recordEntitlementChange } from "../account/entitlements.js";

export const PLUS_ENTITLEMENT_PROFILE = "plus_v1";
/**
 * Managed Payments needs 2025-03-31.basil or later. This is the version the
 * pinned `stripe` package is typed for; from basil on, billing periods are on
 * subscription items and an invoice names its subscription under `parent`.
 */
export const STRIPE_API_VERSION = "2026-10-28.endive";
const DAY_MS = 24 * 60 * 60 * 1_000;
/** How long Plus outlasts an unpaid renewal while Stripe retries the payment. */
export const FAILED_PAYMENT_GRACE_MS = 7 * DAY_MS;

export type PlusInterval = "month" | "year";

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  prices: Record<PlusInterval, string>;
}

export interface Billing {
  config: BillingConfig;
  stripe: Stripe;
}

export function createBilling(
  config: BillingConfig,
  httpClient?: Stripe.HttpClient
): Billing {
  return {
    config,
    stripe: new Stripe(config.secretKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      timeout: 20_000,
      ...(httpClient ? { httpClient } : {})
    })
  };
}

/** What a Stripe subscription grants, read from its current state alone. */
export interface PlusSubscriptionState {
  status: Stripe.Subscription.Status;
  startsAt: Date;
  currentPeriodEnd: Date;
  /** When a scheduled cancellation ends it, or null while it renews. */
  cancelsAt: Date | null;
  /** The Plus grant's end, or null when the subscription grants nothing. */
  grantEndsAt: Date | null;
}

const NOT_YET_PAID = new Set<Stripe.Subscription.Status>([
  "incomplete",
  "incomplete_expired",
  "paused"
]);

/**
 * Maps a subscription to its Plus grant, or null when it has no Plus price.
 * Plus lasts through the period its latest invoice paid for, plus the
 * failed-payment grace. Stripe starts the next period when it bills a renewal,
 * so while that invoice is unpaid the paid period ends at the current period's
 * start. A cancelled subscription ends when it was cancelled if that came first.
 * `latest_invoice` must be expanded.
 */
export function plusSubscriptionState(
  subscription: Stripe.Subscription,
  prices: BillingConfig["prices"]
): PlusSubscriptionState | null {
  const plusPrices = new Set(Object.values(prices));
  const item = subscription.items.data.find((candidate) => plusPrices.has(candidate.price.id));
  if (!item) return null;
  const invoice = subscription.latest_invoice;
  if (typeof invoice === "string") {
    throw new TypeError("The subscription's latest invoice must be expanded.");
  }
  const cancelsAt = subscription.cancel_at !== null
    ? subscription.cancel_at
    : subscription.cancel_at_period_end ? item.current_period_end : null;
  const state = {
    status: subscription.status,
    startsAt: seconds(subscription.start_date),
    currentPeriodEnd: seconds(item.current_period_end),
    cancelsAt: subscription.status === "canceled" || cancelsAt === null ? null : seconds(cancelsAt)
  };
  if (NOT_YET_PAID.has(subscription.status)) return { ...state, grantEndsAt: null };
  const paidThrough = invoice?.status === "paid"
    ? item.current_period_end
    : item.current_period_start;
  const end = subscription.status === "canceled" && subscription.ended_at !== null
    ? Math.min(subscription.ended_at, paidThrough)
    : paidThrough;
  return { ...state, grantEndsAt: new Date(seconds(end).getTime() + FAILED_PAYMENT_GRACE_MS) };
}

export interface SubscriptionReference {
  customerId: string;
  subscriptionId: string;
}

/**
 * Brings an account's Plus grant in line with the subscription as Stripe has it
 * now. Every webhook event for the subscription leads here, so replays and
 * out-of-order delivery all converge on the same row. The account's row lock
 * spans the Stripe read, so a slower handler can't write an older state over a
 * newer one. Returns the account whose entitlement changed, if any.
 */
export async function syncPlusSubscription(
  db: DatabasePool,
  billing: Billing,
  reference: SubscriptionReference
): Promise<{ userId: string; changed: boolean } | null> {
  const customer = await db.query<{ user_id: string }>(
    "SELECT user_id FROM billing_customers WHERE stripe_customer_id = $1",
    [reference.customerId]
  );
  const userId = customer.rows[0]?.user_id;
  // Customers are created only by checkout here, so any other customer isn't an account's.
  if (!userId) return null;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const subscription = await billing.stripe.subscriptions.retrieve(
      reference.subscriptionId,
      { expand: ["latest_invoice"] }
    );
    if (stripeId(subscription.customer) !== reference.customerId) {
      throw new Error("The subscription belongs to a different Stripe customer.");
    }
    const state = plusSubscriptionState(subscription, billing.config.prices);
    if (!state) {
      await connection.query("COMMIT");
      return null;
    }
    await connection.query(
      `INSERT INTO billing_subscriptions
         (stripe_subscription_id, user_id, status, current_period_end, cancels_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         cancels_at = EXCLUDED.cancels_at,
         updated_at = now()`,
      [subscription.id, userId, state.status, state.currentPeriodEnd, state.cancelsAt]
    );
    const changed = state.grantEndsAt !== null
      && await writePlusGrant(connection, userId, subscription.id, state.startsAt, state.grantEndsAt);
    const entitlementRevision = await recordEntitlementChange(connection, userId, changed);
    if (changed) {
      await audit(connection, userId, "entitlement.subscription_synced", userId, {
        profile: PLUS_ENTITLEMENT_PROFILE,
        subscription: subscription.id,
        status: state.status,
        ends_at: state.grantEndsAt!.toISOString(),
        entitlement_revision: entitlementRevision
      });
    }
    await connection.query("COMMIT");
    return { userId, changed };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/** Creates or moves the subscription's grant; returns whether it changed. */
async function writePlusGrant(
  db: DatabaseQueryable,
  userId: string,
  subscriptionId: string,
  startsAt: Date,
  endsAt: Date
): Promise<boolean> {
  const existing = await db.query<{ id: string; ends_at: Date | string }>(
    `SELECT id, ends_at FROM account_entitlement_grants
     WHERE user_id = $1 AND source = 'subscription' AND source_reference = $2`,
    [userId, subscriptionId]
  );
  const grant = existing.rows[0];
  if (!grant) {
    await db.query(
      `INSERT INTO account_entitlement_grants
         (id, user_id, profile_code, source, source_reference, starts_at, ends_at)
       VALUES ($1, $2, $3, 'subscription', $4, $5, $6)`,
      [randomUUID(), userId, PLUS_ENTITLEMENT_PROFILE, subscriptionId, startsAt, endsAt]
    );
    return true;
  }
  if (new Date(grant.ends_at).getTime() === endsAt.getTime()) return false;
  await db.query(
    "UPDATE account_entitlement_grants SET ends_at = $2 WHERE id = $1",
    [grant.id, endsAt]
  );
  return true;
}

/** The account's Plus subscription whose grant is still in effect, latest first. */
export interface PlusSubscription {
  status: string;
  currentPeriodEnd: Date;
  cancelsAt: Date | null;
  grantEndsAt: Date;
}

export async function currentPlusSubscription(
  db: DatabaseQueryable,
  userId: string
): Promise<PlusSubscription | null> {
  const result = await db.query<{
    status: string;
    current_period_end: Date;
    cancels_at: Date | null;
    ends_at: Date;
  }>(
    `SELECT subscription.status, subscription.current_period_end,
            subscription.cancels_at, entitlement_grant.ends_at
     FROM billing_subscriptions subscription
     JOIN account_entitlement_grants entitlement_grant
       ON entitlement_grant.user_id = subscription.user_id
      AND entitlement_grant.source = 'subscription'
      AND entitlement_grant.source_reference = subscription.stripe_subscription_id
     WHERE subscription.user_id = $1
       AND entitlement_grant.revoked_at IS NULL
       AND entitlement_grant.ends_at > now()
     ORDER BY entitlement_grant.ends_at DESC
     LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? {
    status: row.status,
    currentPeriodEnd: new Date(row.current_period_end),
    cancelsAt: row.cancels_at === null ? null : new Date(row.cancels_at),
    grantEndsAt: new Date(row.ends_at)
  } : null;
}

/**
 * Whether Stripe will charge the account again, including a retry of a failed
 * renewal. Deleting the account would leave that subscription billing.
 */
export function plusWillRenew(subscription: PlusSubscription | null): boolean {
  return subscription !== null && subscription.status !== "canceled" && subscription.cancelsAt === null;
}

/** The account's Stripe customer, created on its first checkout. */
export async function ensureBillingCustomer(
  db: DatabaseQueryable,
  billing: Billing,
  user: { id: string; email: string | null }
): Promise<string> {
  const existing = await billingCustomer(db, user.id);
  if (existing) return existing;
  // The key makes a retried first checkout reuse the customer Stripe already made.
  const customer = await billing.stripe.customers.create({
    ...(user.email ? { email: user.email } : {}),
    metadata: { mdbase_user_id: user.id }
  }, { idempotencyKey: `mdbase-customer-${user.id}` });
  await db.query(
    `INSERT INTO billing_customers (user_id, stripe_customer_id)
     VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [user.id, customer.id]
  );
  return (await billingCustomer(db, user.id))!;
}

export async function billingCustomer(
  db: DatabaseQueryable,
  userId: string
): Promise<string | null> {
  const result = await db.query<{ stripe_customer_id: string }>(
    "SELECT stripe_customer_id FROM billing_customers WHERE user_id = $1",
    [userId]
  );
  return result.rows[0]?.stripe_customer_id ?? null;
}

/**
 * The subscription a webhook event concerns, or null for events that don't
 * change a subscription. The event says only which subscription to read again.
 */
export function subscriptionReference(event: Stripe.Event): SubscriptionReference | null {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription" || !session.subscription || !session.customer) return null;
      return { customerId: stripeId(session.customer), subscriptionId: stripeId(session.subscription) };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      return { customerId: stripeId(subscription.customer), subscriptionId: subscription.id };
    }
    case "invoice.paid": {
      const invoice = event.data.object;
      const subscription = invoice.parent?.subscription_details?.subscription;
      if (!subscription || !invoice.customer) return null;
      return { customerId: stripeId(invoice.customer), subscriptionId: stripeId(subscription) };
    }
    default:
      return null;
  }
}

function stripeId(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

function seconds(value: number): Date {
  return new Date(value * 1_000);
}
