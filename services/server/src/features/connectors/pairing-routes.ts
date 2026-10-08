import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { randomToken, tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import {
  bearerToken,
  requireSessionContext,
  requireUser,
} from "../../platform/request-authentication.js";

import {
  InstallationPairingError,
  installationPairingExists,
  startInstallationPairing,
  inspectInstallationPairing,
  selectInstallationAccount,
  attestInstallationPairing,
  approveInstallationPairing,
  exchangeInstallationPairing,
  denyInstallationPairing,
} from "./installation-pairing.js";
import { CreateError, isLockTimeout } from "../next/bootstrap-common.js";
async function installationResult(
  reply: FastifyReply,
  work: () => Promise<unknown>,
) {
  reply.header("cache-control", "no-store");
  try {
    return await work();
  } catch (e) {
    if (e instanceof InstallationPairingError)
      return reply.code(e.status).send(apiError(e.code, e.message));
    if (e instanceof CreateError)
      return reply
        .code(e.status)
        .send(
          apiError(e.code, "Device sign-in authority is no longer current."),
        );
    if ((e as { code?: unknown } | null)?.code === "23505")
      return reply.code(409).send(apiError("installation_actor_conflict", "This installation already has an original sign-in. Preserve and reconcile it."));
    if (isLockTimeout(e))
      return reply
        .code(503)
        .send(
          apiError(
            "busy",
            "Device sign-in is busy. Preserve the original request.",
          ),
        );
    throw e;
  }
}
const originalUuid = z
  .uuid()
  .refine(
    (v) =>
      v === v.toLowerCase() && v !== "00000000-0000-0000-0000-000000000000",
  );

interface ConnectorPairingRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  tailscaleAuth?: boolean;
  /** SAME approval channel, enabled only with next control-plane support. */
  installationDevices?: boolean;
}

