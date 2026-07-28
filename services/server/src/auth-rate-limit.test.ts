import { afterEach, describe, expect, it } from "vitest";
import { AuthRateLimiter } from "./auth-rate-limit.js";
import { createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];
const rule = {
  maxAttempts: 2,
  windowSeconds: 60,
  baseBlockSeconds: 30,
  maxBlockSeconds: 300
};

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("distributed authentication rate limits", () => {
  it("shares limits through the database without storing the source key", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const firstInstance = new AuthRateLimiter(db, "a".repeat(32));
    const secondInstance = new AuthRateLimiter(db, "a".repeat(32));

    await expect(firstInstance.consume(
      "password.email",
      "person@example.com",
      rule
    )).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(secondInstance.consume(
      "password.email",
      "person@example.com",
      rule
    )).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    const denied = await secondInstance.consume(
      "password.email",
      "person@example.com",
      rule
    );
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(29);

    const stored = await db.query<{
      key_digest: string;
      attempt_count: number;
      blocked_until: Date;
    }>("SELECT key_digest, attempt_count, blocked_until FROM auth_rate_limit_buckets");
    expect(stored.rows[0]).toMatchObject({
      key_digest: firstInstance.keyDigest("password.email", "person@example.com"),
      attempt_count: 3
    });
    expect(stored.rows[0]?.key_digest).not.toContain("person@example.com");
    expect(stored.rows[0]?.blocked_until).toBeInstanceOf(Date);
  });

  it("does not let blocked probes extend another user's cooldown", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const limiter = new AuthRateLimiter(db, "b".repeat(32));
    await limiter.consume("password.email", "person@example.com", rule);
    await limiter.consume("password.email", "person@example.com", rule);
    const denied = await limiter.consume("password.email", "person@example.com", rule);
    const repeated = await limiter.consume("password.email", "person@example.com", rule);
    expect(repeated).toEqual(denied);
    const stored = await db.query<{ attempt_count: number }>(
      "SELECT attempt_count FROM auth_rate_limit_buckets"
    );
    expect(stored.rows[0]?.attempt_count).toBe(3);
  });

  it("resets an elapsed window and isolates scopes", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const limiter = new AuthRateLimiter(db, "c".repeat(32));
    await limiter.consume("password.email", "person@example.com", rule);
    await db.query(
      `UPDATE auth_rate_limit_buckets
       SET window_started_at = now() - interval '2 minutes',
           blocked_until = NULL`
    );
    await expect(limiter.consume(
      "password.email",
      "person@example.com",
      rule
    )).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    await expect(limiter.consume(
      "password.ip",
      "192.0.2.0/24",
      rule
    )).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });
    const buckets = await db.query<{ attempt_count: number }>(
      "SELECT attempt_count FROM auth_rate_limit_buckets"
    );
    expect(buckets.rows.map(({ attempt_count }) => attempt_count).sort())
      .toEqual([1, 1]);
  });

  it("validates secrets, scopes, and policies", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    expect(() => new AuthRateLimiter(db, "short")).toThrow(/too short/);
    const limiter = new AuthRateLimiter(db, "d".repeat(32));
    await expect(limiter.consume("Raw Email", "person@example.com", rule))
      .rejects.toThrow(/scope is invalid/);
    await expect(limiter.consume("password.email", "person@example.com", {
      ...rule,
      maxAttempts: 0
    })).rejects.toThrow(/positive integer/);
  });
});
