// Shared cloud-copy catalog labels. Names confer no content or grant authority.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken, requireInstallationDeviceConnector } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { CreateError, currentIdentity, currentMember, exactEnrolment, inTransaction, lock, refuse, refuseRevoked, type Device } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { collectionDisplayName } from "./collection-display-name.js";
import { requireInstallationScope } from "./installation-scope.js";
import { requireAccountNotMigrationFrozen } from "./migration-topology.js";

const id = z.uuid().transform(value => value.toLowerCase()).refine(value => value !== "00000000-0000-0000-0000-000000000000");
const notFound = () => new CreateError(404, "not_found");

export function registerCloudCopyNameRoutes(app: FastifyInstance, db: DatabasePool): void {
  app.patch<{ Body: { display_name: string } }>("/v1/next/collections/:id/name", {
    bodyLimit: 4096,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id }).safeParse(request.params);
    const body = z.object({ display_name: z.string() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(apiError("invalid_request", "A collection identifier and name are required."));
    // Snapshot the user's metadata intent and ORIGINAL bearer before any await.
    let displayName: string;
    try { displayName = collectionDisplayName(body.data.display_name); }
    catch (error) { return refuse(reply, error, "Use a single-line name of 1–200 UTF-16 units."); }
    const credential = bearerToken(request);
    const hash = credential === null ? null : tokenHash(credential);
    const connector = await requireInstallationDeviceConnector(request, reply, db);
    if (!connector) return reply;
    const collection = params.data.id;
    try {
      return await inTransaction(db, async client => {
        const discovered = (await client.query<{ owner_user_id: string }>(
          "SELECT owner_user_id FROM next_collections WHERE collection_id=$1", [collection]
        )).rows[0];
        if (discovered?.owner_user_id !== connector.user_id) throw notFound();
        // Account first; freeze/owner discovery is revalidated before mutation.
        await requireAccountNotMigrationFrozen(client, connector.user_id);
        if (!(await client.query(
          "SELECT 1 FROM users WHERE id=$1 AND account_backend='next' AND suspended_at IS NULL FOR SHARE", [connector.user_id]
        )).rows.length) throw notFound();
        const original = connector.installation_device_id
          ? await client.query("SELECT 1 FROM installation_device_credentials WHERE connector_id=$1 AND device_id=$2 AND token_hash=$3 FOR SHARE", [connector.id, connector.installation_device_id, hash])
          : await client.query("SELECT 1 FROM connectors WHERE id=$1 AND user_id=$2 AND token_hash=$3 AND revoked_at IS NULL FOR SHARE", [connector.id, connector.user_id, hash]);
        if (!original.rows.length) throw notFound();
        await lock(client, collection);
        const held = (await client.query<{ owner_user_id: string; runtime: string; sync: string; left: boolean }>(
          "SELECT owner_user_id,runtime,sync,left_sync_at IS NOT NULL AS left FROM next_collections WHERE collection_id=$1 FOR UPDATE", [collection]
        )).rows[0];
        if (held?.owner_user_id !== discovered.owner_user_id || held.runtime !== "next" || held.sync !== "cloud_copy" || held.left) throw notFound();
        await requireInstallationScope(client, connector, collection);
        const device = (await client.query<Device & { id: string }>(
          "SELECT id,sign_pk,kem_pk,noise_pk,kind FROM next_devices WHERE connector_id=$1 AND user_id=$2", [connector.id, connector.user_id]
        )).rows[0];
        if (!device || (connector.installation_device_id ? device.id !== connector.installation_device_id : !["desktop", "cli"].includes(device.kind))) throw notFound();
        await currentIdentity(client, connector, device.id, device);
        await currentMember(client, collection, connector.user_id, "owner");
        await refuseRevoked(client, collection, device.id);
        if (!(await client.query(
          `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
           WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL
             AND o.ops->'ops' @> $2::jsonb LIMIT 1`, [collection, exactEnrolment(device.id, connector.user_id, device)]
        )).rows.length) throw notFound();
        await requireCollectionNotDeleted(client, collection);
        return (await client.query<{ collection_id: string; display_name: string }>(
          "UPDATE next_collections SET display_name=$2 WHERE collection_id=$1 RETURNING collection_id,display_name", [collection, displayName]
        )).rows[0]!;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "collection_deleted") return reply.code(404).send(apiError("not_found", "Collection not found."));
      return refuse(reply, error, "The collection name could not be changed.");
    }
  });
}