export function registerConnectorPairingRoutes(
  app: FastifyInstance,
  options: ConnectorPairingRoutesOptions,
): void {
  app.post("/v1/pairing-requests", async (request, reply) => {
    if (
      request.body &&
      typeof request.body === "object" &&
      "installation" in request.body
    ) {
      if (!options.installationDevices)
        return reply
          .code(404)
          .send(
            apiError(
              "installation_devices_unavailable",
              "Installation device sign-in is unavailable.",
            ),
          );
      const input = z
        .object({
          connector_name: z.string().trim().min(1).max(100),
          installation: z
            .object({
              request_id: originalUuid,
              pairing_secret: z.string().regex(/^pair_[A-Za-z0-9_-]{43}$/),
              installation_id: originalUuid,
              device_id: originalUuid,
              kind: z.enum(["app-runtime", "mobile"]),
            })
            .strict(),
        })
        .strict()
        .parse(request.body);
      return installationResult(reply, async () => {
        const result = await startInstallationPairing(
          options.db,
          { connector_name: input.connector_name, ...input.installation },
          options.publicUrl,
        );
        return reply.code(201).send(result);
      });
    }
    const input = z
      .object({
        connector_name: z.string().trim().min(1).max(100),
      })
      .parse(request.body);
    const id = randomUUID();
    const secret = randomToken("pair");
    await options.db.query(
      `INSERT INTO pairing_requests (id, secret_hash, connector_name, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [id, tokenHash(secret), input.connector_name],
    );
    return reply.code(201).send({
      pairing_id: id,
      pairing_secret: secret,
      verification_uri: `${options.publicUrl}/pair/${id}`,
      expires_in: 600,
    });
  });

  app.get("/v1/pairing-requests/:pairingId", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth,
    );
    if (!user) return;
    const { pairingId } = z
      .object({
        pairingId: z.uuid(),
      })
      .parse(request.params);
    if (await installationPairingExists(options.db, pairingId)) {
      if (!options.installationDevices)
        return reply
          .code(404)
          .send(
            apiError(
              "installation_devices_unavailable",
              "Installation device sign-in is unavailable.",
            ),
          );
      return installationResult(reply, () =>
        inspectInstallationPairing(options.db, pairingId, user.id),
      );
    }
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
      [pairingId],
    );
    if (!pairing.rows[0]) {
      return reply
        .code(404)
        .send(
          apiError(
            "pairing_not_found",
            "Pairing request expired or was not found.",
          ),
        );
    }
    return { pairing: pairing.rows[0] };
  });

  app.post(
    "/v1/pairing-requests/:pairingId/approve",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth,
      );
      if (!user) return;
      const { pairingId } = z
        .object({
          pairingId: z.uuid(),
        })
        .parse(request.params);
      if (await installationPairingExists(options.db, pairingId)) {
        if (!options.installationDevices)
          return reply
            .code(404)
            .send(
              apiError(
                "installation_devices_unavailable",
                "Installation device sign-in is unavailable.",
              ),
            );
        const session = await requireSessionContext(request, reply, options.db);
        if (!session) return;
        return installationResult(reply, () =>
          approveInstallationPairing(
            options.db,
            pairingId,
            session.user.id,
            session.sessionId,
          ),
        );
      }
      const approved = await options.db.query<{
        id: string;
        connector_name: string;
      }>(
        `UPDATE pairing_requests SET user_id = $2, approved_at = now()
       WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL
         AND revoked_at IS NULL AND expires_at > now()
       RETURNING id, connector_name`,
        [pairingId, user.id],
      );
      if (!approved.rows[0]) {
        return reply
          .code(404)
          .send(
            apiError(
              "pairing_not_found",
              "Pairing request expired or was already used.",
            ),
          );
      }
      await audit(
        options.db,
        user.id,
        "connector.pairing_approved",
        pairingId,
        { name: approved.rows[0].connector_name },
      );
      return {
        ok: true,
        deep_link: `mdbase-connect://paired?server=${encodeURIComponent(
          options.publicUrl,
        )}&pairing_id=${pairingId}`,
      };
    },
  );

  if (options.installationDevices) {
    app.post(
      "/v1/pairing-requests/:pairingId/select-account",
      async (request, reply) => {
        const session = await requireSessionContext(request, reply, options.db);
        if (!session) return;
        const { pairingId } = z
          .object({ pairingId: originalUuid })
          .parse(request.params);
        return installationResult(reply, () =>
          selectInstallationAccount(
            options.db,
            pairingId,
            session.user.id,
            session.sessionId,
          ),
        );
      },
    );
    app.post("/v1/pairing-requests/:pairingId/deny", async (request, reply) => {
      const session = await requireSessionContext(request, reply, options.db);
      if (!session) return;
      const { pairingId } = z
        .object({ pairingId: originalUuid })
        .parse(request.params);
      return installationResult(reply, () =>
        denyInstallationPairing(
          options.db,
          pairingId,
          session.user.id,
          session.sessionId,
        ),
      );
    });
    app.post(
      "/v1/pairing-requests/:pairingId/attest",
      async (request, reply) => {
        const { pairingId } = z
            .object({ pairingId: originalUuid })
            .parse(request.params),
          secret = bearerToken(request);
        if (!secret)
          return reply
            .code(401)
            .send(apiError("invalid_pairing", "Pairing secret required."));
        const body = z
          .object({
            sign_pk: z.string().regex(/^[0-9a-f]{64}$/),
            kem_pk: z.string().regex(/^[0-9a-f]{64}$/),
            noise_pk: z.string().regex(/^[0-9a-f]{64}$/),
            sig: z.string().regex(/^[0-9a-f]{128}$/),
          })
          .strict()
          .parse(request.body);
        return installationResult(reply, () =>
          attestInstallationPairing(options.db, pairingId, secret, body),
        );
      },
    );
  }
  app.post(
    "/v1/pairing-requests/:pairingId/exchange",
    async (request, reply) => {
      const { pairingId } = z
        .object({
          pairingId: z.uuid(),
        })
        .parse(request.params);
      const secret = bearerToken(request);
      if (!secret) {
        return reply
          .code(401)
          .send(apiError("invalid_pairing", "Pairing secret required."));
      }
      if (await installationPairingExists(options.db, pairingId)) {
        if (!options.installationDevices)
          return reply
            .code(404)
            .send(
              apiError(
                "installation_devices_unavailable",
                "Installation device sign-in is unavailable.",
              ),
            );
        return installationResult(reply, async () => {
          const result = await exchangeInstallationPairing(
            options.db,
            pairingId,
            secret,
          );
          return reply
            .code(result.status === "paired" ? 200 : 202)
            .send(result);
        });
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
          [pairingId, tokenHash(secret)],
        );
        const pending = pairing.rows[0];
        if (!pending) {
          await connection.query("ROLLBACK");
          return reply
            .code(404)
            .send(
              apiError(
                "pairing_not_found",
                "Pairing request expired or was not found.",
              ),
            );
        }
        if (pending.consumed_at) {
          await connection.query("ROLLBACK");
          return reply
            .code(409)
            .send(
              apiError(
                "pairing_used",
                "Pairing request has already been used.",
              ),
            );
        }
        if (!pending.approved_at || !pending.user_id) {
          await connection.query("COMMIT");
          return reply.code(202).send({ status: "pending" });
        }
        const activeAccount = await connection.query(
          `SELECT id FROM users
         WHERE id = $1 AND suspended_at IS NULL
         FOR UPDATE`,
          [pending.user_id],
        );
        if (!activeAccount.rows[0]) {
          await connection.query("ROLLBACK");
          return reply
            .code(404)
            .send(
              apiError(
                "pairing_not_found",
                "Pairing request expired or was not found.",
              ),
            );
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
          [pairingId, tokenHash(secret), pending.user_id],
        );
        if (!locked.rows[0]) {
          await connection.query("ROLLBACK");
          return reply
            .code(404)
            .send(
              apiError(
                "pairing_not_found",
                "Pairing request expired or was not found.",
              ),
            );
        }
        if (locked.rows[0].consumed_at) {
          await connection.query("ROLLBACK");
          return reply
            .code(409)
            .send(
              apiError(
                "pairing_used",
                "Pairing request has already been used.",
              ),
            );
        }
        const consumed = await connection.query(
          `UPDATE pairing_requests SET consumed_at = now()
         WHERE id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
          [pairingId],
        );
        if (!consumed.rows[0]) {
          await connection.query("ROLLBACK");
          return reply
            .code(409)
            .send(
              apiError(
                "pairing_used",
                "Pairing request has already been used.",
              ),
            );
        }
        const token = randomToken("con");
        const connector = await connection.query<{ id: string; name: string }>(
          `INSERT INTO connectors (id, user_id, name, token_hash)
         VALUES ($1, $2, $3, $4) RETURNING id, name`,
          [
            randomUUID(),
            pending.user_id,
            locked.rows[0].connector_name,
            tokenHash(token),
          ],
        );
        await audit(
          connection,
          pending.user_id,
          "connector.created",
          connector.rows[0].id,
          {
            name: locked.rows[0].connector_name,
            pairing_id: pairingId,
          },
        );
        await connection.query("COMMIT");
        return {
          status: "paired",
          account_id: pending.user_id,
          connector: connector.rows[0],
          token,
        };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    },
  );
}
