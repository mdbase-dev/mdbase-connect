// Stripe as the SDK sees it over HTTP, for tests: there are no test keys.
// Kept in a helper so importing it doesn't re-register another file's tests.
import Stripe from "stripe";
import { createBilling, type Billing, type BillingConfig } from "./billing.js";

export const testBillingConfig: BillingConfig = {
  secretKey: "sk_test_billing",
  webhookSecret: "whsec_billing_test_secret_value",
  prices: { month: "price_plus_month", year: "price_plus_year" }
};

export interface SubscriptionInput {
  id?: string;
  customer?: string;
  status?: Stripe.Subscription.Status;
  price?: string;
  start?: number;
  periodStart: number;
  periodEnd: number;
  invoice?: Stripe.Invoice.Status;
  cancelAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  endedAt?: number | null;
}

export function stripeSubscription(input: SubscriptionInput): Stripe.Subscription {
  return {
    id: input.id ?? "sub_plus",
    object: "subscription",
    customer: input.customer ?? "cus_plus",
    status: input.status ?? "active",
    start_date: input.start ?? input.periodStart,
    cancel_at: input.cancelAt ?? null,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    ended_at: input.endedAt ?? null,
    latest_invoice: { id: "in_latest", object: "invoice", status: input.invoice ?? "paid" },
    items: {
      object: "list",
      data: [{
        id: "si_plus",
        object: "subscription_item",
        price: { id: input.price ?? testBillingConfig.prices.month, object: "price" },
        current_period_start: input.periodStart,
        current_period_end: input.periodEnd
      }]
    }
  } as unknown as Stripe.Subscription;
}

/** Stripe's API as the SDK sees it over HTTP: the requests sent and a mutable subscription store. */
export function fakeStripe() {
  const requests: Array<{ method: string; path: string; body: URLSearchParams; idempotencyKey: string | null }> = [];
  const subscriptions = new Map<string, Stripe.Subscription>();
  let customers = 0;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_test" }
  });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    requests.push({ method, path: url.pathname, body, idempotencyKey: headers.get("idempotency-key") });
    if (method === "POST" && url.pathname === "/v1/customers") {
      customers += 1;
      return respond(200, { id: `cus_${customers}`, object: "customer" });
    }
    if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
      return respond(200, { id: "cs_test", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test" });
    }
    if (method === "POST" && url.pathname === "/v1/billing_portal/sessions") {
      return respond(200, { id: "bps_test", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/test" });
    }
    const match = /^\/v1\/subscriptions\/([^/]+)$/u.exec(url.pathname);
    if (method === "GET" && match) {
      if (url.searchParams.get("expand[0]") !== "latest_invoice") {
        throw new Error("Subscriptions must be read with their latest invoice expanded.");
      }
      const found = subscriptions.get(decodeURIComponent(match[1]!));
      return found
        ? respond(200, found)
        : respond(404, { error: { type: "invalid_request_error", message: "No such subscription" } });
    }
    return respond(500, { error: { type: "api_error", message: `Unexpected ${method} ${url.pathname}` } });
  };
  const billing: Billing = createBilling(testBillingConfig, Stripe.createFetchHttpClient(fetch as typeof globalThis.fetch));
  return { billing, requests, subscriptions };
}
