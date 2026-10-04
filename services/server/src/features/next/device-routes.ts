// Device registration for daemons (interface note
// 2026-10-04-control-daemon-grant-feed-and-relay.md §1). Mounted only when the
// mdbase-next control plane is enabled.
import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";
import { DeviceRegistrationError, issueDeviceChallenge, registerDevice } from "./devices.js";

export function registerNextDeviceRoutes(app: FastifyInstance, options: { db: DatabasePool }): void {
  const rateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  app.post("/v1/next/devices/challenge", rateLimit, async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    return issueDeviceChallenge(options.db, connector.id);
  });
  app.post("/v1/next/devices", rateLimit, async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    try {
      return await registerDevice(options.db, connector, (request.body ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (!(error instanceof DeviceRegistrationError)) throw error;
      const status = error.code === "device_keys_changed" || error.code === "device_already_bound" ? 409 : 400;
      return reply.code(status).send(apiError(error.code, error.message));
    }
  });
}
