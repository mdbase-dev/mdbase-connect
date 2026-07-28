import { createHmac } from "node:crypto";
import type { DatabasePool } from "./db.js";

export interface AuthRateLimitRule {
  maxAttempts: number;
  windowSeconds: number;
  baseBlockSeconds: number;
  maxBlockSeconds: number;
}

export interface AuthRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface RateLimitRow {
  attempt_count: number;
  window_started_at: Date | string;
  blocked_until: Date | string | null;
}

export class AuthRateLimiter {
  constructor(
    private readonly db: DatabasePool,
    private readonly digestSecret: string
  ) {
    if (Buffer.byteLength(digestSecret, "utf8") < 32) {
      throw new TypeError("Authentication rate-limit digest secret is too short.");
    }
  }

  async consume(
    scope: string,
    key: string,
    rule: AuthRateLimitRule
  ): Promise<AuthRateLimitDecision> {
    validateScope(scope);
    validateRule(rule);
    const keyDigest = this.keyDigest(scope, key);
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const clock = await connection.query<{ clock_now: Date }>(
        "SELECT now() AS clock_now"
      );
      const now = new Date(clock.rows[0]!.clock_now);
      // Establish the row before locking it. Concurrent first attempts then
      // serialize on the unique key instead of both calculating attempt one
      // from an absent row and losing an increment in the upsert.
      await connection.query(
        `INSERT INTO auth_rate_limit_buckets
           (scope, key_digest, window_started_at, attempt_count, updated_at)
         VALUES ($1, $2, $3, 0, $3)
         ON CONFLICT(scope, key_digest) DO NOTHING`,
        [scope, keyDigest, now]
      );
      const existing = await connection.query<RateLimitRow>(
        `SELECT attempt_count, window_started_at, blocked_until
         FROM auth_rate_limit_buckets
         WHERE scope = $1 AND key_digest = $2
         FOR UPDATE`,
        [scope, keyDigest]
      );
      const row = existing.rows[0]!;
      const blockedUntil = row?.blocked_until
        ? new Date(row.blocked_until)
        : null;
      if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
        await connection.query("COMMIT");
        return {
          allowed: false,
          retryAfterSeconds: secondsUntil(now, blockedUntil)
        };
      }

      const windowStartedAt = new Date(row.window_started_at);
      const windowExpired =
        now.getTime() - windowStartedAt.getTime() >= rule.windowSeconds * 1_000;
      const attemptCount = windowExpired ? 1 : row.attempt_count + 1;
      const nextWindowStartedAt = windowExpired ? now : windowStartedAt;
      const allowed = attemptCount <= rule.maxAttempts;
      const nextBlockedUntil = allowed
        ? null
        : new Date(
            now.getTime()
            + escalatingBlockSeconds(attemptCount, rule) * 1_000
          );
      await connection.query(
        `UPDATE auth_rate_limit_buckets SET
           window_started_at = $3,
           attempt_count = $4,
           blocked_until = $5,
           updated_at = $6
         WHERE scope = $1 AND key_digest = $2`,
        [
          scope,
          keyDigest,
          nextWindowStartedAt,
          attemptCount,
          nextBlockedUntil,
          now
        ]
      );
      await connection.query("COMMIT");
      return {
        allowed,
        retryAfterSeconds: nextBlockedUntil
          ? secondsUntil(now, nextBlockedUntil)
          : 0
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  keyDigest(scope: string, key: string): string {
    validateScope(scope);
    return createHmac("sha256", this.digestSecret)
      .update(scope)
      .update("\0")
      .update(key)
      .digest("hex");
  }
}

function escalatingBlockSeconds(
  attemptCount: number,
  rule: AuthRateLimitRule
): number {
  const excess = attemptCount - rule.maxAttempts - 1;
  const escalation = Math.max(0, Math.floor(excess / rule.maxAttempts));
  return Math.min(
    rule.maxBlockSeconds,
    rule.baseBlockSeconds * (2 ** Math.min(escalation, 20))
  );
}

function secondsUntil(now: Date, future: Date): number {
  return Math.max(1, Math.ceil((future.getTime() - now.getTime()) / 1_000));
}

function validateScope(scope: string): void {
  if (!/^[a-z][a-z0-9_.:-]{0,99}$/.test(scope)) {
    throw new TypeError("Authentication rate-limit scope is invalid.");
  }
}

function validateRule(rule: AuthRateLimitRule): void {
  for (const [name, value] of Object.entries(rule)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Authentication rate-limit ${name} must be a positive integer.`);
    }
  }
  if (rule.maxBlockSeconds < rule.baseBlockSeconds) {
    throw new TypeError(
      "Authentication maximum block duration cannot be shorter than its base duration."
    );
  }
}
