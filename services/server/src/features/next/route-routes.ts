// Where an app connects for a collection (mdbase-next replica-client-api §12.3;
// sdk interface note 2026-10-04-sdk-relay-pipe-and-local-only.md §1).
//
// `GET /v1/next/collections/:id/route` with the app's access token returns the targets
// the app may open a Noise session to. Today: the daemon serving a local collection,
// through the relay. The hosted replica of a standard collection is added with key
// custody. Only grants with a registered client key are routed: without one, the
// daemon has nothing to authenticate the app against.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";

export interface RouteTarget {
  kind: "desktop" | "cli" | "hosted";
  device: string;
  noise_pk: string;
  url: string;
  /** For relay targets: the collection ID `pipe_auth` names. Absent for direct targets. */
  relay_collection?: string;
}

export function registerNextRouteRoutes(app: FastifyInstance, options: { db: DatabaseQueryable; publicUrl: string }): void {
  const relayUrl = new URL("/v1/next/relay/client", options.publicUrl);
  relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
  app.get("/v1/next/collections/:id/route", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const token = bearerToken(request);
    if (!token) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const grant = await options.db.query<{ grant_id: string; has_client_key: boolean; device_id: string | null; kind: "desktop" | "cli" | null; noise_pk: Buffer | null; local_id: string }>(
      `SELECT g.id AS grant_id, (k.grant_id IS NOT NULL) AS has_client_key,
              d.id AS device_id, d.kind, d.noise_pk, col.local_id
       FROM access_tokens tok
       JOIN grants g ON g.id = tok.grant_id
       JOIN users u ON u.id = g.user_id
       JOIN collections col ON col.id = g.collection_id
       JOIN connectors c ON c.id = col.connector_id AND c.revoked_at IS NULL
       LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
       LEFT JOIN next_devices d ON d.connector_id = c.id
       WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND u.suspended_at IS NULL
         AND col.local_id = $2 AND col.enabled = true
         AND col.present = true AND col.authority_state = 'active'`,
      [tokenHash(token), id]
    );
    const row = grant.rows[0];
    if (!row) return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired for this collection."));
    if (!row.has_client_key) {
      return reply.code(409).send(apiError("client_key_required", "This grant has no registered Noise key; authorize the app again to register one."));
    }
    const targets: RouteTarget[] = row.device_id && row.noise_pk && row.kind
      ? [{ kind: row.kind, device: row.device_id, noise_pk: row.noise_pk.toString("hex"), url: relayUrl.toString(), relay_collection: row.local_id }]
      : [];
    return { collection: id, grant: row.grant_id, targets, ...(targets.length === 0 ? { reason: "no_device_registered" } : {}) };
  });

  // C2: the collections this app installation may switch between, one entry per active
  // grant of the same user and installation. A grant is `routable` when it has a
  // registered Noise key (otherwise it works only through the old envelope).
  app.get("/v1/next/apps/collections", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const token = bearerToken(request);
    if (!token) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const caller = await options.db.query<{ user_id: string; application_id: string; installation: string }>(
      `SELECT g.user_id, g.application_id, g.application_installation_id AS installation
       FROM access_tokens tok JOIN grants g ON g.id = tok.grant_id JOIN users u ON u.id = g.user_id
       WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL AND u.suspended_at IS NULL`,
      [tokenHash(token)]
    );
    const self = caller.rows[0];
    if (!self) return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
    const grants = await options.db.query<{
      grant_id: string; collection: string; display_name: string; operations: string[];
      sync: "private" | "cloud_copy" | null; routable: boolean;
    }>(
      `SELECT g.id AS grant_id, COALESCE(col.local_id::text, hc.id::text) AS collection,
              COALESCE(col.display_name, hc.display_name) AS display_name, g.operations,
              nc.sync, (k.grant_id IS NOT NULL) AS routable
       FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       LEFT JOIN hosted_collections hc ON hc.id = g.hosted_collection_id
       LEFT JOIN next_collections nc ON nc.collection_id::text = COALESCE(col.local_id::text, hc.id::text)
       LEFT JOIN next_grant_client_keys k ON k.grant_id = g.id
       WHERE g.user_id = $1 AND g.application_id = $2 AND g.application_installation_id = $3
         AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
         AND (g.collection_id IS NULL OR (col.enabled = true AND col.present = true AND col.authority_state = 'active'))
       ORDER BY display_name, g.id`,
      [self.user_id, self.application_id, self.installation]
    );
    return {
      collections: grants.rows.map((row) => ({
        collection: row.collection,
        name: row.display_name,
        grant: row.grant_id,
        state: row.sync === "cloud_copy" ? "synced" : row.sync === "private" ? "synced_e2e" : "local",
        operations: row.operations,
        routable: row.routable
      }))
    };
  });
}
