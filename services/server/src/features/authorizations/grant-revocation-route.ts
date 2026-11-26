import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../db.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { requireUser } from "../../platform/request-authentication.js";
import type { RelayHub } from "../relay/relay.js";
import { deliverGrantRevocations, grantVisibleToManagementSql, localGrantRevocationStatus, queueLocalGrantRevocations } from "../grants/local-grant-revocation.js";

interface GrantRevocationRouteOptions {
  db: DatabasePool;
  relay: RelayHub;
  tailscaleAuth?: boolean;
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
      revoked_at: string | null;
    }>(
      `SELECT g.id, col.connector_id, g.revoked_at
       FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       WHERE g.id IN (${grantParameters}) AND g.user_id = $${grantIds.length + 1}
         AND g.activated_at IS NOT NULL AND ${grantVisibleToManagementSql}`,
      [...grantIds, user.id]
    );
    if (found.rows.length !== grantIds.length) {
      return reply.code(404).send(apiError(
        "grant_not_found",
        "One or more application grants were not found; no batch revocation was attempted."
      ));
    }

    await queueLocalGrantRevocations(options.db, user.id, found.rows.map((grant) => grant.id));

    await options.db.query(
      `UPDATE grants SET reauthorization_required_at = NULL, reauthorization_reason = NULL
       WHERE id IN (${grantParameters}) AND user_id = $${grantIds.length + 1}
         AND revoked_at IS NOT NULL`,
      [...grantIds, user.id]
    );
    await deliverGrantRevocations(options.relay, found.rows.map((grant) => grant.connector_id), request.log);
    const statuses = await options.db.query<{ id: string; status: "revoked" | "revoking" | "conflict" }>(
      `SELECT g.id, CASE
         WHEN g.revoked_at IS NULL THEN 'conflict'
         WHEN g.revocation_confirmed_at IS NOT NULL THEN 'revoked'
         ELSE 'revoking' END AS status
       FROM grants g WHERE g.id IN (${grantParameters}) AND g.user_id = $${grantIds.length + 1}`,
      [...grantIds, user.id]
    );
    const byId = new Map(statuses.rows.map((row) => [row.id, row.status]));
    const results = found.rows.map((grant) => ({
      grant_id: grant.id,
      status: byId.get(grant.id) ?? ("conflict" as const)
    }));
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
      revoked_at: string | null;
    }>(
      `SELECT g.id, col.connector_id, g.revoked_at
       FROM grants g
       LEFT JOIN collections col ON col.id = g.collection_id
       WHERE g.id = $1 AND g.user_id = $2 AND g.activated_at IS NOT NULL AND ${grantVisibleToManagementSql}`,
      [grantId, user.id]
    );
    const grant = active.rows[0];
    if (!grant) return reply.code(404).send(apiError("grant_not_found", "Grant not found."));
    await queueLocalGrantRevocations(options.db, user.id, [grantId]);
    await deliverGrantRevocations(options.relay, [grant.connector_id], request.log);
    const revocationStatus = await localGrantRevocationStatus(options.db, user.id, grantId);
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
