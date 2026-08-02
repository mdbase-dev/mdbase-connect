import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import type { DatabasePool } from "./database-types.js";
import { scheduleEmail } from "./scheduled-email.js";

const resources: Array<() => Promise<void>> = [];
const signingSecret = `whsec_${Buffer.alloc(32, "w").toString("base64")}`;

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("Resend provider webhooks", () => {
  it("verifies, deduplicates, and applies delivery events", async () => {
    const { db, jobId } = await fixture();
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      resendWebhookSecret: signingSecret
    });
    resources.push(() => app.close());
    const event = {
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: { email_id: "resend-message-1" }
    };
    const payload = JSON.stringify(event);
    const headers = signedHeaders(payload, "event-1");

    const first = await app.inject({
      method: "POST",
      url: "/v1/email/provider-events/resend",
      headers: { "content-type": "application/json", ...headers },
      payload
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/email/provider-events/resend",
      headers: { "content-type": "application/json", ...headers },
      payload
    });

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    const job = await db.query(
      "SELECT state, delivered_at FROM email_jobs WHERE id = $1",
      [jobId]
    );
    expect(job.rows[0]?.state).toBe("delivered");
    expect(job.rows[0]?.delivered_at).not.toBeNull();
    const events = await db.query("SELECT event_id FROM email_provider_events");
    expect(events.rows).toHaveLength(1);
  });

  it("rejects invalid signatures and suppresses bounced identities", async () => {
    const { db, emailIdentityId } = await fixture();
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      resendWebhookSecret: signingSecret
    });
    resources.push(() => app.close());
    const event = {
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: { email_id: "resend-message-1" }
    };
    const payload = JSON.stringify(event);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/email/provider-events/resend",
      headers: {
        "content-type": "application/json",
        "svix-id": "event-invalid",
        "svix-timestamp": `${Math.floor(Date.now() / 1_000)}`,
        "svix-signature": "v1,invalid"
      },
      payload
    });
    expect(invalid.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/email/provider-events/resend",
      headers: {
        "content-type": "application/json",
        ...signedHeaders(payload, "event-bounced")
      },
      payload
    });
    expect(accepted.statusCode).toBe(200);
    const suppression = await db.query(
      `SELECT reason, source_event_id FROM email_suppressions
       WHERE email_identity_id = $1`,
      [emailIdentityId]
    );
    expect(suppression.rows[0]).toEqual({
      reason: "bounced",
      source_event_id: "event-bounced"
    });
  });
});

async function fixture(): Promise<{
  db: DatabasePool;
  jobId: string;
  emailIdentityId: string;
}> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const userId = randomUUID();
  const emailIdentityId = randomUUID();
  await db.query(
    "INSERT INTO users (id, email, name) VALUES ($1, NULL, 'Webhook user')",
    [userId]
  );
  await db.query(
    `INSERT INTO email_identities
       (id, user_id, email, normalized_email, normalization_version,
        verified_at, is_primary)
     VALUES ($1, $2, 'webhook@example.com', 'webhook@example.com', 1, now(), true)`,
    [emailIdentityId, userId]
  );
  await db.query(
    "INSERT INTO account_email_preferences (user_id) VALUES ($1)",
    [userId]
  );
  const scheduled = await scheduleEmail(db, {
    userId,
    emailIdentityId,
    messageKind: "test_webhook",
    templateVersion: 1,
    category: "essential",
    deduplicationKey: `test_webhook:${userId}:v1`,
    scheduledFor: new Date()
  });
  await db.query(
    `UPDATE email_jobs SET state = 'accepted', provider = 'resend',
       provider_message_id = 'resend-message-1', accepted_at = now()
     WHERE id = $1`,
    [scheduled.id]
  );
  return { db, jobId: scheduled.id, emailIdentityId };
}

function signedHeaders(payload: string, eventId: string): Record<string, string> {
  const timestamp = new Date();
  const signature = new Webhook(signingSecret).sign(eventId, timestamp, payload);
  return {
    "svix-id": eventId,
    "svix-timestamp": `${Math.floor(timestamp.getTime() / 1_000)}`,
    "svix-signature": signature
  };
}
