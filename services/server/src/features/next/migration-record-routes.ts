// Read-only native cutover metadata. This is not a policy, installation, key or
// admission proof; ordinary connector credentials never acquire new authority.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken, requireConnector } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { CreateError, currentIdentity, currentMember, exactEnrolment, inTransaction, isLockTimeout, lock, refuseRevoked, type Device } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { collectionMigrationRecord } from "./migration-rollout.js";

const id = z.string().length(36).regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u)
  .refine(value => value !== "00000000-0000-0000-0000-000000000000");
const notFound = () => new CreateError(404, "not_found");

export function registerCollectionMigrationRecordRoute(app: FastifyInstance, db: DatabasePool): void {
  app.get("/v1/next/collections/:id/migration-record", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireConnector(request, reply, db);
    if (!connector) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(apiError("invalid_request", "A canonical collection identifier is required."));
    const collection = params.data.id;
    const credential = tokenHash(bearerToken(request)!);
    try {
      const record = await inTransaction(db, async client => {
        const discovered = (await client.query<{ owner_user_id: string }>(
          "SELECT owner_user_id FROM next_collections WHERE collection_id=$1", [collection]
        )).rows[0];
        if (!discovered) throw notFound();
        // Account-first, stable ordering for a cross-account member. Owner
        // discovery grants nothing; revalidate it after the collection lock.
        const accounts = (await client.query<{ id: string; account_backend: string; suspended_at: Date | null }>(
          "SELECT id,account_backend,suspended_at FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE", [[...new Set([connector.user_id, discovered.owner_user_id])]]
        )).rows;
        if (accounts.length !== new Set([connector.user_id, discovered.owner_user_id]).size
          || accounts.some(account => account.suspended_at !== null)
          || accounts.find(account => account.id === connector.user_id)?.account_backend !== "next") throw notFound();
        const device = (await client.query<Device & { id: string }>(
          "SELECT id,sign_pk,kem_pk,noise_pk,kind FROM next_devices WHERE connector_id=$1 AND user_id=$2", [connector.id, connector.user_id]
        )).rows[0];
        if (!device || !["desktop", "cli"].includes(device.kind)) throw notFound();
        await currentIdentity(client, connector, device.id, device);
        // Recheck the ORIGINAL ordinary bearer after all preflight awaits;
        // connector ID alone would admit an in-flight rotated credential.
        if (!(await client.query(
          "SELECT 1 FROM connectors WHERE id=$1 AND token_hash=$2 AND revoked_at IS NULL FOR SHARE", [connector.id, credential]
        )).rows.length) throw notFound();
        await lock(client, collection);
        const current = (await client.query<{ owner_user_id: string }>(
          "SELECT owner_user_id FROM next_collections WHERE collection_id=$1 AND runtime='next' AND sync='cloud_copy' AND left_sync_at IS NULL FOR SHARE", [collection]
        )).rows[0];
        if (current?.owner_user_id !== discovered.owner_user_id) throw notFound();
        await currentMember(client, collection, connector.user_id);
        await refuseRevoked(client, collection, device.id);
        if (!(await client.query(
          `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
           WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL
             AND o.ops->'ops' @> $2::jsonb LIMIT 1`, [collection, exactEnrolment(device.id, connector.user_id, device)]
        )).rows.length) throw notFound();
        await requireCollectionNotDeleted(client, collection);
        const hosted = (await client.query<{ user_id: string; authority_state: string }>(
          "SELECT user_id,authority_state FROM hosted_collections WHERE id=$1 FOR SHARE", [collection]
        )).rows[0];
        if (hosted && (hosted.user_id !== current.owner_user_id || hosted.authority_state === "transferred")) throw notFound();
        // A native-born cloud copy may have no legacy hosted row/ledger at all.
        // Membership may be cross-account: never substitute the requesting
        // account for the current collection owner in the migration ledger.
        return collectionMigrationRecord(client, collection, current.owner_user_id);
      });
      if (!record) return reply.code(409).send(apiError("not_cut_over", "No migration cutover record is available."));
      return record;
    } catch (error) {
      if (error instanceof CreateError || (error instanceof Error && error.message === "collection_deleted")) {
        return reply.code(404).send(apiError("not_found", "Collection not found."));
      }
      if (isLockTimeout(error) || ["40P01", "40001"].includes(String((error as { code?: string })?.code))) {
        return reply.code(503).send(apiError("busy", "Retry the metadata read."));
      }
      throw error;
    }
  });
}
