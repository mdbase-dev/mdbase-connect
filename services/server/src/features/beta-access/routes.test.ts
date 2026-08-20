import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";

const resources: Array<() => Promise<void>> = [];
const allowedOrigin = "https://mdbase.dev";

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("beta access requests", () => {
  it("returns a stable closure response without storing a request", async () => {
    const { app, db } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/v1/beta-access-requests",
      headers: { origin: allowedOrigin },
      payload: { email: "person@example.com" }
    });

    expect(response.statusCode).toBe(410);
    expect(response.json().error).toEqual({
      code: "beta_access_closed",
      message: "Beta access requests are closed. Public signup is opening soon."
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    const stored = await db.query("SELECT id FROM beta_access_requests");
    expect(stored.rows).toHaveLength(0);
  });

  it("still rejects untrusted origins", async () => {
    const { app } = await fixture();
    const denied = await app.inject({
      method: "POST",
      url: "/v1/beta-access-requests",
      headers: { origin: "https://other.example" },
      payload: { email: "person@example.com" }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("origin_denied");
  });
});

async function fixture() {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const result = await buildApp({
    db,
    devAuth: true,
    publicUrl: "http://connect.test",
    betaAccessOrigin: allowedOrigin,
    authRateLimitSecret: "test-rate-limit-secret".repeat(2)
  });
  resources.push(() => result.app.close());
  return { ...result, db };
}
