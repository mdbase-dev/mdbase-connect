import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  NotificationCriterion
} from "@mdbase/connect-protocol";
import type { DatabasePool, DatabaseQueryable } from "./db.js";

export interface PushSubscriptionTarget {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface FcmPushTarget {
  projectId: string;
  token: string;
}

export interface PushTransport {
  send(target: PushSubscriptionTarget, payload: string): Promise<void>;
}

export interface FcmPushTransport {
  send(target: FcmPushTarget, payload: string): Promise<void>;
}

export interface WebhookDeliveryTarget {
  deliveryId: string;
  url: string;
}

export interface NotificationSigningKey extends JsonWebKey {
  kid: string;
}

export interface WebhookDeliveryTransport {
  send(target: WebhookDeliveryTarget, payload: string): Promise<void>;
  publicKeys(): NotificationSigningKey[];
}

export interface NotificationTransports {
  webPush?: PushTransport;
  fcm?: FcmPushTransport;
  webhook?: WebhookDeliveryTransport;
}

export class PushDeliveryError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
    readonly retryAfterMs?: number
  ) {
    super(message);
  }
}

interface DeliveryRow {
  id: string;
  channel_id: string;
  kind: "web_push" | "fcm";
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  expires_at: string | null;
  fcm_project_id: string | null;
  fcm_token: string | null;
  signal_id: string;
  criterion_id: string;
  cursor: string;
  attempts: number;
  notifications: ApplicationNotifications;
  notification_criteria: NotificationCriterion[];
}

interface WebhookDeliveryRow {
  id: string;
  url: string;
  signal_id: string;
  grant_id: string;
  criterion_id: string;
  cursor: string;
  attempts: number;
  notifications: ApplicationNotifications;
  notification_criteria: NotificationCriterion[];
}

interface NotificationPayload {
  type: "mdbase.notification";
  version: 1;
  signal_id: string;
  criterion_id: string;
  cursor: string;
  presentation: {
    title: string;
    body?: string;
    tag?: string;
  };
}

export interface NotificationSignalInput {
  signalId: string;
  grantId: string;
  criterionId: string;
  cursor: string;
}

export class NotificationService {
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<number> | null = null;

  constructor(
    private readonly db: DatabasePool,
    private readonly transports: NotificationTransports,
    private readonly pollIntervalMs = 1_000,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.drainOnce().catch(this.onError),
      this.pollIntervalMs
    );
    this.timer.unref();
    void this.drainOnce().catch(this.onError);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  async enqueue(input: NotificationSignalInput): Promise<{
    duplicate: boolean;
    deliveries: number;
  }> {
    const connection = await this.db.connect();
    try {
      await connection.query("BEGIN");
      const existing = await connection.query<{ id: string }>(
        "SELECT id FROM notification_signals WHERE signal_id = $1",
        [input.signalId]
      );
      if (existing.rows[0]) {
        await connection.query("ROLLBACK");
        return { duplicate: true, deliveries: 0 };
      }
      const signal = await connection.query<{ id: string }>(
        `INSERT INTO notification_signals
           (id, signal_id, grant_id, criterion_id, cursor)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(signal_id) DO NOTHING
         RETURNING id`,
        [randomUUID(), input.signalId, input.grantId, input.criterionId, input.cursor]
      );
      if (!signal.rows[0]) {
        await connection.query("ROLLBACK");
        return { duplicate: true, deliveries: 0 };
      }
      const subscriptions = await connection.query<{ id: string }>(
        `SELECT ns.id
         FROM notification_subscriptions ns
         JOIN push_channels pc ON pc.id = ns.channel_id
         JOIN grants g ON g.id = ns.grant_id
         WHERE ns.grant_id = $1 AND ns.criterion_id = $2
           AND pc.disabled_at IS NULL AND g.revoked_at IS NULL
           AND g.activated_at IS NOT NULL`,
        [input.grantId, input.criterionId]
      );
      let deliveries = 0;
      for (const subscription of subscriptions.rows) {
        const inserted = await connection.query(
          `INSERT INTO notification_deliveries (id, signal_id, subscription_id)
           VALUES ($1, $2, $3)
           ON CONFLICT(signal_id, subscription_id) DO NOTHING
           RETURNING id`,
          [randomUUID(), signal.rows[0].id, subscription.id]
        );
        deliveries += inserted.rowCount ?? inserted.rows.length;
      }
      const route = await connection.query<{
        notifications: ApplicationNotifications;
      }>(
        `SELECT a.notifications
         FROM grants g
         JOIN applications a ON a.id = g.application_id
         WHERE g.id = $1 AND g.revoked_at IS NULL
           AND g.activated_at IS NOT NULL`,
        [input.grantId]
      );
      const nativeDelivery = route.rows[0]?.notifications.native_delivery;
      if (nativeDelivery?.mode === "webhook") {
        const inserted = await connection.query(
          `INSERT INTO notification_webhook_deliveries (id, signal_id, url)
           VALUES ($1, $2, $3)
           ON CONFLICT(signal_id) DO NOTHING
           RETURNING id`,
          [randomUUID(), signal.rows[0].id, nativeDelivery.url]
        );
        deliveries += inserted.rowCount ?? inserted.rows.length;
      }
      await connection.query("COMMIT");
      void this.drainOnce().catch(this.onError);
      return { duplicate: false, deliveries };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }

  drainOnce(limit = 50): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = this.performDrain(limit).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async performDrain(limit: number): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const pushes = await this.drainPushes(boundedLimit);
    const webhooks = await this.drainWebhooks(boundedLimit);
    return pushes + webhooks;
  }

