import type { FastifyInstance } from "fastify";
import { Webhook } from "svix";
import type { DatabasePool, DatabaseQueryable } from "./database-types.js";
import { apiError } from "./platform/http-errors.js";

interface ResendWebhookOptions {
  db: DatabasePool;
  signingSecret: string;
}

interface ResendEvent {
  type: string;
  created_at: string;
  data: {
    email_id: string;
  };
}

const TRACKED_EVENTS = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.failed",
  "email.bounced",
  "email.complained",
  "email.suppressed"
]);

export function registerResendWebhookRoute(
  app: FastifyInstance,
  options: ResendWebhookOptions
): void {
  const webhook = new Webhook(options.signingSecret);
  app.post(
    "/v1/email/provider-events/resend",
    { config: { rawBody: true } },
    async (request, reply) => {
      const rawBody = request.rawBody;
      const eventId = oneHeader(request.headers["svix-id"]);
      const timestamp = oneHeader(request.headers["svix-timestamp"]);
      const signature = oneHeader(request.headers["svix-signature"]);
      if (
        typeof rawBody !== "string"
        || !eventId
        || !timestamp
        || !signature
      ) {
        return reply.code(400).send(
          apiError("invalid_webhook", "The webhook request is invalid.")
        );
      }

      let verified: unknown;
      try {
        verified = webhook.verify(rawBody, {
          "svix-id": eventId,
          "svix-timestamp": timestamp,
          "svix-signature": signature
        });
      } catch {
        return reply.code(400).send(
          apiError("invalid_webhook", "The webhook signature is invalid.")
        );
      }
      if (!isResendEvent(verified)) {
        return reply.code(400).send(
          apiError("invalid_webhook", "The webhook payload is invalid.")
        );
      }

      await ingestResendEvent(options.db, eventId, verified);
      return reply.code(200).send({ ok: true });
    }
  );
}

export async function ingestResendEvent(
  db: DatabasePool,
  eventId: string,
  event: ResendEvent
): Promise<boolean> {
  if (!TRACKED_EVENTS.has(event.type)) return false;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const inserted = await connection.query<{ event_id: string }>(
      `INSERT INTO email_provider_events
         (provider, event_id, provider_message_id, event_type, event_created_at)
       VALUES ('resend', $1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [eventId, event.data.email_id, event.type, event.created_at]
    );
    if (!inserted.rows[0]) {
      await connection.query("COMMIT");
      return false;
    }
    await applyEvent(connection, eventId, event);
    await connection.query("COMMIT");
    return true;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function applyEvent(
  db: DatabaseQueryable,
  eventId: string,
  event: ResendEvent
): Promise<void> {
  const state = eventState(event.type);
  if (state) {
    await db.query(
      `UPDATE email_jobs SET
         state = $2,
         delivered_at = CASE WHEN $2 = 'delivered' THEN $3 ELSE delivered_at END,
         last_error_code = CASE
           WHEN $2 = 'failed' THEN replace($4, 'email.', '')
           ELSE last_error_code
         END,
         last_provider_event_at = $3,
         updated_at = now()
       WHERE provider = 'resend'
         AND provider_message_id = $1
         AND (last_provider_event_at IS NULL OR last_provider_event_at <= $3)
         AND state NOT IN ('cancelled', 'uncertain')`,
      [event.data.email_id, state, event.created_at, event.type]
    );
  }

  const suppressionReason = event.type === "email.complained"
    ? "complained"
    : event.type === "email.bounced" || event.type === "email.suppressed"
      ? "bounced"
      : null;
  if (!suppressionReason) return;
  await db.query(
    `INSERT INTO email_suppressions
       (email_identity_id, reason, source_event_id)
     SELECT job.email_identity_id, $3, $2
     FROM email_jobs job
     WHERE job.provider = 'resend' AND job.provider_message_id = $1
     ON CONFLICT (email_identity_id) DO UPDATE SET
       reason = EXCLUDED.reason,
       source_event_id = EXCLUDED.source_event_id,
       created_at = now()`,
    [event.data.email_id, eventId, suppressionReason]
  );
}

function eventState(type: string): "accepted" | "delivered" | "failed" | null {
  if (type === "email.sent" || type === "email.delivery_delayed") return "accepted";
  if (type === "email.delivered") return "delivered";
  if (
    type === "email.failed"
    || type === "email.bounced"
    || type === "email.complained"
    || type === "email.suppressed"
  ) return "failed";
  return null;
}

function isResendEvent(value: unknown): value is ResendEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ResendEvent>;
  return typeof event.type === "string"
    && typeof event.created_at === "string"
    && Number.isFinite(Date.parse(event.created_at))
    && Boolean(event.data)
    && typeof event.data?.email_id === "string"
    && event.data.email_id.length > 0;
}

function oneHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value ? value : null;
}
