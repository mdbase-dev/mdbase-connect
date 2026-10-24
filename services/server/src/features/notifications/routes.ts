import { randomUUID } from "node:crypto";
import type {
  ApplicationNotifications,
  NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import {
  activeGrantForToken,
  backgroundGrantNotificationDeclaration,
  type NotificationService,
  type NotificationTransports
} from "../../notifications.js";
import { tokenHash } from "../../security.js";
import {
  currentInstallationTimerAuthority,
  grantMayFire,
  legacyTimerGrantResolver,
  type TimerGrantResolver
} from "../next/timers/grants.js";
import { apiError } from "../../platform/http-errors.js";
import { TimerError } from "../next/timers/model.js";
import {
  bearerToken,
  requireConnector
} from "../../platform/request-authentication.js";

interface NotificationRoutesOptions {
  serverEnvironment?: string;
  db: DatabasePool;
  service?: NotificationService;
  publicKey?: string;
  transports?: NotificationTransports;
  hostedProvider?: HostedProviderClient;
  /** Fail-closed grant resolver shared with the timer service. */
  grantResolver?: TimerGrantResolver;
}

const signalSchema = z.object({
  signal_id: z.string().min(16).max(200),
  grant_id: z.uuid(),
  criterion_id: z.string().min(1).max(100),
  cursor: z.string().min(1).max(200)
}).strict();

export function registerNotificationRoutes(
  app: FastifyInstance,
  options: NotificationRoutesOptions
): void {
  app.get(
    "/v1/notifications/vapid-public-key",
    async (_request, reply) => {
      if (!options.publicKey) {
        return reply.code(404).send(apiError(
          "notifications_unavailable",
          "Push notifications are not configured."
        ));
      }
      return { public_key: options.publicKey };
    }
  );

  app.get(
    "/v1/notifications/webhook-signing-keys",
    async (_request, reply) => {
      const webhook = options.transports?.webhook;
      if (!webhook) {
        return reply.code(404).send(apiError(
          "webhooks_unavailable",
          "Signed notification webhooks are not configured."
        ));
      }
      reply.header("cache-control", "public, max-age=300");
      return { keys: webhook.publicKeys() };
    }
  );

  const registerChannel = (installation: boolean): RouteHandlerMethod => async (request, reply) => {
    if (!options.service) {
      return notificationsUnavailable(reply);
    }
    const bearer = bearerToken(request);
    if (!bearer) {
      return reply.code(401).send(apiError(
        "invalid_token",
        "Bearer token required."
      ));
    }
    const baseChannel = {
      installation_id: z.string().min(16).max(200),
      criteria: z.array(z.string().min(1).max(100)).min(1).max(100)
    } as const;
    const input = z.union([
      z.object({
        ...baseChannel,
        transport: z.literal("web_push").optional(),
        subscription: z.object({
          endpoint: z.url().refine(
            (value) => new URL(value).protocol === "https:",
            "Push endpoint must use HTTPS."
          ),
          expirationTime: z.number().int().positive().nullable().optional(),
          keys: z.object({
            p256dh: z.string().min(16).max(512),
            auth: z.string().min(8).max(256)
          }).strict()
        }).strict()
      }).strict(),
      z.object({
        ...baseChannel,
        transport: z.literal("fcm"),
        token: z.string().min(32).max(4_096)
      }).strict()
    ]).parse(request.body);
    const criteria = [...new Set(input.criteria)];
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      const resolver = options.grantResolver ?? legacyTimerGrantResolver;
      const authenticate = async () => {
        if (installation) {
          const params = z.object({collection:z.uuid(),grant:z.uuid()}).parse(request.params);
          const authority = await currentInstallationTimerAuthority(connection,resolver,params.collection,params.grant,tokenHash(bearer));
          if (input.installation_id !== authority.installationId) throw new TimerError(403,"forbidden","The channel is not for this installation.");
          if (criteria.some(criterion => !grantMayFire(authority.grant,criterion))) {
            throw new TimerError(400,"notification_reauthorization_required","The timer consent does not authorize this notification criterion.");
          }
          return {grant_id:authority.grant.grantId,application_id:authority.grant.applicationId};
        }
        const retained = await activeGrantForToken(connection,tokenHash(bearer));
        if (!retained) throw new TimerError(401,"invalid_token","Access token is invalid or expired.");
        if (!(await resolver.resolve(connection,retained.grant_id))?.usable) {
          throw new TimerError(403,"forbidden","This grant cannot receive notifications until a device approves it.",{reason:"grant_not_usable"});
        }
        return retained;
      };
      const grant = await authenticate();
      const application = await backgroundGrantNotificationDeclaration(connection,grant.grant_id,options.serverEnvironment);
      const declared = new Set(
        application?.notification_criteria.map(
          (criterion) => criterion.id
        ) ?? []
      );
      const undeclared = criteria.find(
        (criterion) => !declared.has(criterion)
      );
      if (undeclared) {
        await connection.query("ROLLBACK");
        return reply.code(400).send(apiError(
          "notification_reauthorization_required",
          `The current grant does not authorize notification criterion ${undeclared}. Reauthorize the application to accept its updated notification criteria.`
        ));
      }
      const kind = input.transport === "fcm" ? "fcm" : "web_push";
      const fcmToken = input.transport === "fcm" ? input.token : null;
      const webSubscription = input.transport === "fcm"
        ? null
        : input.subscription;
      const nativeDelivery =
        application?.notifications.native_delivery;
      if (kind === "fcm") {
        if (nativeDelivery?.mode !== "managed_fcm") {
          await connection.query("ROLLBACK");
          return reply.code(400).send(apiError(
            "managed_fcm_not_declared",
            "The application manifest does not declare Connect-managed FCM delivery."
          ));
        }
        if (!options.transports?.fcm) {
          await connection.query("ROLLBACK");
          return reply.code(503).send(apiError(
            "managed_fcm_unavailable",
            "Connect-managed FCM delivery is not configured."
          ));
        }
        // Native consent is exact-collection authority, not permission to
        // delete another grant/account's channel when it shares an FCM token.
        if (!installation) await connection.query(
          `DELETE FROM push_channels
           WHERE grant_id IN (
             SELECT id FROM grants WHERE application_id = $1
           )
             AND fcm_token_hash = $2
             AND NOT (grant_id = $3 AND installation_id = $4)`,
          [
            grant.application_id,
            tokenHash(fcmToken!),
            grant.grant_id,
            input.installation_id
          ]
        );
      } else if (!options.transports?.webPush) {
        await connection.query("ROLLBACK");
        return reply.code(503).send(apiError(
          "web_push_unavailable",
          "Web Push delivery is not configured."
        ));
      }
      // Sealed at rest when a push-target key is configured: the plaintext
      // target columns stay NULL and only the hashes remain queryable.
      const sealer = options.service.pushTargetSealer;
      if (installation && !sealer) throw new TimerError(503,"push_target_sealing_required","Native reminder channels require sealed push targets.");
      const target = {
        endpoint: webSubscription?.endpoint ?? null,
        p256dh: webSubscription?.keys.p256dh ?? null,
        auth: webSubscription?.keys.auth ?? null,
        fcm_token: fcmToken
      };
      const sealedTarget = sealer
        ? sealer.seal(grant.grant_id, input.installation_id, target)
        : null;
      const stored = sealer
        ? { endpoint: null, p256dh: null, auth: null, fcm_token: null }
        : target;
      const channel = await connection.query<{ id: string }>(
        `INSERT INTO push_channels
           (id, grant_id, installation_id, kind, endpoint, endpoint_hash,
            p256dh, auth, expires_at, fcm_project_id, fcm_token,
            fcm_token_hash, sealed_target, sealed_key_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT(grant_id, installation_id) DO UPDATE SET
           kind = excluded.kind,
           endpoint = excluded.endpoint,
           endpoint_hash = excluded.endpoint_hash,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           expires_at = excluded.expires_at,
           fcm_project_id = excluded.fcm_project_id,
           fcm_token = excluded.fcm_token,
           fcm_token_hash = excluded.fcm_token_hash,
           sealed_target = excluded.sealed_target,
           sealed_key_id = excluded.sealed_key_id,
           disabled_at = NULL,
           last_seen_at = now(),
           updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          grant.grant_id,
          input.installation_id,
          kind,
          stored.endpoint,
          webSubscription ? tokenHash(webSubscription.endpoint) : null,
          stored.p256dh,
          stored.auth,
          webSubscription?.expirationTime
            ? new Date(webSubscription.expirationTime).toISOString()
            : null,
          kind === "fcm" && nativeDelivery?.mode === "managed_fcm"
            ? nativeDelivery.firebase_project_id
            : null,
          stored.fcm_token,
          fcmToken ? tokenHash(fcmToken) : null,
          sealedTarget,
          sealer ? sealer.keyId : null
        ]
      );
      await connection.query(
        `DELETE FROM notification_subscriptions
         WHERE channel_id = $1
           AND NOT (criterion_id = ANY($2::text[]))`,
        [channel.rows[0].id, criteria]
      );
      for (const criterion of criteria) {
        await connection.query(
          `INSERT INTO notification_subscriptions
             (id, grant_id, channel_id, criterion_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(channel_id, criterion_id) DO NOTHING`,
          [
            randomUUID(),
            grant.grant_id,
            channel.rows[0].id,
            criterion
          ]
        );
      }
      await authenticate();
      await connection.query("COMMIT");
      return reply.code(201).send({
        channel_id: channel.rows[0].id,
        transport: kind,
        criteria
      });
    } catch (error) {
      await connection.query("ROLLBACK");
      if (error instanceof TimerError) return reply.code(error.statusCode).send(apiError(error.code,error.message,error.details));
      if (["55P03","57014"].includes(String((error as {code?:string})?.code))) return reply.code(503).send(apiError("busy","Reminder channels are temporarily unavailable."));
      throw error;
    } finally {
      connection.release();
    }
  };
  app.post("/v1/notifications/channels",registerChannel(false));
  app.post("/v1/next/collections/:collection/background-grants/:grant/notifications/channels",registerChannel(true));

  app.put(
    "/v1/notifications/subscriptions/:criterionId",
    async (request, reply) => {
      if (!options.service) {
        return notificationsUnavailable(reply);
      }
      const params = z.object({
        criterionId: z.string().min(1).max(100)
      }).parse(request.params);
      const input = z.object({
        channel_id: z.uuid()
      }).strict().parse(request.body);
      const bearer = bearerToken(request);
      if (!bearer) {
        return reply.code(401).send(apiError(
          "invalid_token",
          "Bearer token required."
        ));
      }
      const grant = await activeGrantForToken(
        options.db,
        tokenHash(bearer)
      );
      if (!grant) {
        return reply.code(401).send(apiError(
          "invalid_token",
          "Access token is invalid or expired."
        ));
      }
      if (!(await (options.grantResolver ?? legacyTimerGrantResolver).resolve(options.db, grant.grant_id))?.usable) {
        return reply.code(403).send(grantNotUsable());
      }
      const application = await options.db.query<{
        notification_criteria: NotificationCriterion[];
        channel_id: string | null;
      }>(
        `SELECT g.notification_criteria, pc.id AS channel_id
         FROM grants g
         LEFT JOIN push_channels pc
           ON pc.grant_id = g.id AND pc.id = $2
          AND pc.disabled_at IS NULL
         WHERE g.id = $1 AND g.revoked_at IS NULL
           AND g.activated_at IS NOT NULL`,
        [grant.grant_id, input.channel_id]
      );
      const row = application.rows[0];
      if (!row?.channel_id) {
        return reply.code(404).send(apiError(
          "channel_not_found",
          "The push channel is not active for this grant."
        ));
      }
      if (!row.notification_criteria.some(
        (criterion) => criterion.id === params.criterionId
      )) {
        return reply.code(400).send(apiError(
          "notification_reauthorization_required",
          "The current grant does not authorize this notification criterion."
        ));
      }
      const subscription = await options.db.query<{ id: string }>(
        `INSERT INTO notification_subscriptions
           (id, grant_id, channel_id, criterion_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(channel_id, criterion_id) DO UPDATE
           SET criterion_id = excluded.criterion_id
         RETURNING id`,
        [
          randomUUID(),
          grant.grant_id,
          input.channel_id,
          params.criterionId
        ]
      );
      return { subscription_id: subscription.rows[0].id };
    }
  );

  const removeChannel = (installation: boolean): RouteHandlerMethod => async (request, reply) => {
      const params = z.object({
        channelId: z.uuid()
      }).parse(request.params);
      const bearer = bearerToken(request);
      if (!bearer) {
        return reply.code(401).send(apiError(
          "invalid_token",
          "Bearer token required."
        ));
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("SET LOCAL lock_timeout = '5s'");
        await connection.query("SET LOCAL statement_timeout = '5s'");
        const authenticate = async () => {
          if (installation) {
            const scope = z.object({collection:z.uuid(),grant:z.uuid()}).parse(request.params);
            return (await currentInstallationTimerAuthority(connection,options.grantResolver ?? legacyTimerGrantResolver,
              scope.collection,scope.grant,tokenHash(bearer))).grant.grantId;
          }
          const retained = await activeGrantForToken(connection,tokenHash(bearer));
          if (!retained) throw new TimerError(401,"invalid_token","Access token is invalid or expired.");
          return retained.grant_id;
        };
        const grantId = await authenticate();
        const removed = await connection.query(
          `DELETE FROM push_channels WHERE id=$1 AND grant_id=$2 RETURNING id`, [params.channelId,grantId]);
        if (!removed.rows[0]) throw new TimerError(404,"channel_not_found","The push channel was not found.");
        await authenticate();
        await connection.query("COMMIT");
        return reply.code(204).send();
      } catch (error) {
        await connection.query("ROLLBACK");
        if (error instanceof TimerError) return reply.code(error.statusCode).send(apiError(error.code,error.message,error.details));
        if (["55P03","57014"].includes(String((error as {code?:string})?.code))) return reply.code(503).send(apiError("busy","Reminder channels are temporarily unavailable."));
        throw error;
      } finally { connection.release(); }
  };
  app.delete("/v1/notifications/channels/:channelId",removeChannel(false));
  app.delete("/v1/next/collections/:collection/background-grants/:grant/notifications/channels/:channelId",removeChannel(true));

  app.post(
    "/internal/v1/hosted/notification-signals",
    async (request, reply) => {
      if (!options.service) {
        return notificationsUnavailable(reply);
      }
      const bearer = bearerToken(request);
      if (!options.hostedProvider?.authorizesInternalToken(bearer)) {
        return reply.code(401).send(apiError(
          "invalid_internal_token",
          "Hosted provider credential is invalid."
        ));
      }
      const input = signalSchema.parse(request.body);
      const authorization = await options.db.query<{
        notification_criteria: NotificationCriterion[];
      }>(
        `SELECT g.notification_criteria
         FROM grants g
         WHERE g.id = $1 AND g.hosted_collection_id IS NOT NULL
           AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL`,
        [input.grant_id]
      );
      const authorized = authorization.rows[0]?.notification_criteria.some(
        (criterion) => criterion.id === input.criterion_id
      );
      if (!authorized) {
        return reply.code(403).send(apiError(
          "notification_signal_denied",
          "The hosted grant does not authorize this notification criterion."
        ));
      }
      return enqueueSignal(options.service, reply, input);
    }
  );

  app.post(
    "/v1/connectors/notification-signals",
    async (request, reply) => {
      if (!options.service) {
        return notificationsUnavailable(reply);
      }
      const connector = await requireConnector(
        request,
        reply,
        options.db
      );
      if (!connector) return;
      const input = signalSchema.parse(request.body);
      const authorization = await options.db.query<{
        notification_criteria: NotificationCriterion[];
      }>(
        `SELECT g.notification_criteria
         FROM grants g
         JOIN collections c ON c.id = g.collection_id
         WHERE g.id = $1 AND c.connector_id = $2
           AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
           AND c.enabled = true AND c.present = true
           AND c.authority_state = 'active'`,
        [input.grant_id, connector.id]
      );
      const authorized = authorization.rows[0]?.notification_criteria.some(
        (criterion) => criterion.id === input.criterion_id
      );
      if (!authorized) {
        return reply.code(403).send(apiError(
          "notification_signal_denied",
          "The local grant does not authorize this notification criterion."
        ));
      }
      return enqueueSignal(options.service, reply, input);
    }
  );
}

async function enqueueSignal(
  service: NotificationService,
  reply: {
    code(statusCode: number): {
      send(payload: unknown): unknown;
    };
  },
  input: z.infer<typeof signalSchema>
): Promise<unknown> {
  const outcome = await service.enqueue({
    signalId: input.signal_id,
    grantId: input.grant_id,
    criterionId: input.criterion_id,
    cursor: input.cursor
  });
  return reply.code(outcome.duplicate ? 200 : 202).send({
    accepted: true,
    duplicate: outcome.duplicate,
    deliveries: outcome.deliveries
  });
}

function notificationsUnavailable(reply: {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
}): unknown {
  return reply.code(503).send(apiError(
    "notifications_unavailable",
    "Push notifications are not configured."
  ));
}

/** End-to-end grants without device approval (and unusable grants) get no channels. */
function grantNotUsable() {
  return apiError(
    "forbidden",
    "This grant cannot receive notifications until a device approves it.",
    { reason: "grant_not_usable" }
  );
}
