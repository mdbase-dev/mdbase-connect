import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";

const resources: Array<() => Promise<void>> = [];
const allowedOrigin = "https://mdbase.dev";

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("beta access requests", () => {
  it("stores one normalized request and returns the same response for repeats", async () => {
    const { app, db } = await fixture();
    for (const email of ["Person@Example.com", " person@example.com "]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/beta-access-requests",
        headers: { origin: allowedOrigin },
        payload: { email }
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const stored = await db.query<{
      email: string;
      normalized_email: string;
      email_normalization_version: number;
    }>(
      `SELECT email, normalized_email, email_normalization_version
       FROM beta_access_requests`
    );
    expect(stored.rows).toEqual([{
      email: "Person@Example.com",
      normalized_email: "person@example.com",
      email_normalization_version: 1
    }]);
  });

  it("ignores the honeypot and rejects untrusted origins and invalid addresses", async () => {
    const { app, db } = await fixture();
    const honeypot = await app.inject({
      method: "POST",
      url: "/v1/beta-access-requests",
      headers: { origin: allowedOrigin },
      payload: { email: "bot@example.com", website: "https://spam.example" }
    });
    expect(honeypot.statusCode).toBe(202);
    const stored = await db.query("SELECT id FROM beta_access_requests");
    expect(stored.rows).toHaveLength(0);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/beta-access-requests",
      headers: { origin: "https://other.example" },
      payload: { email: "person@example.com" }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("origin_denied");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/beta-access-requests",
      headers: { origin: allowedOrigin },
      payload: { email: "not-an-address" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_request");
  });

  it("applies a shared email rate limit", async () => {
    const { app } = await fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/beta-access-requests",
        headers: { origin: allowedOrigin },
        payload: { email: "limited@example.com" }
      });
      expect(accepted.statusCode).toBe(202);
    }
    const denied = await app.inject({
      method: "POST",
      url: "/v1/beta-access-requests",
      headers: { origin: allowedOrigin },
      payload: { email: "limited@example.com" }
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe("rate_limited");
    expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
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
