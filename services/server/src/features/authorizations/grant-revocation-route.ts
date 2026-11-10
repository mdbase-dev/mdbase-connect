import { randomUUID } from "node:crypto";
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
import type { RelayHub } from "../relay/relay.js";
import { deliverGrantRevocations, localGrantRevocationStatus, queueLocalGrantRevocations } from "../grants/local-grant-revocation.js";

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
  app.post("/v1/grants/revoke-batch", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      grant_ids: z.array(z.uuid()).min(1).max(100)
    }).strict().parse(request.body);
    const grantIds = [...new Set(input.grant_ids)];
    const grantParameters = grantIds.map((_id, index) => `$${index + 1}`).join(", ");
    const found = await options.db.query<{
      id: string;
      connector_id: string | null;
      hosted_replica_id: string | null;
      revoked_at: string | null;
    }>(
      `SELECT g.id, col.connector_id, g.hosted_replica_id, g.revoked_at
       FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       WHERE g.id IN (${grantParameters}) AND g.user_id = $${grantIds.length + 1}
         AND g.activated_at IS NOT NULL`,
      [...grantIds, user.id]
    );
    if (found.rows.length !== grantIds.length) {
      return reply.code(404).send(apiError(
        "grant_not_found",
        "One or more application grants were not found; no batch revocation was attempted."
      ));
    }

    const localIds = found.rows.filter((grant) => !grant.hosted_replica_id).map((grant) => grant.id);
    await queueLocalGrantRevocations(options.db, user.id, localIds);

    const results: Array<{
      grant_id: string;
      status: "revoked" | "revoking" | "conflict";
    }> = [];
    for (const grant of found.rows) {
      const queued = !grant.hosted_replica_id || grant.revoked_at || await queueHostedGrantRevocation(
        options.db, user.id, grant.id, "user_batch_request"
      );
      results.push({ grant_id: grant.id, status: queued ? "revoking" : "conflict" });
    }
    // Explicit removal dismisses old reauthorization notices, not grant history.
    // Only durable tombstones qualify; an active conflict keeps its review state.
    await options.db.query(
      `UPDATE grants SET reauthorization_required_at = NULL, reauthorization_reason = NULL
       WHERE id IN (${grantParameters}) AND user_id = $${grantIds.length + 1}
         AND revoked_at IS NOT NULL`,
      [...grantIds, user.id]
    );
    await options.drainProviderRevocations();
    await deliverGrantRevocations(options.relay, found.rows.map((grant) => grant.connector_id), request.log);
    const statuses = await options.db.query<{ id: string; status: "revoked" | "revoking" | "conflict" }>(
      `SELECT g.id, CASE
         WHEN g.revoked_at IS NULL THEN 'conflict'
         WHEN g.hosted_replica_id IS NOT NULL THEN CASE WHEN g.id IN (
           SELECT grant_id FROM provider_revocation_jobs WHERE completed_at IS NULL
         ) THEN 'revoking' ELSE 'revoked' END
         WHEN g.revocation_confirmed_at IS NOT NULL THEN 'revoked'
         ELSE 'revoking' END AS status
       FROM grants g WHERE g.id IN (${grantParameters}) AND g.user_id = $${grantIds.length + 1}`,
      [...grantIds, user.id]
    );
    const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
    for (const result of results) {
      if (result.status !== "conflict") result.status = byId.get(result.grant_id)!;
    }
    await options.db.query(
      `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata) VALUES ${results.map((_, index) =>
        `($${index * 5 + 1}, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5}::jsonb)`
      ).join(", ")}`,
      results.flatMap((result) => [randomUUID(), user.id,
        result.status === "revoked" ? "grant.revoked" : "grant.revocation_requested", result.grant_id,
        JSON.stringify({ revocation_status: result.status, batch: true })])
    );
    return {
      ok: results.every((result) => result.status !== "conflict"),
      results
    };
  });

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
      await queueLocalGrantRevocations(options.db, user.id, [grantId]);
    }
    await deliverGrantRevocations(options.relay, [grant.connector_id], request.log);
    if (!grant.hosted_replica_id) revocationStatus = await localGrantRevocationStatus(options.db, user.id, grantId);
    await options.db.query(
      `UPDATE grants SET reauthorization_required_at = NULL, reauthorization_reason = NULL
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NOT NULL`,
      [grantId, user.id]
    );
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
