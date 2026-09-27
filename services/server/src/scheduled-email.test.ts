import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "./database-types.js";
import { createDatabase } from "./db.js";
import { EmailDeliveryError, type EmailTransport } from "./email.js";
import {
  readEmailPreferences,
  redeemUnsubscribeToken,
  scheduleEmail,
  ScheduledEmailWorker,
  type EmailCategory
} from "./scheduled-email.js";

const PUBLIC_URL = "https://connect.example";
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
      ({ email, unsubscribeUrl }) => ({
        to: email,
        subject: "Test",
        text: `Test message\n\n${unsubscribeUrl}`,
        html: "<p>Test message</p>"
      }),
      PUBLIC_URL
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
    }, PUBLIC_URL);

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
    }), PUBLIC_URL);

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

  it("sends optional email with a working one-click unsubscribe", async () => {
    const { db, userId, emailIdentityId } = await fixture();
    await due(db, userId, emailIdentityId, "onboarding", "launch");
    const send = vi.fn<EmailTransport["send"]>(async () => ({
      provider: "test",
      messageId: "message-1"
    }));
    const worker = new ScheduledEmailWorker(db, { send }, ({ email, unsubscribeUrl }) => ({
      to: email,
      subject: "News",
      text: `News\n\nUnsubscribe: ${unsubscribeUrl}`,
      html: "<p>News</p>"
    }), PUBLIC_URL);

    expect(await worker.drainOnce()).toBe(1);
    const message = send.mock.calls[0]![0];
    const pageToken = new URLSearchParams(
      new URL(message.text.split("Unsubscribe: ")[1]!).hash.slice(1)
    ).get("unsubscribe");
    expect(message.text).toContain(`${PUBLIC_URL}/unsubscribe#unsubscribe=uns_`);
    expect(message.headers).toEqual({
      "List-Unsubscribe": `<${PUBLIC_URL}/v1/email/unsubscribe?token=${pageToken}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    });
    const stored = await db.query<{ token_hash: string }>(
      "SELECT token_hash FROM email_unsubscribe_tokens WHERE user_id = $1",
      [userId]
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.token_hash).not.toContain(pageToken!);

    expect(await redeemUnsubscribeToken(db, pageToken!)).toBe("announcements");
    expect(await readEmailPreferences(db, userId)).toEqual({
      announcements: false,
      product_updates: false
    });

    await due(db, userId, emailIdentityId, "onboarding", "second");
    await due(db, userId, emailIdentityId, "onboarding", "welcome");
    expect(await worker.drainOnce()).toBe(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it("refuses to send optional email whose template drops the unsubscribe link", async () => {
    const { db, userId, emailIdentityId } = await fixture();
    const scheduled = await due(db, userId, emailIdentityId, "onboarding", "welcome");
    const send = vi.fn<EmailTransport["send"]>();
    const worker = new ScheduledEmailWorker(db, { send }, ({ email }) => ({
      to: email,
      subject: "Welcome",
      text: "Welcome",
      html: "<p>Welcome</p>"
    }), PUBLIC_URL);

    expect(await worker.drainOnce()).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const job = await db.query(
      "SELECT state, last_error_code FROM email_jobs WHERE id = $1",
      [scheduled.id]
    );
    expect(job.rows[0]).toEqual({ state: "failed", last_error_code: "template_error" });
  });

  it("sends essential email without unsubscribe controls", async () => {
    const { db, userId, emailIdentityId } = await fixture();
    await db.query(
      `UPDATE account_email_preferences
       SET announcements_enabled = false, product_enabled = false
       WHERE user_id = $1`,
      [userId]
    );
    await due(db, userId, emailIdentityId, "essential", "notice");
    const send = vi.fn<EmailTransport["send"]>(async () => ({
      provider: "test",
      messageId: "message-1"
    }));
    const render = vi.fn(({ email }: { email: string }) => ({
      to: email,
      subject: "Notice",
      text: "Notice",
      html: "<p>Notice</p>"
    }));
    const worker = new ScheduledEmailWorker(db, { send }, render, PUBLIC_URL);

    expect(await worker.drainOnce()).toBe(1);
    expect(render.mock.calls[0]![0]).toMatchObject({ unsubscribeUrl: null });
    expect(send.mock.calls[0]![0].headers).toBeUndefined();
    const tokens = await db.query("SELECT 1 FROM email_unsubscribe_tokens");
    expect(tokens.rows).toHaveLength(0);
  });

  it("ignores malformed and unknown unsubscribe tokens", async () => {
    const { db } = await fixture();
    expect(await redeemUnsubscribeToken(db, "not-a-token")).toBeNull();
    expect(await redeemUnsubscribeToken(db, `uns_${"a".repeat(43)}`)).toBeNull();
  });
});

async function due(
  db: DatabasePool,
  userId: string,
  emailIdentityId: string,
  category: EmailCategory,
  kind: string
) {
  return scheduleEmail(db, {
    userId,
    emailIdentityId,
    messageKind: `test_${kind}`,
    templateVersion: 1,
    category,
    deduplicationKey: `test_${kind}:${userId}:v1`,
    scheduledFor: new Date(Date.now() - 1_000)
  });
}

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
