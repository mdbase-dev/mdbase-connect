import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveHostedCollectionAccess } from "../../collection-access.js";
import type { DatabasePool } from "../../database-types.js";
import { collectionContractDescriptorSchema } from "../../protocol-schemas.js";
import { isP256PublicKey } from "../../security.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { requireConnector } from "../../platform/request-authentication.js";

interface ConnectorInventoryRoutesOptions {
  db: DatabasePool;
}

const inventorySchema = z.object({
  relay_public_key: z.string()
    .min(80)
    .max(200)
    .refine(isP256PublicKey)
    .optional(),
  inventory_revision: z.number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  collections: z.array(z.object({
    id: z.uuid(),
    display_name: z.string().min(1).max(200),
    spec_version: z.string().min(1).max(30),
    enabled: z.boolean(),
    contracts: z.array(collectionContractDescriptorSchema).max(100).default([])
  })).max(1_000)
});

export function registerConnectorInventoryRoutes(
  app: FastifyInstance,
  options: ConnectorInventoryRoutesOptions
): void {
  app.post("/v1/connectors/sync", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = inventorySchema.parse(request.body);
    if (
      new Set(input.collections.map((collection) => collection.id)).size
      !== input.collections.length
    ) {
      throw new RequestValidationError(
        "A collection may appear only once in an inventory."
      );
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
        connector.user_id
      ]);
      const accepted = await connection.query(
        `UPDATE connectors SET
           inventory_revision = $2,
           relay_public_key = COALESCE($3, relay_public_key),
           last_seen_at = now()
         WHERE id = $1 AND inventory_revision < $2
         RETURNING id`,
        [connector.id, input.inventory_revision, input.relay_public_key ?? null]
      );
      if (!accepted.rows[0]) {
        const current = await connection.query<{
          inventory_revision: string | number;
        }>(
          "SELECT inventory_revision FROM connectors WHERE id = $1",
          [connector.id]
        );
        await connection.query("COMMIT");
        return {
          accepted: false,
          inventory_revision: Number(
            current.rows[0]?.inventory_revision ?? 0
          ),
          collections: []
        };
      }

      const synchronized = [];
      for (const collection of input.collections) {
        const existing = await connection.query<{
          id: string;
          authority_state: "active" | "candidate" | "retired";
          authority_epoch: string | number;
        }>(
          `SELECT id, authority_state, authority_epoch
           FROM collections WHERE connector_id = $1 AND local_id = $2`,
          [connector.id, collection.id]
        );
        const activeAuthority = await connection.query<{
          id: string;
          authority_epoch: string | number;
        }>(
          `SELECT id, authority_epoch FROM collections
           WHERE user_id = $1 AND local_id = $2
             AND authority_state = 'active'`,
          [connector.user_id, collection.id]
        );
        const hosted = await connection.query<{
          authority_state: "active" | "transferring" | "transferred";
          authority_epoch: string | number;
          transferred_collection_id: string | null;
        }>(
          `SELECT authority_state, authority_epoch,
                  transferred_collection_id
           FROM hosted_collections WHERE id = $1`,
          [collection.id]
        );
        const hostedAccess = await resolveHostedCollectionAccess(
          connection,
          connector.user_id,
          collection.id
        );
        const existingCollection = existing.rows[0];
        const currentAuthority = activeAuthority.rows[0];
        const hostedCollection = hostedAccess ? hosted.rows[0] : undefined;
        const isActivatedTransfer = Boolean(
          hostedCollection?.authority_state === "transferred"
          && hostedCollection.transferred_collection_id
          && hostedCollection.transferred_collection_id
            === existingCollection?.id
        );
        const authorityState: "active" | "candidate" = hostedCollection
          ? (isActivatedTransfer ? "active" : "candidate")
          : (
              currentAuthority
              && currentAuthority.id !== existingCollection?.id
                ? "candidate"
                : "active"
            );
        const authorityEpoch = Number(
          hostedCollection?.authority_epoch
          ?? currentAuthority?.authority_epoch
          ?? existingCollection?.authority_epoch
          ?? 1
        );
        const enabled = authorityState === "active" && collection.enabled;
        const row = await connection.query<{
          id: string;
          local_id: string;
          authority_state: "active" | "candidate" | "retired";
          authority_epoch: string | number;
        }>(
          `INSERT INTO collections
             (id, user_id, connector_id, local_id, display_name, spec_version,
              enabled, reported_enabled, present, authority_state,
              authority_epoch, contracts, last_inventory_revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10,
                   $11::jsonb, $12)
           ON CONFLICT(connector_id, local_id) DO UPDATE SET
             user_id = excluded.user_id,
             display_name = excluded.display_name,
             spec_version = excluded.spec_version,
             enabled = excluded.enabled,
             reported_enabled = excluded.reported_enabled,
             present = true,
             authority_state = excluded.authority_state,
             authority_epoch = excluded.authority_epoch,
             contracts = excluded.contracts,
             last_inventory_revision = excluded.last_inventory_revision,
             last_seen_at = now(),
             removed_at = NULL
           RETURNING id, local_id, authority_state, authority_epoch`,
          [
            randomUUID(),
            connector.user_id,
            connector.id,
            collection.id,
            collection.display_name,
            collection.spec_version,
            enabled,
            collection.enabled,
            authorityState,
            authorityEpoch,
            JSON.stringify(collection.contracts),
            input.inventory_revision
          ]
        );
        synchronized.push({
          id: row.rows[0].local_id,
          authority_state: row.rows[0].authority_state,
          authority_epoch: Number(row.rows[0].authority_epoch)
        });
      }

      const removed = await connection.query<{ id: string }>(
        `UPDATE collections SET
           present = false,
           enabled = false,
           authority_state = 'retired',
           removed_at = now()
         WHERE connector_id = $1 AND present = true
           AND last_inventory_revision < $2
         RETURNING id`,
        [connector.id, input.inventory_revision]
      );
      for (const collection of removed.rows) {
        const revoked = await connection.query<{ id: string }>(
          `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
           WHERE collection_id = $1 AND revoked_at IS NULL
           RETURNING id`,
          [collection.id]
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
      await connection.query("COMMIT");
      return {
        accepted: true,
        inventory_revision: input.inventory_revision,
        collections: synchronized
      };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });
}
