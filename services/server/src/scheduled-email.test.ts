import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "./database-types.js";
import { createDatabase } from "./db.js";
import { EmailDeliveryError, type EmailTransport } from "./email.js";
import { scheduleEmail, ScheduledEmailWorker } from "./scheduled-email.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("scheduled account email", () => {
  it("deduplicates scheduling and delivers one due message", async () => {
    const { db, userId, emailIdentityId } = await fixture();
    const input = {
      userId,
      emailIdentityId,
      messageKind: "test_welcome",
      templateVersion: 1,
      category: "onboarding" as const,
      deduplicationKey: `test_welcome:${userId}:v1`,
      scheduledFor: new Date(Date.now() - 1_000)
    };
    const first = await scheduleEmail(db, input);
    const duplicate = await scheduleEmail(db, input);
    expect(duplicate).toEqual({ id: first.id, duplicate: true });

    const send = vi.fn(async () => ({
      provider: "test",
      messageId: "message-1"
    }));
    const worker = new ScheduledEmailWorker(
      db,
      { send },
      ({ email }) => ({
        to: email,
        subject: "Test",
        text: "Test message",
        html: "<p>Test message</p>"
      })
    );
    expect(await worker.drainOnce()).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toBe(`email/${first.id}`);
    const job = await db.query(
      "SELECT state, provider_message_id FROM email_jobs WHERE id = $1",
      [first.id]
    );
    expect(job.rows[0]).toEqual({
      state: "accepted",
      provider_message_id: "message-1"
    });
  });

  it("cancels optional messages after suppression", async () => {
    const { db, userId, emailIdentityId } = await fixture();
    const scheduled = await scheduleEmail(db, {
      userId,
      emailIdentityId,
      messageKind: "test_product",
      templateVersion: 1,
      category: "product",
      deduplicationKey: `test_product:${userId}:v1`,
      scheduledFor: new Date(Date.now() - 1_000)
    });
    await db.query(
      `INSERT INTO email_suppressions (email_identity_id, reason)
       VALUES ($1, 'unsubscribed')`,
      [emailIdentityId]
    );
    const send = vi.fn<EmailTransport["send"]>();
    const worker = new ScheduledEmailWorker(db, { send }, () => {
      throw new Error("A cancelled job must not render.");
    });

    expect(await worker.drainOnce()).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const job = await db.query(
      "SELECT state, last_error_code FROM email_jobs WHERE id = $1",
      [scheduled.id]
    );
    expect(job.rows[0]).toEqual({
      state: "cancelled",
      last_error_code: "preference_or_suppression"
    });
  });

  it("retries a temporary provider failure without changing its identity", async () => {
    const { db, userId, emailIdentityId } = await fixture();
    const scheduled = await scheduleEmail(db, {
      userId,
      emailIdentityId,
      messageKind: "test_retry",
      templateVersion: 1,
      category: "essential",
      deduplicationKey: `test_retry:${userId}:v1`,
      scheduledFor: new Date(Date.now() - 1_000)
    });
    const send = vi.fn(async () => {
      throw new EmailDeliveryError("rate_limited", true, 429);
    });
    const worker = new ScheduledEmailWorker(db, { send }, ({ email }) => ({
      to: email,
      subject: "Retry",
      text: "Retry",
      html: "<p>Retry</p>"
    }));

    expect(await worker.drainOnce()).toBe(1);
    const job = await db.query<{
      state: string;
      attempt_count: number;
      idempotency_key: string;
      next_attempt_at: Date;
    }>(
      `SELECT state, attempt_count, idempotency_key, next_attempt_at
       FROM email_jobs WHERE id = $1`,
      [scheduled.id]
    );
    expect(job.rows[0]).toMatchObject({
      state: "scheduled",
      attempt_count: 1,
      idempotency_key: `email/${scheduled.id}`
    });
    expect(job.rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  });
});

async function fixture(): Promise<{
  db: DatabasePool;
  userId: string;
  emailIdentityId: string;
}> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const userId = randomUUID();
  const emailIdentityId = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, NULL, 'Email user')",
    [userId]
  );
  await db.query(
    `INSERT INTO email_identities
       (id, user_id, email, normalized_email, normalization_version,
        verified_at, is_primary)
     VALUES ($1, $2, 'email@example.com', 'email@example.com', 1, now(), true)`,
    [emailIdentityId, userId]
  );
  await db.query(
    "INSERT INTO account_email_preferences (user_id) VALUES ($1)",
    [userId]
  );
  return { db, userId, emailIdentityId };
}
