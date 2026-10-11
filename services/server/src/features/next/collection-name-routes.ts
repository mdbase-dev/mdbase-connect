// Shared synced-collection catalog labels and owner deletion. Names confer no
// content or grant authority.
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { apiError, RequestValidationError } from "../../platform/http-errors.js";
import { bearerToken, requireInstallationDeviceConnector, type ConnectorIdentity } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { CreateError, currentIdentity, currentMember, exactEnrolment, inTransaction, lock, refuse, refuseRevoked, type Device } from "./bootstrap-common.js";
import { recordCollectionDeletionIntent, requireCollectionNotDeleted, type CollectionDeletionFact } from "./collection-deletion.js";
import { collectionDisplayName } from "./collection-display-name.js";
import { requireInstallationScope } from "./installation-scope.js";
import { requireAccountNotMigrationFrozen } from "./migration-topology.js";

const id = z.uuid().transform(value => value.toLowerCase()).refine(value => value !== "00000000-0000-0000-0000-000000000000");
const notFound = () => new CreateError(404, "not_found");

/** The native registry floor, recorded after the CP denial commits. */
type DeletionFloorRecorder = { recordCollectionDeletion(fact: CollectionDeletionFact): Promise<unknown> };

/** The current owner device of a synced next collection, held under its
 * collection lock: the same checks for rename and delete. Returns its label. */
async function ownedCollection(client: DatabaseConnection, connector: ConnectorIdentity, hash: string | null, collection: string): Promise<string> {
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
  const held = (await client.query<{ owner_user_id: string; runtime: string; sync: string; left: boolean; display_name: string }>(
    "SELECT owner_user_id,runtime,sync,left_sync_at IS NOT NULL AS left,COALESCE(display_name,'New collection') AS display_name FROM next_collections WHERE collection_id=$1 FOR UPDATE", [collection]
  )).rows[0];
  if (held?.owner_user_id !== discovered.owner_user_id || held.runtime !== "next" || !["cloud_copy", "private"].includes(held.sync) || held.left) throw notFound();
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
  return held.display_name;
}

/** Every grant on the deleted collection, for every account: app grants (the
 * #653 hook queues each log grant revoke), their tokens, installation scopes and
 * native background grants. Membership and device enrolment stay in policy;
 * the deletion fact already refuses their log tokens and bootstrap. */
async function revokeCollectionAccess(client: DatabaseConnection, collection: string): Promise<void> {
  const revoked = await client.query<{ id: string }>(
    `UPDATE grants SET revoked_at=COALESCE(revoked_at,now())
     WHERE revoked_at IS NULL AND (hosted_collection_id=$1 OR collection_id IN (SELECT id FROM collections WHERE local_id=$1))
     RETURNING id`, [collection]);
  const ids = revoked.rows.map(row => row.id);
  if (ids.length) for (const table of ["access_tokens", "refresh_tokens"] as const) {
    await client.query(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,now()) WHERE grant_id=ANY($1::uuid[])`, [ids]);
  }
  await client.query(`UPDATE next_background_grants SET revoked_at=clock_timestamp()
    WHERE principal_kind='installation' AND collection_id=$1 AND revoked_at IS NULL`, [collection]);
  await client.query("DELETE FROM installation_collection_scopes WHERE collection_id=$1", [collection]);
}

const DELETE_REFUSALS: Record<string, string> = {
  invalid_request: "A collection identifier and the collection's current name are required.",
  not_found: "Collection not found.",
  collection_name_mismatch: "The name you typed does not match this collection's name.",
  not_owner: "Only the collection's owner can delete it.",
  not_member: "Only the collection's owner can delete it.",
  installation_collection_not_approved: "This app was not given access to this collection.",
  installation_not_current: "This app's sign-in is no longer current. Sign in again.",
  identity_not_current: "This device's sign-in is no longer current. Sign in again.",
  device_revoked: "This device no longer has access to this collection.",
  migration_frozen: "Your account is being upgraded. Try again later.",
  busy: "The collection is busy. Try again.",
};
const deleteRefusal = (reply: FastifyReply, status: number, code: string) =>
  reply.code(status).send(apiError(code, DELETE_REFUSALS[code] ?? "The collection could not be deleted."));

export function registerCollectionNameRoutes(app: FastifyInstance, db: DatabasePool, deletionFloor?: DeletionFloorRecorder): void {
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
        await ownedCollection(client, connector, hash, collection);
        return (await client.query<{ collection_id: string; display_name: string }>(
          "UPDATE next_collections SET display_name=$2 WHERE collection_id=$1 RETURNING collection_id,display_name", [collection, displayName]
        )).rows[0]!;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "collection_deleted") return reply.code(404).send(apiError("not_found", "Collection not found."));
      return refuse(reply, error, "The collection name could not be changed.");
    }
  });

  // Owner deletion is a permanent soft delete: access ends now, while the stored
  // log and hosted data are retained, unreachable, until a separate erasure stage.
  app.delete<{ Body: { confirm_name: string } }>("/v1/next/collections/:id", {
    bodyLimit: 4096,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id }).safeParse(request.params);
    const body = z.object({ confirm_name: z.string().max(400) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return deleteRefusal(reply, 400, "invalid_request");
    const credential = bearerToken(request);
    const hash = credential === null ? null : tokenHash(credential);
    const connector = await requireInstallationDeviceConnector(request, reply, db);
    if (!connector) return reply;
    const collection = params.data.id, confirmName = body.data.confirm_name.trim();
    let fact: CollectionDeletionFact;
    try {
      fact = await inTransaction(db, async client => {
        const current = await ownedCollection(client, connector, hash, collection);
        if (confirmName !== current) throw new CreateError(409, "collection_name_mismatch");
        const recorded = await recordCollectionDeletionIntent(client, collection, connector.user_id);
        await revokeCollectionAccess(client, collection);
        await audit(client, connector.user_id, "next_collection.deleted", collection, { deletion_id: recorded.deletionId });
        return recorded;
      });
    } catch (error) {
      if (error instanceof Error && error.message === "collection_deleted") return deleteRefusal(reply, 404, "not_found");
      if (error instanceof RequestValidationError && error.code === "migration_frozen") return deleteRefusal(reply, 409, "migration_frozen");
      if (error instanceof CreateError) return deleteRefusal(reply, error.status === 502 ? 503 : error.status, error.code);
      return refuse(reply, error, "The collection could not be deleted.");
    }
    await recordNativeDeletionFloor(deletionFloor, fact, request.log);
    return { collection_id: collection, deleted: true };
  });
}

/** NATIVE DELETION FLOOR — separate from the committed CP decision above.
 * Sends the same immutable CP tuple to the authenticated nil registry. It records
 * denial only: no Gone, Deleted acknowledgement or erasure. A failed or lost
 * reply leaves the outcome UNKNOWN with the durable CP denial in force; it is
 * never treated as a native acknowledgement, and absence is never "settled". */
async function recordNativeDeletionFloor(recorder: DeletionFloorRecorder | undefined, fact: CollectionDeletionFact, log: FastifyBaseLogger): Promise<void> {
  if (!recorder) return;
  try { await recorder.recordCollectionDeletion(fact); }
  catch (error) { log.warn({ err: error, collection: fact.collection }, "native deletion floor outcome unknown; CP denial stays in force"); }
}