  private async drainPushes(limit: number): Promise<number> {
    const ready = await this.db.query<DeliveryRow>(
      `SELECT nd.id, nd.attempts, pc.id AS channel_id, pc.kind, pc.endpoint,
              pc.p256dh, pc.auth, pc.expires_at, pc.fcm_project_id, pc.fcm_token,
              sig.signal_id, sig.criterion_id, sig.cursor, a.notifications,
              g.notification_criteria
       FROM notification_deliveries nd
       JOIN notification_signals sig ON sig.id = nd.signal_id
       JOIN notification_subscriptions ns ON ns.id = nd.subscription_id
       JOIN push_channels pc ON pc.id = ns.channel_id
       JOIN grants g ON g.id = ns.grant_id
       JOIN applications a ON a.id = g.application_id
       WHERE (
         (nd.status IN ('pending', 'retry') AND nd.available_at <= now())
         OR (nd.status = 'sending' AND nd.leased_until < now())
       )
         AND pc.disabled_at IS NULL AND g.revoked_at IS NULL
         AND g.activated_at IS NOT NULL
       ORDER BY nd.created_at, nd.id
       LIMIT $1`,
      [limit]
    );
    let processed = 0;
    for (const row of ready.rows) {
      const leaseToken = await this.claim("notification_deliveries", row.id);
      if (!leaseToken) continue;
      processed += 1;
      const payload = notificationPayload(row);
      if (!payload) {
        await this.finish(
          "notification_deliveries",
          row.id,
          leaseToken,
          "criterion_removed"
        );
        continue;
      }
      try {
        await this.sendPush(row, JSON.stringify(payload));
        await this.markSent("notification_deliveries", row.id, leaseToken);
      } catch (error) {
        await this.handlePushFailure(row, leaseToken, error);
      }
    }
    return processed;
  }

  private async drainWebhooks(limit: number): Promise<number> {
    const ready = await this.db.query<WebhookDeliveryRow>(
      `SELECT nwd.id, nwd.url, nwd.attempts, sig.signal_id, sig.grant_id,
              sig.criterion_id, sig.cursor, a.notifications,
              g.notification_criteria
       FROM notification_webhook_deliveries nwd
       JOIN notification_signals sig ON sig.id = nwd.signal_id
       JOIN grants g ON g.id = sig.grant_id
       JOIN applications a ON a.id = g.application_id
       WHERE (
         (nwd.status IN ('pending', 'retry') AND nwd.available_at <= now())
         OR (nwd.status = 'sending' AND nwd.leased_until < now())
       )
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
       ORDER BY nwd.created_at, nwd.id
       LIMIT $1`,
      [limit]
    );
    let processed = 0;
    for (const row of ready.rows) {
      const leaseToken = await this.claim("notification_webhook_deliveries", row.id);
      if (!leaseToken) continue;
      processed += 1;
      const notification = notificationPayload(row);
      if (!notification) {
        await this.finish(
          "notification_webhook_deliveries",
          row.id,
          leaseToken,
          "criterion_removed"
        );
        continue;
      }
      const currentRoute = row.notifications.native_delivery;
      if (
        currentRoute?.mode !== "webhook"
        || currentRoute.url !== row.url
      ) {
        await this.finish(
          "notification_webhook_deliveries",
          row.id,
          leaseToken,
          "webhook_route_removed"
        );
        continue;
      }
      if (!this.transports.webhook) {
        await this.retry(
          "notification_webhook_deliveries",
          row.id,
          leaseToken,
          row.attempts + 1,
          new PushDeliveryError("Signed webhook delivery is not configured.", false, 60 * 60_000)
        );
        continue;
      }
      const payload = JSON.stringify({
        type: "mdbase.notification.webhook",
        version: 1,
        delivery_id: row.id,
        connection_id: row.grant_id,
        notification
      });
      try {
        await this.transports.webhook.send(
          { deliveryId: row.id, url: row.url },
          payload
        );
        await this.markSent(
          "notification_webhook_deliveries",
          row.id,
          leaseToken
        );
      } catch (error) {
        const deliveryError = asDeliveryError(error, "Webhook delivery failed.");
        if (deliveryError.permanent || row.attempts + 1 >= 20) {
          await this.finish(
            "notification_webhook_deliveries",
            row.id,
            leaseToken,
            deliveryError.message
          );
        } else {
          await this.retry(
            "notification_webhook_deliveries",
            row.id,
            leaseToken,
            row.attempts + 1,
            deliveryError
          );
        }
      }
    }
    return processed;
  }

