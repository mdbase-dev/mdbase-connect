import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import {
  apiError,
  RequestValidationError
} from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";

interface AuthorityConflictRoutesOptions {
  db: DatabasePool;
  relay: RelayHub;
}

export function registerAuthorityConflictRoutes(
  app: FastifyInstance,
  options: AuthorityConflictRoutesOptions
): void {
  app.post(
    "/v1/connectors/authority-conflicts/:collectionId/move",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      const connection = await options.db.connect();
      const affectedConnectors = new Set<string>([connector.id]);
      try {
        await connection.query("BEGIN");
        await connection.query(
          "SELECT id FROM users WHERE id = $1 FOR UPDATE",
          [connector.user_id]
        );
        const candidate = await connection.query<{
          id: string;
          reported_enabled: boolean;
          authority_epoch: string | number;
        }>(
          `SELECT id, reported_enabled, authority_epoch FROM collections
           WHERE connector_id = $1 AND user_id = $2 AND local_id = $3
             AND present = true AND authority_state = 'candidate'
           FOR UPDATE`,
          [connector.id, connector.user_id, collectionId]
        );
        if (!candidate.rows[0]) {
          await connection.query("ROLLBACK");
          return reply.code(404).send(apiError(
            "authority_conflict_not_found",
            "This folder no longer has an authority conflict."
          ));
        }
        const hosted = await connection.query<{
          authority_state: string;
        }>(
          `SELECT authority_state FROM hosted_collections
           WHERE id = $1 AND user_id = $2
             AND authority_state <> 'transferred'`,
          [collectionId, connector.user_id]
        );
        if (hosted.rows[0]) {
          throw new RequestValidationError(
            "Use the hosted collection transfer flow before moving this authority."
          );
        }
        const current = await connection.query<{
          id: string;
          connector_id: string;
          authority_epoch: string | number;
        }>(
          `SELECT id, connector_id, authority_epoch FROM collections
           WHERE user_id = $1 AND local_id = $2
             AND authority_state = 'active'
           FOR UPDATE`,
          [connector.user_id, collectionId]
        );
        const nextEpoch = Math.max(
          Number(candidate.rows[0].authority_epoch),
          ...current.rows.map(
            (authority) => Number(authority.authority_epoch)
          )
        ) + 1;
        for (const authority of current.rows) {
          affectedConnectors.add(authority.connector_id);
          await connection.query(
            `UPDATE collections
             SET authority_state = 'retired', enabled = false,
                 authority_epoch = $2
             WHERE id = $1`,
            [authority.id, nextEpoch]
          );
          const revoked = await connection.query<{ id: string }>(
            `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
             WHERE collection_id = $1 AND revoked_at IS NULL
             RETURNING id`,
            [authority.id]
          );
          for (const grant of revoked.rows) {
            await connection.query(
              `UPDATE access_tokens
               SET revoked_at = COALESCE(revoked_at, now())
               WHERE grant_id = $1`,
              [grant.id]
            );
            await connection.query(
              `UPDATE refresh_tokens
               SET revoked_at = COALESCE(revoked_at, now())
               WHERE grant_id = $1`,
              [grant.id]
            );
          }
        }
        await connection.query(
          `UPDATE collections
           SET authority_state = 'active', authority_epoch = $2,
               enabled = reported_enabled
           WHERE id = $1`,
          [candidate.rows[0].id, nextEpoch]
        );
        await connection.query(
          `DELETE FROM authorization_collection_offers
           WHERE collection_id = $1 OR collection_id IN (
             SELECT id FROM collections
             WHERE user_id = $2 AND local_id = $3
           )`,
          [candidate.rows[0].id, connector.user_id, collectionId]
        );
        await audit(
          connection,
          connector.user_id,
          "collection.authority_moved",
          collectionId,
          {
            connector_id: connector.id,
            authority_epoch: nextEpoch
          }
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
      for (const connectorId of affectedConnectors) {
        await options.relay.pushPolicy(connectorId);
      }
      return { ok: true };
    }
  );
}
