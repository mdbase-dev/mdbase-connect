import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "./db.js";

export interface PushSubscriptionTarget {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushTransport {
  send(target: PushSubscriptionTarget, payload: string): Promise<void>;
}

export class PushDeliveryError extends Error {
  constructor(message: string, readonly permanent = false) {
    super(message);
  }
}

interface DeliveryRow {
  id: string;
  channel_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at: string | null;
  signal_id: string;
  criterion_id: string;
  cursor: string;
  attempts: number;
  notifications: {
    criteria?: Array<{
      id: string;
      presentation: { title: string; body?: string; tag?: string };
    }>;
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
    private readonly transport: PushTransport,
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

  async enqueue(input: NotificationSignalInput): Promise<{ duplicate: boolean; deliveries: number }> {
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
           AND pc.disabled_at IS NULL AND g.revoked_at IS NULL`,
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
    const ready = await this.db.query<DeliveryRow>(
      `SELECT nd.id, nd.attempts, pc.id AS channel_id, pc.endpoint, pc.p256dh, pc.auth,
              pc.expires_at, sig.signal_id, sig.criterion_id, sig.cursor, a.notifications
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
       ORDER BY nd.created_at, nd.id
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 500))]
    );
    let processed = 0;
    for (const row of ready.rows) {
      const leaseToken = randomUUID();
      const claimed = await this.db.query(
        `UPDATE notification_deliveries
         SET status = 'sending', lease_token = $2, leased_until = $3, attempts = attempts + 1
         WHERE id = $1 AND (
           (status IN ('pending', 'retry') AND available_at <= now())
           OR (status = 'sending' AND leased_until < now())
         )
         RETURNING id`,
        [row.id, leaseToken, new Date(Date.now() + 30_000).toISOString()]
      );
      if (!claimed.rows[0]) continue;
      processed += 1;
      const criterion = row.notifications.criteria?.find((candidate) => candidate.id === row.criterion_id);
      if (!criterion) {
        await this.finish(row.id, leaseToken, "discarded", "criterion_removed");
        continue;
      }
      const payload = JSON.stringify({
        type: "mdbase.notification",
        version: 1,
        signal_id: row.signal_id,
        criterion_id: row.criterion_id,
        cursor: row.cursor,
        presentation: criterion.presentation
      });
      try {
        await this.transport.send({
          endpoint: row.endpoint,
          expirationTime: row.expires_at ? Date.parse(row.expires_at) : null,
          keys: { p256dh: row.p256dh, auth: row.auth }
        }, payload);
        await this.db.query(
          `UPDATE notification_deliveries
           SET status = 'sent', delivered_at = now(), lease_token = NULL, leased_until = NULL,
               last_error = NULL
           WHERE id = $1 AND lease_token = $2`,
          [row.id, leaseToken]
        );
      } catch (error) {
        const deliveryError = error instanceof PushDeliveryError
          ? error
          : new PushDeliveryError(error instanceof Error ? error.message : "Push delivery failed.");
        if (deliveryError.permanent) {
          await this.db.query(
            "UPDATE push_channels SET disabled_at = now(), updated_at = now() WHERE id = $1",
            [row.channel_id]
          );
          await this.finish(row.id, leaseToken, "discarded", deliveryError.message);
        } else {
          const delayMs = retryDelayMs(row.attempts + 1);
          await this.db.query(
            `UPDATE notification_deliveries
             SET status = 'retry', available_at = $3, lease_token = NULL, leased_until = NULL,
                 last_error = $4
             WHERE id = $1 AND lease_token = $2`,
            [row.id, leaseToken, new Date(Date.now() + delayMs).toISOString(), deliveryError.message.slice(0, 500)]
          );
        }
      }
    }
    return processed;
  }

  private async finish(
    id: string,
    leaseToken: string,
    status: "discarded",
    error: string
  ): Promise<void> {
    await this.db.query(
      `UPDATE notification_deliveries
       SET status = $3, lease_token = NULL, leased_until = NULL, last_error = $4
       WHERE id = $1 AND lease_token = $2`,
      [id, leaseToken, status, error]
    );
  }
}

export async function activeGrantForToken(
  db: DatabaseQueryable,
  tokenHash: string
): Promise<{ grant_id: string; application_id: string } | null> {
  const result = await db.query<{ grant_id: string; application_id: string }>(
    `SELECT g.id AS grant_id, g.application_id
     FROM access_tokens tok
     JOIN grants g ON g.id = tok.grant_id
     WHERE tok.token_hash = $1 AND tok.expires_at > now()
       AND tok.revoked_at IS NULL AND g.revoked_at IS NULL`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 1_000 * (2 ** Math.min(attempt - 1, 10)));
}
