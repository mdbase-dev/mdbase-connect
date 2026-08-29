import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { RelayHub } from "../../relay.js";
import { randomToken, tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import {
  requireConnector,
  requireUser
} from "../../platform/request-authentication.js";

interface ConnectorManagementRoutesOptions {
  db: DatabasePool;
  tailscaleAuth?: boolean;
  relay: RelayHub;
}

const connectorNameSchema = z.object({
  name: z.string().trim().min(1).max(100)
}).strict();

export function registerConnectorManagementRoutes(
  app: FastifyInstance,
  options: ConnectorManagementRoutesOptions
): void {
  app.post("/v1/connectors", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const input = connectorNameSchema.parse(request.body);
    const token = randomToken("con");
    const connector = await options.db.query<{ id: string; name: string }>(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [randomUUID(), user.id, input.name, tokenHash(token)]
    );
    await audit(
      options.db,
      user.id,
      "connector.created",
      connector.rows[0].id,
      { name: input.name }
    );
    return reply.code(201).send({ connector: connector.rows[0], token });
  });

  app.patch("/v1/connectors/self", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = connectorNameSchema.parse(request.body);
    const renamed = await options.db.query<{ id: string; name: string }>(
      "UPDATE connectors SET name = $2 WHERE id = $1 RETURNING id, name",
      [connector.id, input.name]
    );
    await audit(
      options.db,
      connector.user_id,
      "connector.renamed",
      connector.id,
      {
        name: input.name,
        source: "local_controller"
      }
    );
    return { connector: renamed.rows[0] };
  });

  app.patch("/v1/connectors/:connectorId", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const { connectorId } = z.object({
      connectorId: z.uuid()
    }).parse(request.params);
    const input = connectorNameSchema.parse(request.body);
    const renamed = await options.db.query<{ id: string; name: string }>(
      `UPDATE connectors SET name = $3
       WHERE id = $1 AND user_id = $2
       RETURNING id, name`,
      [connectorId, user.id, input.name]
    );
    if (!renamed.rows[0]) {
      return reply.code(404).send(apiError(
        "connector_not_found",
        "Computer not found."
      ));
    }
    await audit(
      options.db,
      user.id,
      "connector.renamed",
      connectorId,
      { name: input.name }
    );
    return { connector: renamed.rows[0] };
  });

  app.delete("/v1/connectors/:connectorId", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const { connectorId } = z.object({
      connectorId: z.uuid()
    }).parse(request.params);
    const connection = await options.db.connect();
    let fenceGeneration: string;
    try {
      await connection.query("BEGIN");
      const removed = await connection.query<{ fence_generation: string | number }>(
        `UPDATE connectors
         SET revoked_at = now(), relay_generation = relay_generation + 1
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING relay_generation AS fence_generation`,
        [connectorId, user.id]
      );
      if (!removed.rows[0]) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "connector_not_found",
          "Computer not found."
        ));
      }
      fenceGeneration = String(removed.rows[0].fence_generation);
      await audit(connection, user.id, "connector.revoked", connectorId, {
        fence_generation: fenceGeneration,
        result: "committed"
      });
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
    try {
      const fence = await options.relay.fenceConnector(connectorId, fenceGeneration);
      return {
        ok: true,
        committed: true,
        fence: fence === "closed" ? "closed" : "committed_with_degraded_fence"
      };
    } catch {
      // Deletion, the generation fence, and its audit are already committed.
      return { ok: true, committed: true, fence: "committed_with_degraded_fence" };
    }
  });
}
