// Owner intent/status only. The direction-specific device/key work is deliberately
// separate: accepting a request neither changes policy nor claims key readiness.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken, requireConnector, requireSessionContext } from "../../platform/request-authentication.js";
import { tokenHash } from "../../security.js";
import { CreateError, currentIdentity, currentMember, currentSession, exactEnrolment, inTransaction, lock, refuse, refuseRevoked, type Connector, type Device } from "./bootstrap-common.js";
import { requireCollectionNotDeleted } from "./collection-deletion.js";
import { LOG_TOKEN_LIFETIME_MS } from "./log-service-client.js";
import { requireNextAccountNotMigrationFrozen } from "./migration-topology.js";

const uuid = z.uuid().transform(value => value.toLowerCase()).refine(value => value !== "00000000-0000-0000-0000-000000000000");
const mode = z.enum(["private", "cloud_copy"]);
export type Mode = z.infer<typeof mode>;
export type Owner = { account: string } & ({ session: string } | { connector: Connector; hash: string });
type Change = {
  request_id: string; source_mode: Mode; target_mode: Mode;
  policy_outbox_id: string | null; completed_at: Date | null;
};

export async function authenticateOwner(request: FastifyRequest, reply: FastifyReply, db: DatabasePool): Promise<Owner | null> {
  // A supplied bearer never falls back to a browser cookie. Installation/app
  // credentials have no collection-mode authority, even if they can create data.
  const token = bearerToken(request);
  if (token !== null) {
    const connector = await requireConnector(request, reply, db);
    return connector ? { account: connector.user_id, connector, hash: tokenHash(token) } : null;
  }
  const session = await requireSessionContext(request, reply, db);
  return session ? { account: session.user.id, session: session.sessionId } : null;
}

/** Account/credential locks precede the shared collection lock, as for bootstrap
 * and owner deletion. Every POST/retry/GET reauthorizes; old intent is not access. */
export async function ownedMode(client: DatabaseConnection, owner: Owner, collection: string): Promise<Mode> {
  await requireNextAccountNotMigrationFrozen(client, owner.account);
  if (!(await client.query("SELECT 1 FROM users WHERE id=$1 AND account_backend='next' AND suspended_at IS NULL FOR SHARE", [owner.account])).rows.length)
    throw new CreateError(404, "not_found");
  let device: (Device & { id: string }) | undefined;
  if ("session" in owner) await currentSession(client, owner.session, owner.account);
  else {
    if (!(await client.query("SELECT 1 FROM connectors WHERE id=$1 AND user_id=$2 AND token_hash=$3 AND revoked_at IS NULL FOR SHARE", [owner.connector.id, owner.account, owner.hash])).rows.length)
      throw new CreateError(403, "identity_not_current");
    device = (await client.query<Device & { id: string }>("SELECT id,sign_pk,kem_pk,noise_pk,kind FROM next_devices WHERE connector_id=$1 AND user_id=$2", [owner.connector.id, owner.account])).rows[0];
    if (!device || !["desktop", "cli"].includes(device.kind)) throw new CreateError(403, "invalid_device_kind");
    await currentIdentity(client, owner.connector, device.id, device);
  }
  await lock(client, collection);
  const current = (await client.query<{ sync: Mode }>(
    `SELECT sync FROM next_collections WHERE collection_id=$1 AND owner_user_id=$2
     AND runtime='next' AND left_sync_at IS NULL FOR UPDATE`, [collection, owner.account]
  )).rows[0];
  if (!current) throw new CreateError(404, "not_found");
  try { await requireCollectionNotDeleted(client, collection); }
  catch (error) {
    if (error instanceof Error && error.message === "collection_deleted") throw new CreateError(404, "not_found");
    throw error;
  }
  await currentMember(client, collection, owner.account, "owner");
  if (device) {
    await refuseRevoked(client, collection, device.id);
    if (!(await client.query(
      `SELECT 1 FROM next_policy_outbox o JOIN next_policy_batches b ON b.id=o.batch_id
       WHERE o.collection_id=$1 AND b.state='appended' AND b.lost_at IS NULL
       AND o.ops->'ops' @> $2::jsonb LIMIT 1`, [collection, exactEnrolment(device.id, owner.account, device)]
    )).rows.length) throw new CreateError(403, "not_enrolled");
  }
  return current.sync;
}

