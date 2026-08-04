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

    const localIds = found.rows
      .filter((grant) => !grant.hosted_replica_id && !grant.revoked_at)
      .map((grant) => grant.id);
    if (localIds.length > 0) {
      const localParameters = localIds.map((_id, index) => `$${index + 1}`).join(", ");
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        await connection.query(
          `UPDATE grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id IN (${localParameters})`,
          localIds
        );
        await connection.query(
          `UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id IN (${localParameters})`,
          localIds
        );
        await connection.query(
          `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id IN (${localParameters})`,
          localIds
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }

    const results: Array<{
      grant_id: string;
      status: "revoked" | "revoking" | "conflict";
    }> = [];
    for (const grant of found.rows) {
      if (!grant.hosted_replica_id) {
        results.push({ grant_id: grant.id, status: "revoked" });
        continue;
      }
      if (!grant.revoked_at) {
        const queued = await queueHostedGrantRevocation(
          options.db,
          user.id,
          grant.id,
          "user_batch_request"
        );
        if (!queued) {
          results.push({ grant_id: grant.id, status: "conflict" });
          continue;
        }
      }
      const status = await hostedGrantRevocationStatus(options.db, user.id, grant.id);
      results.push({
        grant_id: grant.id,
        status: status === "revoking" ? "revoking" : status === "revoked" ? "revoked" : "conflict"
      });
    }
    await options.drainProviderRevocations();
    for (const result of results) {
      if (result.status !== "revoking") continue;
      const status = await hostedGrantRevocationStatus(options.db, user.id, result.grant_id);
      if (status === "revoked") result.status = "revoked";
    }
    for (const connectorId of new Set(found.rows.map((grant) => grant.connector_id).filter(Boolean))) {
      await options.relay.pushPolicy(connectorId!);
    }
    for (const result of results) {
      await audit(options.db, user.id, result.status === "revoked"
        ? "grant.revoked"
        : "grant.revocation_requested", result.grant_id, {
        revocation_status: result.status,
        batch: true
      });
    }
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