  private async sendPush(row: DeliveryRow, payload: string): Promise<void> {
    if (row.kind === "fcm") {
      if (!this.transports.fcm) {
        throw new PushDeliveryError(
          "Managed FCM delivery is not configured.",
          false,
          60 * 60_000
        );
      }
      if (!row.fcm_project_id || !row.fcm_token) {
        throw new PushDeliveryError("FCM channel target is incomplete.", true);
      }
      const currentRoute = row.notifications.native_delivery;
      if (
        currentRoute?.mode !== "managed_fcm"
        || currentRoute.firebase_project_id !== row.fcm_project_id
      ) {
        throw new PushDeliveryError(
          "The application no longer declares this FCM project.",
          true
        );
      }
      await this.transports.fcm.send({
        projectId: row.fcm_project_id,
        token: row.fcm_token
      }, payload);
      return;
    }
    if (!this.transports.webPush) {
      throw new PushDeliveryError(
        "Web Push delivery is not configured.",
        false,
        60 * 60_000
      );
    }
    if (!row.endpoint || !row.p256dh || !row.auth) {
      throw new PushDeliveryError("Web Push channel target is incomplete.", true);
    }
    await this.transports.webPush.send({
      endpoint: row.endpoint,
      expirationTime: row.expires_at ? Date.parse(row.expires_at) : null,
      keys: { p256dh: row.p256dh, auth: row.auth }
    }, payload);
  }

  private async handlePushFailure(
    row: DeliveryRow,
    leaseToken: string,
    error: unknown
  ): Promise<void> {
    const deliveryError = asDeliveryError(error, "Push delivery failed.");
    if (deliveryError.permanent) {
      await this.db.query(
        "UPDATE push_channels SET disabled_at = now(), updated_at = now() WHERE id = $1",
        [row.channel_id]
      );
      await this.finish(
        "notification_deliveries",
        row.id,
        leaseToken,
        deliveryError.message
      );
    } else {
      await this.retry(
        "notification_deliveries",
        row.id,
        leaseToken,
        row.attempts + 1,
        deliveryError
      );
    }
  }

  private async claim(table: DeliveryTable, id: string): Promise<string | null> {
    const leaseToken = randomUUID();
    const claimed = await this.db.query(
      `UPDATE ${table}
       SET status = 'sending', lease_token = $2, leased_until = $3,
           attempts = attempts + 1
       WHERE id = $1 AND (
         (status IN ('pending', 'retry') AND available_at <= now())
         OR (status = 'sending' AND leased_until < now())
       )
       RETURNING id`,
      [id, leaseToken, new Date(Date.now() + 30_000).toISOString()]
    );
    return claimed.rows[0] ? leaseToken : null;
  }

  private async markSent(
    table: DeliveryTable,
    id: string,
    leaseToken: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE ${table}
       SET status = 'sent', delivered_at = now(), lease_token = NULL,
           leased_until = NULL, last_error = NULL
       WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken]
    );
  }

  private async retry(
    table: DeliveryTable,
    id: string,
    leaseToken: string,
    attempt: number,
    error: PushDeliveryError
  ): Promise<void> {
    const delayMs = Math.max(
      retryDelayMs(attempt),
      Math.min(error.retryAfterMs ?? 0, 24 * 60 * 60_000)
    );
    await this.db.query(
      `UPDATE ${table}
       SET status = 'retry', available_at = $3, lease_token = NULL,
           leased_until = NULL, last_error = $4
       WHERE id = $1 AND lease_token = $2`,
      [
        id,
        leaseToken,
        new Date(Date.now() + delayMs).toISOString(),
        error.message.slice(0, 500)
      ]
    );
  }

  private async finish(
    table: DeliveryTable,
    id: string,
    leaseToken: string,
    error: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE ${table}
       SET status = 'discarded', lease_token = NULL, leased_until = NULL,
           last_error = $3
       WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken, error.slice(0, 500)]
    );
  }
}

type DeliveryTable =
  | "notification_deliveries"
  | "notification_webhook_deliveries";

export async function activeGrantForToken(
  db: DatabaseQueryable,
  tokenHash: string
): Promise<{ grant_id: string; application_id: string } | null> {
  const result = await db.query<{ grant_id: string; application_id: string }>(
    `SELECT g.id AS grant_id, g.application_id
     FROM access_tokens tok
     JOIN grants g ON g.id = tok.grant_id
     WHERE tok.token_hash = $1 AND tok.expires_at > now()
       AND tok.revoked_at IS NULL AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

function notificationPayload(row: {
  signal_id: string;
  criterion_id: string;
  cursor: string;
  notification_criteria: NotificationCriterion[];
}): NotificationPayload | null {
  const criterion = row.notification_criteria.find(
    (candidate) => candidate.id === row.criterion_id
  );
  if (!criterion) return null;
  return {
    type: "mdbase.notification",
    version: 1,
    signal_id: row.signal_id,
    criterion_id: row.criterion_id,
    cursor: row.cursor,
    presentation: criterion.presentation
  };
}

function asDeliveryError(error: unknown, fallback: string): PushDeliveryError {
  return error instanceof PushDeliveryError
    ? error
    : new PushDeliveryError(error instanceof Error ? error.message : fallback);
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 1_000 * (2 ** Math.min(attempt - 1, 12)));
}
