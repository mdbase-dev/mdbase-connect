import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import type { RelayHub } from "../../relay.js";
import { connectorFromRequest } from "../../platform/request-authentication.js";

interface ConnectorRelayRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
}

export function registerConnectorRelayRoute(
  app: FastifyInstance,
  options: ConnectorRelayRouteOptions
): void {
  app.get("/v1/relay", { websocket: true }, async (socket, request) => {
    const handshake = options.relay.beginHandshake(socket);
    const connector = await connectorFromRequest(request, options.db);
    if (!connector) {
      socket.close(4003, "Invalid connector credential");
      return;
    }
    await options.relay.attach(connector.id, socket, handshake);
  });
}
