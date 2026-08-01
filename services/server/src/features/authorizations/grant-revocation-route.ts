import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../db.js";
import {
  hostedGrantRevocationStatus,
  queueHostedGrantRevocation
} from "../../hosted-capability-lifecycle.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { requireUser } from "../../platform/request-authentication.js";
import type { RelayHub } from "../../relay.js";

interface GrantRevocationRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  tailscaleAuth?: boolean;
  hostedProvider?: HostedProviderClient;
  drainProviderRevocations(): Promise<void>;
}

export function registerGrantRevocationRoute(
  app: FastifyInstance,
  options: GrantRevocationRouteOptions
): void {
  app.delete("/v1/grants/:grantId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const active = await options.db.query<{
      id: string;
      connector_id: string | null;
      hosted_collection_id: string | null;
      hosted_replica_id: string | null;
      revoked_at: string | null;
    }>(
      `SELECT g.id, col.connector_id, g.hosted_collection_id,
              g.hosted_replica_id, g.revoked_at
       FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       WHERE g.id = $1 AND g.user_id = $2 AND g.activated_at IS NOT NULL`,
      [grantId, user.id]
    );
    const grant = active.rows[0];
    if (!grant) return reply.code(404).send(apiError("grant_not_found", "Grant not found."));
    let revocationStatus: "revoking" | "revoked" = "revoked";
    if (grant.hosted_replica_id) {
      if (!options.hostedProvider) {
        return reply.code(503).send(apiError(
          "hosted_provider_unavailable",
          "Hosted application access is temporarily unavailable."
        ));
      }
      if (!grant.revoked_at) {
        const queued = await queueHostedGrantRevocation(
          options.db,
          user.id,
          grantId,
          "user_request"
        );
        if (!queued) {
          return reply.code(409).send(apiError(
            "revocation_conflict",
            "Grant revocation changed concurrently. Retry the request."
          ));
        }
      }
      await options.drainProviderRevocations();
      const current = await hostedGrantRevocationStatus(options.db, user.id, grantId);
      if (current === "active" || current === null) {
        return reply.code(409).send(apiError(
          "revocation_conflict",
          "Grant revocation did not enter a durable state."
        ));
      }
      revocationStatus = current;
    } else {
      if (grant.revoked_at) {
        return { ok: true, revocation_status: "revoked" as const };
      }
      await options.db.query(
        "UPDATE grants SET revoked_at = now() WHERE id = $1",
        [grantId]
      );
      await options.db.query(
        "UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1",
        [grantId]
      );
      await options.db.query(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1",
        [grantId]
      );
    }
    if (grant.connector_id) await options.relay.pushPolicy(grant.connector_id);
    await audit(
      options.db,
      user.id,
      revocationStatus === "revoked"
        ? "grant.revoked"
        : "grant.revocation_requested",
      grantId,
      { revocation_status: revocationStatus }
    );
    return { ok: true, revocation_status: revocationStatus };
  });
}
