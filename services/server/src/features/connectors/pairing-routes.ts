import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { randomToken, tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import {
  bearerToken,
  requireUser
} from "../../platform/request-authentication.js";

interface ConnectorPairingRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  tailscaleAuth?: boolean;
}

export function registerConnectorPairingRoutes(
  app: FastifyInstance,
  options: ConnectorPairingRoutesOptions
): void {
  app.post("/v1/pairing-requests", async (request, reply) => {
    const input = z.object({
      connector_name: z.string().trim().min(1).max(100)
    }).parse(request.body);
    const id = randomUUID();
    const secret = randomToken("pair");
    await options.db.query(
      `INSERT INTO pairing_requests (id, secret_hash, connector_name, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [id, tokenHash(secret), input.connector_name]
    );
    return reply.code(201).send({
      pairing_id: id,
      pairing_secret: secret,
      verification_uri: `${options.publicUrl}/pair/${id}`,
      expires_in: 600
    });
  });

  app.get("/v1/pairing-requests/:pairingId", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const { pairingId } = z.object({
      pairingId: z.uuid()
    }).parse(request.params);
    const pairing = await options.db.query<{
      id: string;
      connector_name: string;
      approved_at: string | null;
      consumed_at: string | null;
      expires_at: string;
    }>(
      `SELECT id, connector_name, approved_at, consumed_at, expires_at
       FROM pairing_requests
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [pairingId]
    );
    if (!pairing.rows[0]) {
      return reply.code(404).send(apiError(
        "pairing_not_found",
        "Pairing request expired or was not found."
      ));
    }
    return { pairing: pairing.rows[0] };
  });

  app.post("/v1/pairing-requests/:pairingId/approve", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const { pairingId } = z.object({
      pairingId: z.uuid()
    }).parse(request.params);
    const approved = await options.db.query<{
      id: string;
      connector_name: string;
    }>(
      `UPDATE pairing_requests SET user_id = $2, approved_at = now()
       WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL
         AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, connector_name`,
      [pairingId, user.id]
    );
    if (!approved.rows[0]) {
      return reply.code(404).send(apiError(
        "pairing_not_found",
        "Pairing request expired or was already used."
      ));
    }
    await audit(
      options.db,
      user.id,
      "connector.pairing_approved",
      pairingId,
      { name: approved.rows[0].connector_name }
    );
    return {
      ok: true,
      deep_link: `mdbase-connect://paired?server=${
        encodeURIComponent(options.publicUrl)
      }&pairing_id=${pairingId}`
    };
  });

  app.post("/v1/pairing-requests/:pairingId/exchange", async (request, reply) => {
    const { pairingId } = z.object({
      pairingId: z.uuid()
    }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) {
      return reply.code(401).send(apiError(
        "invalid_pairing",
        "Pairing secret required."
      ));
    }
    const connection = await options.db.connect();
    try {
      await connection.query("BEGIN");
      const pairing = await connection.query<{
        id: string;
        connector_name: string;
        user_id: string | null;
        approved_at: string | null;
        consumed_at: string | null;
      }>(
        `SELECT id, connector_name, user_id, approved_at, consumed_at
         FROM pairing_requests
         WHERE id = $1 AND secret_hash = $2
           AND revoked_at IS NULL AND expires_at > now()`,
        [pairingId, tokenHash(secret)]
      );
      const pending = pairing.rows[0];
      if (!pending) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "pairing_not_found",
          "Pairing request expired or was not found."
        ));
      }
      if (pending.consumed_at) {
        await connection.query("ROLLBACK");
        return reply.code(409).send(apiError(
          "pairing_used",
          "Pairing request has already been used."
        ));
      }
      if (!pending.approved_at || !pending.user_id) {
        await connection.query("COMMIT");
        return reply.code(202).send({ status: "pending" });
      }
      const activeAccount = await connection.query(
        `SELECT id FROM users
         WHERE id = $1 AND suspended_at IS NULL
         FOR UPDATE`,
        [pending.user_id]
      );
      if (!activeAccount.rows[0]) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "pairing_not_found",
          "Pairing request expired or was not found."
        ));
      }
      const locked = await connection.query<{
        connector_name: string;
        consumed_at: string | null;
      }>(
        `SELECT connector_name, consumed_at
         FROM pairing_requests
         WHERE id = $1 AND secret_hash = $2 AND user_id = $3
           AND approved_at IS NOT NULL
           AND revoked_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [pairingId, tokenHash(secret), pending.user_id]
      );
      if (!locked.rows[0]) {
        await connection.query("ROLLBACK");
        return reply.code(404).send(apiError(
          "pairing_not_found",
          "Pairing request expired or was not found."
        ));
      }
      if (locked.rows[0].consumed_at) {
        await connection.query("ROLLBACK");
        return reply.code(409).send(apiError(
          "pairing_used",
          "Pairing request has already been used."
        ));
      }
      const consumed = await connection.query(
        `UPDATE pairing_requests SET consumed_at = now()
         WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
        [pairingId]
      );
      if (!consumed.rows[0]) {
        await connection.query("ROLLBACK");
        return reply.code(409).send(apiError(
          "pairing_used",
          "Pairing request has already been used."
        ));
      }
      const token = randomToken("con");
      const connector = await connection.query<{ id: string; name: string }>(
        `INSERT INTO connectors (id, user_id, name, token_hash)
         VALUES ($1, $2, $3, $4) RETURNING id, name`,
        [
          randomUUID(),
          pending.user_id,
          locked.rows[0].connector_name,
          tokenHash(token)
        ]
      );
      await audit(
        connection,
        pending.user_id,
        "connector.created",
        connector.rows[0].id,
        {
          name: locked.rows[0].connector_name,
          pairing_id: pairingId
        }
      );
      await connection.query("COMMIT");
      return { status: "paired", connector: connector.rows[0], token };
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  });
}
