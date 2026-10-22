import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool, DatabaseQueryable } from "./db.js";
import {
  PushTargetKeyUnavailable,
  type PushTargetSealer
} from "./features/next/push-target-seal.js";
import {
  legacyTimerGrantResolver,
  type TimerGrantResolver
} from "./features/next/timers/grants.js";

import { readInstallationTimerDeclaration } from "./features/next/timers/installation-declaration.js";

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

class NotificationAdmissionError extends Error {
  constructor(cause: unknown) { super("Notification delivery admission failed.", {cause}); }
}

interface DeliveryRow {
  id: string;
  channel_id: string;
  grant_id: string;
  installation_id: string;
  sealed_target: string | null;
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
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly sealer?: PushTargetSealer,
    private readonly grantResolver: TimerGrantResolver = legacyTimerGrantResolver,
    private readonly serverEnvironment?: string
  ) {}

  /** Current policy, real legacy consent, channel and lease precede dispatch.
   * Admit the bounded transport under these locks, then release SQL BEFORE
   * waiting for its network result. Withdrawal cannot recall an already admitted
   * send; it prevents subsequent admission, without borrowing transport custody. */
  private async deliverIfCurrent<T extends DeliveryRow | WebhookDeliveryRow>(
    grantId: string, load: (db: DatabaseQueryable) => Promise<T | undefined>,
    send: (row: T) => Promise<void>
  ): Promise<"sent"|"grant_not_usable"|"criterion_removed"|"delivery_not_current"> {
    const connection = await this.db.connect();
    let outcome: Promise<{sent:true} | {sent:false;error:unknown}>;
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      // Native resolution holds its canonical principal/policy/consent locks.
      if (!(await this.grantResolver.resolve(connection,grantId))?.usable) {
        await connection.query("ROLLBACK"); return "grant_not_usable";
      }
      // Preserve actual legacy consent/user locks too; native IDs have no row
      // here and never obtain authority from this query or a fabricated grant.
      await connection.query(`SELECT g.id FROM grants g JOIN users u ON u.id=g.user_id
        WHERE g.id=$1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
          AND u.suspended_at IS NULL FOR SHARE`,[grantId]);
      const grant = await this.grantResolver.resolve(connection,grantId);
      if (!grant?.usable) { await connection.query("ROLLBACK"); return "grant_not_usable"; }
      if (grant.grantId !== grantId) throw new Error("Invalid notification grant identity.");
      const declaration = await backgroundGrantNotificationDeclaration(connection,grantId,this.serverEnvironment);
      const row = await load(connection);
      if (!row) { await connection.query("ROLLBACK"); return "delivery_not_current"; }
      if (row.grant_id !== grantId) throw new Error("Invalid notification channel grant identity.");
      if (!declaration || !grant.criteria.some(criterion=>criterion.id===row.criterion_id)
        || !declaration.notification_criteria.some(criterion=>criterion.id===row.criterion_id)) {
        await connection.query("ROLLBACK"); return "criterion_removed";
      }
      // Observe rejection immediately, including while COMMIT is pending.
      outcome = send({...row,...declaration}).then(()=>({sent:true as const}),error=>({sent:false as const,error}));
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw new NotificationAdmissionError(error);
    } finally { connection.release(); }
    const result = await outcome;
    if (!result.sent) throw result.error;
    return "sent";
  }

  /** The push-target sealer, when push targets are sealed at rest. */
  get pushTargetSealer(): PushTargetSealer | undefined {
    return this.sealer;
  }

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
      const outcome = await insertNotificationSignal(connection, input, this.serverEnvironment);
      if (outcome.duplicate) {
        await connection.query("ROLLBACK");
        return outcome;
      }
      await connection.query("COMMIT");
      void this.drainOnce().catch(this.onError);
      return outcome;
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
      `SELECT nd.id, nd.attempts, pc.id AS channel_id, pc.grant_id,
              pc.installation_id, pc.sealed_target, pc.kind, pc.endpoint,
              pc.p256dh, pc.auth, pc.expires_at, pc.fcm_project_id, pc.fcm_token,
              sig.signal_id, sig.criterion_id, sig.cursor
       FROM notification_deliveries nd
       JOIN notification_signals sig ON sig.id = nd.signal_id
       JOIN notification_subscriptions ns ON ns.id = nd.subscription_id
       JOIN push_channels pc ON pc.id = ns.channel_id

       WHERE (
         (nd.status IN ('pending', 'retry') AND nd.available_at <= now())
         OR (nd.status = 'sending' AND nd.leased_until < now())
       )
         AND pc.disabled_at IS NULL
       ORDER BY nd.created_at, nd.id
       LIMIT $1`,
      [limit]
    );
    let processed = 0;
    for (const row of ready.rows) {
      const leaseToken = await this.claim("notification_deliveries", row.id);
      if (!leaseToken) continue;
      processed += 1;
      try {
        const delivered = await this.deliverIfCurrent(row.grant_id,async db =>
          (await db.query<DeliveryRow>(`SELECT nd.id,nd.attempts,pc.id AS channel_id,pc.grant_id,
             pc.installation_id,pc.sealed_target,pc.kind,pc.endpoint,pc.p256dh,pc.auth,pc.expires_at,
             pc.fcm_project_id,pc.fcm_token,sig.signal_id,sig.criterion_id,sig.cursor
           FROM notification_deliveries nd
           JOIN notification_signals sig ON sig.id=nd.signal_id
           JOIN notification_subscriptions ns ON ns.id=nd.subscription_id
           JOIN push_channels pc ON pc.id=ns.channel_id
           WHERE nd.id=$1 AND nd.lease_token=$2 AND nd.status='sending' AND nd.leased_until>clock_timestamp()
             AND pc.disabled_at IS NULL AND pc.grant_id=$3 AND ns.grant_id=$3 AND sig.grant_id=$3
             AND ns.criterion_id=sig.criterion_id
           FOR UPDATE`,[row.id,leaseToken,row.grant_id])).rows[0],
          async current => {
            const payload = notificationPayload(current);
            if (!payload) throw new Error("Current notification criterion disappeared.");
            await this.sendPush(current,JSON.stringify(payload));
          });
        if (delivered === "sent") await this.markSent("notification_deliveries", row.id, leaseToken);
        else await this.finish("notification_deliveries", row.id, leaseToken, delivered);
      } catch (error) {
        if (error instanceof NotificationAdmissionError) throw error;
        await this.handlePushFailure(row, leaseToken, error);
      }
    }
    return processed;
  }

  private async drainWebhooks(limit: number): Promise<number> {
    const ready = await this.db.query<WebhookDeliveryRow>(
      `SELECT nwd.id, nwd.url, nwd.attempts, sig.signal_id, sig.grant_id,
              sig.criterion_id, sig.cursor
       FROM notification_webhook_deliveries nwd
       JOIN notification_signals sig ON sig.id = nwd.signal_id

       WHERE (
         (nwd.status IN ('pending', 'retry') AND nwd.available_at <= now())
         OR (nwd.status = 'sending' AND nwd.leased_until < now())
       )
       ORDER BY nwd.created_at, nwd.id
       LIMIT $1`,
      [limit]
    );
    let processed = 0;
    for (const row of ready.rows) {
      const leaseToken = await this.claim("notification_webhook_deliveries", row.id);
      if (!leaseToken) continue;
      processed += 1;
      try {
        const delivered = await this.deliverIfCurrent(row.grant_id,async db =>
          (await db.query<WebhookDeliveryRow>(`SELECT nwd.id,nwd.url,nwd.attempts,sig.signal_id,sig.grant_id,
              sig.criterion_id,sig.cursor FROM notification_webhook_deliveries nwd
           JOIN notification_signals sig ON sig.id=nwd.signal_id
           WHERE nwd.id=$1 AND nwd.lease_token=$2 AND nwd.status='sending' AND nwd.leased_until>clock_timestamp()
             AND sig.grant_id=$3 FOR UPDATE`,[row.id,leaseToken,row.grant_id])).rows[0],
          async current => {
            const route = current.notifications.native_delivery;
            if (route?.mode !== "webhook" || route.url !== current.url) throw new PushDeliveryError("Webhook route is no longer current.",true);
            const notification = notificationPayload(current);
            if (!notification) throw new Error("Current notification criterion disappeared.");
            if (!this.transports.webhook) throw new PushDeliveryError("Signed webhook delivery is not configured.",false,60*60_000);
            await this.transports.webhook.send({deliveryId:current.id,url:current.url},JSON.stringify({
              type:"mdbase.notification.webhook",version:1,delivery_id:current.id,
              connection_id:current.grant_id,notification
            }));
          });
        if (delivered === "sent") await this.markSent("notification_webhook_deliveries", row.id, leaseToken);
        else await this.finish("notification_webhook_deliveries", row.id, leaseToken, delivered);
      } catch (error) {
        if (error instanceof NotificationAdmissionError) throw error;
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

  private async sendPush(sealedRow: DeliveryRow, payload: string): Promise<void> {
    const row = this.openTarget(sealedRow);
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

  private openTarget(row: DeliveryRow): DeliveryRow {
    if (!row.sealed_target) return row;
    if (!this.sealer) {
      throw new PushDeliveryError(
        "Sealed push targets need MDBASE_NEXT_PUSH_TOKEN_KEY.",
        false,
        60 * 60_000
      );
    }
    try {
      const target = this.sealer.open(
        row.grant_id,
        row.installation_id,
        row.sealed_target
      );
      return {
        ...row,
        endpoint: target.endpoint ?? null,
        p256dh: target.p256dh ?? null,
        auth: target.auth ?? null,
        fcm_token: target.fcm_token ?? null
      };
    } catch (error) {
      if (error instanceof PushTargetKeyUnavailable) {
        throw new PushDeliveryError(error.message, false, 60 * 60_000);
      }
      throw new PushDeliveryError("Sealed push target could not be opened.", true);
    }
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

/** Delivery metadata, not authorization. Native presentation/transport comes
 * from its original frozen consent; legacy retains its real grant/application.
 * Callers must separately hold/check current principal and policy authority. */
export async function backgroundGrantNotificationDeclaration(
  db: DatabaseQueryable, grantId: string, serverEnvironment?: string
): Promise<{ notifications: ApplicationNotifications; notification_criteria: NotificationCriterion[] } | null> {
  const native = (await db.query<{timer_declaration:unknown;revoked_at:unknown}>(
    "SELECT timer_declaration,revoked_at FROM next_background_grants WHERE id=$1 AND principal_kind='installation'", [grantId]
  )).rows[0];
  if (native) {
    if (native.revoked_at !== null) return null;
    const declaration = readInstallationTimerDeclaration(native.timer_declaration, serverEnvironment);
    return { notifications: declaration.notifications, notification_criteria: declaration.notifications.criteria };
  }
  return (await db.query<{ notifications:ApplicationNotifications;notification_criteria:NotificationCriterion[] }>(
    `SELECT a.notifications,g.notification_criteria FROM grants g
     JOIN applications a ON a.id=g.application_id
     WHERE g.id=$1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL`, [grantId]
  )).rows[0] ?? null;
}

/**
 * Insert one opaque signal and its deliveries inside the caller's transaction.
 * Idempotent on `signal_id`. Callers commit, then wake the drain loop.
 */
export async function insertNotificationSignal(
  connection: DatabaseQueryable,
  input: NotificationSignalInput,
  serverEnvironment?: string
): Promise<{ duplicate: boolean; deliveries: number }> {
  const existing = await connection.query<{ id: string }>(
    "SELECT id FROM notification_signals WHERE signal_id = $1",
    [input.signalId]
  );
  if (existing.rows[0]) return { duplicate: true, deliveries: 0 };
  const signal = await connection.query<{ id: string }>(
    `INSERT INTO notification_signals
       (id, signal_id, grant_id, criterion_id, cursor)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(signal_id) DO NOTHING
     RETURNING id`,
    [randomUUID(), input.signalId, input.grantId, input.criterionId, input.cursor]
  );
  if (!signal.rows[0]) return { duplicate: true, deliveries: 0 };
  const declaration = await backgroundGrantNotificationDeclaration(connection, input.grantId, serverEnvironment);
  if (!declaration || !declaration.notification_criteria.some(criterion => criterion.id === input.criterionId)) {
    return { duplicate: false, deliveries: 0 };
  }
  const subscriptions = await connection.query<{ id: string }>(
    `SELECT ns.id
     FROM notification_subscriptions ns
     JOIN push_channels pc ON pc.id = ns.channel_id
     WHERE ns.grant_id = $1 AND ns.criterion_id = $2
       AND pc.disabled_at IS NULL`,
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
  const nativeDelivery = declaration.notifications.native_delivery;
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
  return { duplicate: false, deliveries };
}

export async function activeGrantForToken(
  db: DatabaseQueryable,
  tokenHash: string
): Promise<{ grant_id: string; application_id: string } | null> {
  const result = await db.query<{ grant_id: string; application_id: string }>(
    `SELECT g.id AS grant_id, g.application_id
     FROM access_tokens tok
     JOIN grants g ON g.id = tok.grant_id
     JOIN users u ON u.id = g.user_id
     WHERE tok.token_hash = $1 AND tok.expires_at > clock_timestamp()
       AND tok.revoked_at IS NULL AND g.revoked_at IS NULL
       AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL`,
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
