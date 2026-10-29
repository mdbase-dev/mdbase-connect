/** An installation ends its OWN device session with only its idev_ bearer
 * (SDK signOut). Every other revoke route needs a browser session. */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { requireInstallationDeviceConnector, requireSessionContext } from "../../platform/request-authentication.js";
import { inTransaction, isLockTimeout, lock } from "../next/bootstrap-common.js";
import { nextDeviceNeedsRevoke, queueNextPolicy, type PolicyEmitter } from "../next/policy-outbox.js";

class SignOutError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

type SignedOut = { collections: string[]; fenceGeneration: string };

/** One transaction: credential lock, per-collection device revoke + scope removal,
 * connector revoke with relay fence bump. Migration 0069's connector trigger
 * revokes the installation's background grants; nothing here duplicates it. */
async function signOutInstallation(db: DatabasePool, connectorId: string, userId: string, deviceId: string): Promise<SignedOut> {
  return inTransaction(db, async c => {
    const credential = await c.query<{ revoked: boolean }>(
      `SELECT c.revoked_at IS NOT NULL AS revoked FROM installation_device_credentials k
       JOIN connectors c ON c.id=k.connector_id
       WHERE k.connector_id=$1 AND k.device_id=$2 AND c.user_id=$3 FOR UPDATE OF k`,
      [connectorId, deviceId, userId]);
    // Revoked between authentication and this lock: already signed out.
    if (!credential.rows[0] || credential.rows[0].revoked)
      throw new SignOutError(401, "invalid_connector", "Device credential is invalid.");
    const scopes = await c.query<{ collection_id: string }>(
      "SELECT collection_id FROM installation_collection_scopes WHERE connector_id=$1 ORDER BY collection_id", [connectorId]);
    for (const { collection_id: collection } of scopes.rows) {
      await lock(c, collection);
      await c.query("SELECT 1 FROM next_collections WHERE collection_id=$1 FOR UPDATE", [collection]);
      if (await nextDeviceNeedsRevoke(c, collection, deviceId)
        && !await queueNextPolicy(c, collection, [{ op: "device-revoke", device: deviceId }]))
        throw new SignOutError(409, "installation_collection_unavailable", "A collection's access could not be revoked. Try again.");
      await c.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2", [connectorId, collection]);
    }
    const removed = await c.query<{ fence_generation: string | number }>(
      `UPDATE connectors SET revoked_at=now(), relay_generation=relay_generation+1
       WHERE id=$1 AND revoked_at IS NULL RETURNING relay_generation AS fence_generation`, [connectorId]);
    // Unreachable under the credential lock unless revoked concurrently; same answer.
    if (!removed.rows[0]) throw new SignOutError(401, "invalid_connector", "Device credential is invalid.");
    const fenceGeneration = String(removed.rows[0].fence_generation);
    await audit(c, userId, "device.installation_signed_out", connectorId,
      { device_id: deviceId, collections: scopes.rows.length, fence_generation: fenceGeneration });
    return { collections: scopes.rows.map(row => row.collection_id), fenceGeneration };
  });
}

export function registerInstallationSignOutRoute(app: FastifyInstance, options: { db: DatabasePool; relay: Pick<RelayHub, "fenceConnector">; emitter?: Pick<PolicyEmitter, "publishCommitted"> }): void {
  app.delete("/v1/account/installations/:connectorId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const session = await requireSessionContext(request, reply, options.db);
    if (!session) return;
    const { connectorId } = z.object({ connectorId: z.uuid() }).parse(request.params);
    const owned = await options.db.query<{ device_id: string }>(
      `SELECT k.device_id FROM installation_device_credentials k JOIN connectors c ON c.id=k.connector_id
       WHERE c.id=$1 AND c.user_id=$2 AND c.revoked_at IS NULL`, [connectorId, session.user.id]);
    if (!owned.rows[0]) return reply.code(404).send(apiError("installation_not_found", "App installation not found."));
    return finish(reply, connectorId, session.user.id, owned.rows[0].device_id);
  });
  app.delete("/v1/next/installation", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const connector = await requireInstallationDeviceConnector(request, reply, options.db);
    if (!connector) return reply;
    if (!connector.installation_device_id)
      return reply.code(403).send(apiError("installation_required", "Only an app installation can sign itself out here."));
    return finish(reply, connector.id, connector.user_id, connector.installation_device_id);
  });
  async function finish(reply: FastifyReply, connectorId: string, userId: string, deviceId: string) {
    let result: SignedOut;
    try {
      result = await signOutInstallation(options.db, connectorId, userId, deviceId);
    } catch (error) {
      if (error instanceof SignOutError) return reply.code(error.status).send(apiError(error.code, error.message));
      if (isLockTimeout(error) || (error as { code?: unknown } | null)?.code === "40P01")
        return reply.code(503).send(apiError("busy", "Sign-out is busy. Try again."));
      throw error;
    }
    // Deliver the committed device-revokes now, not on the next global outbox poll.
    for (const collection of result.collections) options.emitter?.publishCommitted(collection).catch(() => undefined);
    let fence: "closed" | "committed_with_degraded_fence" = "committed_with_degraded_fence";
    try {
      // Revocation, fence generation and audit are already committed.
      if (await options.relay.fenceConnector(connectorId, result.fenceGeneration) === "closed") fence = "closed";
    } catch { /* degraded fence is still a completed sign-out */ }
    return { ok: true, revoked: true, collections: result.collections.length, fence };
  }
}
