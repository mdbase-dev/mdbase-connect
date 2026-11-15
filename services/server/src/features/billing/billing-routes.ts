import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireSessionContext } from "../../platform/request-authentication.js";
import { requireSameOrigin } from "../../platform/request-security.js";
import { readAccountBackend } from "../account/backend-routes.js";
import {
  billingCustomer,
  currentPlusSubscription,
  ensureBillingCustomer,
  subscriptionReference,
  syncPlusSubscription,
  type Billing
} from "./billing.js";

interface BillingRoutesOptions {
  db: DatabasePool;
  billing: Billing;
  publicUrl: string;
  managementOrigins?: string[];
  /** Applies a changed entitlement now instead of at the next allocation pass. */
  onEntitlementChanged?(userId: string): void;
}

/** Registered only when Stripe is configured; otherwise these routes are 404s. */
export function registerBillingRoutes(
  app: FastifyInstance,
  options: BillingRoutesOptions
): void {
  const { db, billing } = options;
  const accountUrl = (query = "") => new URL(`/account${query}`, options.publicUrl).href;

  app.post("/v1/billing/checkout", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(request, reply, db);
    if (!authenticated) return;
    const { interval } = z.object({ interval: z.enum(["month", "year"]) }).strict().parse(request.body);
    const { user } = authenticated;
    // The legacy hosted provider refuses storage above its 1 GiB cap.
    if (await readAccountBackend(db, user.id) !== "next") {
      return reply.code(409).send(apiError(
        "plus_unavailable",
        "Plus isn't available for this account yet."
      ));
    }
    // A cancelling subscription is resumed in the customer portal, not bought twice.
    const current = await currentPlusSubscription(db, user.id);
    if (current && current.status !== "canceled") {
      return reply.code(409).send(apiError(
        "plus_subscription_exists",
        "This account already has Plus. Use Manage billing to change it."
      ));
    }
    const customer = await ensureBillingCustomer(db, billing, user);
    const session = await billing.stripe.checkout.sessions.create({
      mode: "subscription",
      managed_payments: { enabled: true },
      line_items: [{ price: billing.config.prices[interval], quantity: 1 }],
      customer,
      client_reference_id: user.id,
      subscription_data: { metadata: { mdbase_user_id: user.id } },
      success_url: accountUrl("?checkout=success"),
      cancel_url: accountUrl("?checkout=cancelled")
    });
    if (!session.url) throw new Error("Stripe returned a checkout session without a URL.");
    return { url: session.url };
  });

  app.post("/v1/billing/portal", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    requireSameOrigin(request, options.publicUrl, options.managementOrigins);
    const authenticated = await requireSessionContext(request, reply, db);
    if (!authenticated) return;
    const customer = await billingCustomer(db, authenticated.user.id);
    if (!customer) {
      return reply.code(409).send(apiError(
        "billing_account_missing",
        "This account has no billing history yet."
      ));
    }
    const session = await billing.stripe.billingPortal.sessions.create({
      customer,
      return_url: accountUrl()
    });
    return { url: session.url };
  });

  app.post("/v1/webhooks/stripe", { config: { rawBody: true } }, async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof request.rawBody !== "string" || typeof signature !== "string") {
      return reply.code(400).send(apiError("invalid_webhook", "The webhook request is invalid."));
    }
    let event: Stripe.Event;
    try {
      // Verify the exact bytes and timestamp before trusting anything in them.
      event = billing.stripe.webhooks.constructEvent(
        request.rawBody,
        signature,
        billing.config.webhookSecret
      );
    } catch (error) {
      if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
        return reply.code(400).send(apiError("invalid_webhook", "The webhook signature is invalid."));
      }
      throw error;
    }
    const reference = subscriptionReference(event);
    if (!reference) return { received: true };
    const synced = await syncPlusSubscription(db, billing, reference);
    if (synced?.changed) options.onEntitlementChanged?.(synced.userId);
    return { received: true };
  });
}