async function status(client: DatabaseConnection, collection: string, current: Mode, change: Change) {
  // No HTTP reply, outbox insertion, or batch's sending state is a success receipt.
  // Later direction-specific phases record completion only after key/cleanup evidence.
  let phase = "waiting_for_device";
  let retryAt: string | undefined;
  if (change.target_mode === "private" && change.policy_outbox_id === null) {
    const floor = (await client.query<{ mode_floor_raised_at: Date | null }>("SELECT mode_floor_raised_at FROM next_collections WHERE collection_id=$1", [collection])).rows[0]?.mode_floor_raised_at;
    if (floor && Date.now() < floor.getTime() + LOG_TOKEN_LIFETIME_MS) {
      phase = "waiting_for_token_expiry"; retryAt = new Date(floor.getTime() + LOG_TOKEN_LIFETIME_MS).toISOString();
    }
  }
  if (change.policy_outbox_id !== null) {
    const batch = (await client.query<{ state: string; lost: boolean }>(
      `SELECT b.state,b.lost_at IS NOT NULL AS lost FROM next_policy_outbox o
       LEFT JOIN next_policy_batches b ON b.id=o.batch_id
       WHERE o.id=$1 AND o.collection_id=$2`, [change.policy_outbox_id, collection]
    )).rows[0];
    phase = batch?.state === "appended" && !batch.lost ? "finishing" : "publishing_policy";
    if (phase === "finishing" && change.completed_at !== null) phase = "complete";
  }
  return { collection_id: collection, request_id: change.request_id, current_mode: current,
    source_mode: change.source_mode, target_mode: change.target_mode, phase, ...(retryAt ? { retry_at: retryAt } : {}) };
}

export function registerCollectionModeRoutes(app: FastifyInstance, db: DatabasePool): void {
  app.post("/v1/next/collections/:id/mode", {
    bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id: uuid }).safeParse(request.params);
    const body = z.object({ request_id: uuid, target_mode: mode }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(apiError("invalid_request", "A collection, request identifier and mode are required."));
    const owner = await authenticateOwner(request, reply, db);
    if (!owner) return reply;
    const collection = params.data.id, { request_id: requestId, target_mode: target } = body.data;
    try {
      const result = await inTransaction(db, async client => {
        const current = await ownedMode(client, owner, collection);
        const previous = (await client.query<Change>("SELECT * FROM next_collection_mode_changes WHERE collection_id=$1 AND request_id=$2", [collection, requestId])).rows[0];
        if (previous) {
          if (previous.target_mode !== target) throw new CreateError(409, "mode_request_conflict");
          return status(client, collection, current, previous);
        }
        if ((await client.query("SELECT 1 FROM next_collection_mode_changes WHERE collection_id=$1 AND completed_at IS NULL", [collection])).rows.length)
          throw new CreateError(409, "mode_change_in_progress");
        if (current === target) throw new CreateError(409, "mode_already_current");
        const change = (await client.query<Change>(
          `INSERT INTO next_collection_mode_changes(collection_id,request_id,actor_id,source_mode,target_mode)
           VALUES($1,$2,$3,$4,$5) RETURNING *`, [collection, requestId, owner.account, current, target]
        )).rows[0]!;
        return status(client, collection, current, change);
      });
      return reply.code(202).send(result);
    } catch (error) { return refuse(reply, error, "The switch could not be started. Try again."); }
  });

  app.get("/v1/next/collections/:id/mode", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(apiError("invalid_request", "A collection identifier is required."));
    const owner = await authenticateOwner(request, reply, db);
    if (!owner) return reply;
    try {
      return await inTransaction(db, async client => {
        const current = await ownedMode(client, owner, params.data.id);
        const change = (await client.query<Change>("SELECT * FROM next_collection_mode_changes WHERE collection_id=$1 AND completed_at IS NULL", [params.data.id])).rows[0];
        return { collection_id: params.data.id, current_mode: current,
          execution_available: app.hasRoute({method:"POST",url:"/v1/next/collections/:id/mode/:requestId/prepare"}),
          change: change ? await status(client, params.data.id, current, change) : null };
      });
    } catch (error) { return refuse(reply, error, "The switch status is unavailable. Try again."); }
  });

  app.get("/v1/next/collections/:id/mode/:requestId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = z.object({ id: uuid, requestId: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(apiError("invalid_request", "A collection and request identifier are required."));
    const owner = await authenticateOwner(request, reply, db);
    if (!owner) return reply;
    try {
      return await inTransaction(db, async client => {
        const current = await ownedMode(client, owner, params.data.id);
        const change = (await client.query<Change>("SELECT * FROM next_collection_mode_changes WHERE collection_id=$1 AND request_id=$2", [params.data.id, params.data.requestId])).rows[0];
        if (!change) throw new CreateError(404, "not_found");
        return status(client, params.data.id, current, change);
      });
    } catch (error) { return refuse(reply, error, "The switch status is unavailable. Try again."); }
  });
}
