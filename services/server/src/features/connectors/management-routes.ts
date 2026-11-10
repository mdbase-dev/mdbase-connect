import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { RelayHub } from "../relay/relay.js";
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

interface AccountApplicationRow {
  id: string;
  name: string;
  distribution: "web" | "portable";
  homepage: string | null;
  icon: string | null;
  collection_id: string | null;
  collection_name: string | null;
}

/** One entry per app (its family when it has one), each collection once, by name. */
function accountApplications(rows: AccountApplicationRow[]) {
  const apps = new Map<string, {
    id: string;
    name: string;
    distribution: "web" | "portable";
    homepage: string | null;
    icon: string | null;
    collections: Map<string, { id: string; name: string }>;
  }>();
  for (const row of rows) {
    const app = apps.get(row.id) ?? {
      id: row.id, name: row.name, distribution: row.distribution,
      homepage: row.homepage || null, icon: row.icon || null, collections: new Map()
    };
    apps.set(row.id, app);
    if (row.collection_id && row.collection_name) {
      app.collections.set(row.collection_id, { id: row.collection_id, name: row.collection_name });
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return [...apps.values()]
    .map(app => ({ ...app, collections: [...app.collections.values()].sort(byName) }))
    .sort(byName);
}

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

  // The desktop's Home lists the apps approved anywhere in the account. Only a
  // computer's own connector may ask; an app installation must not see other apps.
  // Launch metadata only: no operations, origins of individual grants or paths.
  app.get("/v1/connectors/self/applications", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return reply;
    const installation = await options.db.query(
      "SELECT 1 FROM installation_device_credentials WHERE connector_id = $1 LIMIT 1",
      [connector.id]
    );
    if (installation.rows[0]) {
      return reply.code(403).send(apiError("computer_credential_required", "Use a computer's credential."));
    }
    const rows = await options.db.query<AccountApplicationRow>(
      `SELECT CASE WHEN a.family_identity = '' THEN a.id::text ELSE a.family_identity END AS id, a.name, a.distribution, a.homepage, a.icon,
              COALESCE(col.local_id, g.hosted_collection_id, g.next_collection_id) AS collection_id,
              COALESCE(col.display_name, hosted.display_name, native.display_name) AS collection_name
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hosted ON hosted.id = g.hosted_collection_id
       LEFT JOIN next_collections native ON native.collection_id = g.next_collection_id
       WHERE g.user_id = $1 AND g.activated_at IS NOT NULL AND g.revoked_at IS NULL
       UNION ALL
       SELECT a.family_identity, a.name, a.distribution, a.homepage, a.icon,
              scope.collection_id, native.display_name
       FROM installation_device_credentials k
       JOIN connectors c ON c.id = k.connector_id
       JOIN applications a ON a.id::text = k.app_id
       JOIN installation_collection_scopes scope ON scope.connector_id = k.connector_id
       LEFT JOIN next_collections native ON native.collection_id = scope.collection_id
       WHERE c.user_id = $1 AND c.revoked_at IS NULL AND a.family_identity <> ''`,
      [connector.user_id]
    );
    return { applications: accountApplications(rows.rows) };
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
