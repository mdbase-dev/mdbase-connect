// Device registration for daemons (interface note
// 2026-10-04-control-daemon-grant-feed-and-relay.md §1). Mounted only when the
// mdbase-next control plane is enabled.
import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken, requireConnector, requireInstallationDeviceConnector } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { isLockTimeout } from "./bootstrap-common.js";
import { DeviceRegistrationError, issueDeviceChallenge, registerDevice } from "./devices.js";
import { GrantApprovalReportError, reportGrantApproval } from "./grant-approval.js";
import type { LogServiceClient } from "./log-service-client.js";
import { registerApprovalPeerRoutes } from "./approval-peer-routes.js";

export function registerNextDeviceRoutes(app: FastifyInstance, options: { db: DatabasePool; log: Pick<LogServiceClient, "controlItemAt"> }): void {
  registerApprovalPeerRoutes(app, options.db);
  const rateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  app.post("/v1/next/devices/challenge", rateLimit, async (request, reply) => {
    const connector = await requireInstallationDeviceConnector(request, reply, options.db);
    if (!connector) return reply;
    return issueDeviceChallenge(options.db, connector.id);
  });
  app.post("/v1/next/devices", rateLimit, async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    try {
      return await registerDevice(options.db, connector, (request.body ?? {}) as Record<string, unknown>, tokenHash(bearerToken(request)!));
    } catch (error) {
      if (isLockTimeout(error)) return reply.code(503).send(apiError("busy", "Device registration was not confirmed."));
      if (!(error instanceof DeviceRegistrationError)) throw error;
      const status = error.code === "identity_not_current" ? 403 : error.code === "device_keys_changed" || error.code === "device_already_bound" ? 409 : 400;
      return reply.code(status).send(apiError(error.code, error.message));
    }
  });
  app.post("/v1/next/grants/:grantId/approval", rateLimit, async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const { grantId } = request.params as { grantId: string };
    if (!/^[0-9a-f-]{36}$/.test(grantId)) return reply.code(400).send(apiError("invalid_report", "The grant ID is invalid."));
    try {
      return await reportGrantApproval(options.db, options.log, connector, grantId, (request.body ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof GrantApprovalReportError)) throw error;
      return reply.code(error.status).send(apiError(error.code, error.message));
    }
  });
}
