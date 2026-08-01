import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SyncError } from "@mdbase-dev/connect-sync";
import type { DatabasePool } from "../../database-types.js";
import type { HostedAuthorityRegistry } from "../../hosted.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { randomToken, tokenHash } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { authorityUrl } from "../../platform/authority-url.js";
import { apiError } from "../../platform/http-errors.js";
import {
  bearerToken,
  requireUser
} from "../../platform/request-authentication.js";

interface MirrorPairingRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReference?: HostedAuthorityRegistry;
}

export function registerMirrorPairingRoutes(
  app: FastifyInstance,
  options: MirrorPairingRoutesOptions
): void {
  app.post("/v1/mirror-pairing-requests", async (request, reply) => {
    const input = z.object({
      mirror_name: z.string().trim().min(1).max(200),
      mode: z.enum(["read_only", "read_write"]),
      collection_id: z.uuid().optional()
    }).strict().parse(request.body);
    const id = randomUUID();
    const secret = randomToken("mir");
    await options.db.query(
      `INSERT INTO mirror_pairing_requests
         (id, secret_hash, mirror_name, mode, collection_hint, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
      [
        id,
        tokenHash(secret),
        input.mirror_name,
        input.mode,
        input.collection_id ?? null
      ]
    );
    return reply.code(201).send({
      pairing_id: id,
      pairing_secret: secret,
      verification_uri: `${options.publicUrl}/mirror/${id}`,
      expires_in: 600
    });
  });

  app.get("/v1/mirror-pairing-requests/:pairingId", async (request, reply) => {
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
      mirror_name: string;
      mode: "read_only" | "read_write";
      collection_hint: string | null;
      collection_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
      user_id: string | null;
    }>(
      `SELECT id, mirror_name, mode, collection_hint, collection_id,
              approved_at, consumed_at, user_id
       FROM mirror_pairing_requests
       WHERE id = $1 AND revoked_at IS NULL
         AND (expires_at > now() OR approved_at IS NOT NULL)`,
      [pairingId]
    );
    const pending = pairing.rows[0];
    if (!pending || (pending.user_id && pending.user_id !== user.id)) {
      return reply.code(404).send(apiError(
        "mirror_pairing_not_found",
        "Mirror approval expired or was not found."
      ));
    }
    const collections = await options.db.query<{
      id: string;
      display_name: string;
    }>(
      `SELECT id, display_name FROM hosted_collections
       WHERE user_id = $1 AND authority_state = 'active'
       ORDER BY display_name`,
      [user.id]
    );
    const { user_id: _userId, ...publicPairing } = pending;
    return { pairing: publicPairing, collections: collections.rows };
  });

  app.post(
    "/v1/mirror-pairing-requests/:pairingId/approve",
    async (request, reply) => {
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
      const input = z.object({
        collection_id: z.uuid()
      }).strict().parse(request.body);
      const approved = await options.db.query<{
        id: string;
        mirror_name: string;
        mode: "read_only" | "read_write";
      }>(
        `UPDATE mirror_pairing_requests
         SET user_id = $2, collection_id = $3, approved_at = now()
         WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL
           AND revoked_at IS NULL AND expires_at > now()
           AND EXISTS (
             SELECT 1 FROM hosted_collections
             WHERE id = $3 AND user_id = $2 AND authority_state = 'active'
           )
         RETURNING id, mirror_name, mode`,
        [pairingId, user.id, input.collection_id]
      );
      if (!approved.rows[0]) {
        return reply.code(404).send(apiError(
          "mirror_pairing_not_found",
          "Mirror approval expired, was already used, or the collection was not found."
        ));
      }
      await audit(
        options.db,
        user.id,
        "hosted_replica.pairing_approved",
        pairingId,
        {
          collection_id: input.collection_id,
          mode: approved.rows[0].mode
        }
      );
      return { ok: true };
    }
  );

  app.post(
    "/v1/mirror-pairing-requests/:pairingId/exchange",
    async (request, reply) => {
      const { pairingId } = z.object({
        pairingId: z.uuid()
      }).parse(request.params);
      const secret = bearerToken(request);
      if (!secret) {
        return reply.code(401).send(apiError(
          "invalid_mirror_pairing",
          "Mirror pairing secret required."
        ));
      }
      const pairing = await options.db.query<{
        mirror_name: string;
        mode: "read_only" | "read_write";
        user_id: string | null;
        collection_id: string | null;
        replica_id: string | null;
        approved_at: string | null;
        consumed_at: string | null;
      }>(
        `SELECT pairing.mirror_name, pairing.mode, pairing.user_id,
                pairing.collection_id, pairing.replica_id,
                pairing.approved_at, pairing.consumed_at
         FROM mirror_pairing_requests pairing
         LEFT JOIN users account ON account.id = pairing.user_id
         WHERE pairing.id = $1 AND pairing.secret_hash = $2
           AND pairing.revoked_at IS NULL
           AND (pairing.expires_at > now() OR pairing.consumed_at IS NOT NULL)
           AND (pairing.user_id IS NULL OR account.suspended_at IS NULL)`,
        [pairingId, tokenHash(secret)]
      );
      const pending = pairing.rows[0];
      if (!pending) {
        return reply.code(404).send(apiError(
          "mirror_pairing_not_found",
          "Mirror approval expired or was not found."
        ));
      }
      if (!pending.approved_at || !pending.user_id || !pending.collection_id) {
        return reply.code(202).send({ status: "pending" });
      }
      if (pending.consumed_at && pending.replica_id) {
        return rotateMirrorPairingToken(options, pairingId, secret);
      }

      const replicaId = randomUUID();
      const token = randomToken("hsr");
      const tokenExpiresAt = replicaTokenExpiry();
      let registered = false;
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const locked = await connection.query<{
          mirror_name: string;
          mode: "read_only" | "read_write";
          user_id: string;
          collection_id: string;
          replica_id: string | null;
          consumed_at: string | null;
        }>(
          `SELECT pairing.mirror_name, pairing.mode, pairing.user_id,
                  pairing.collection_id, pairing.replica_id,
                  pairing.consumed_at
           FROM mirror_pairing_requests pairing
           JOIN users account ON account.id = pairing.user_id
           WHERE pairing.id = $1 AND pairing.secret_hash = $2
             AND pairing.approved_at IS NOT NULL
             AND pairing.revoked_at IS NULL
             AND account.suspended_at IS NULL
           FOR UPDATE`,
          [pairingId, tokenHash(secret)]
        );
        const current = locked.rows[0];
        if (!current) {
          await connection.query("ROLLBACK");
          return reply.code(404).send(apiError(
            "mirror_pairing_not_found",
            "Mirror approval was not found."
          ));
        }
        if (current.consumed_at && current.replica_id) {
          await connection.query("COMMIT");
          return rotateMirrorPairingToken(options, pairingId, secret);
        }
        if (options.hostedProvider) {
          await options.hostedProvider.registerReplica(current.collection_id, {
            id: replicaId,
            name: current.mirror_name,
            mode: current.mode,
            allowedTypes: [],
            token
          });
        } else {
          await options.hostedReference!.registerReplica(
            current.collection_id,
            {
              id: replicaId,
              name: current.mirror_name,
              mode: current.mode,
              allowedTypes: []
            }
          );
        }
        registered = true;
        await connection.query(
          `INSERT INTO hosted_replicas
             (id, collection_id, authorized_user_id, name, mode, allowed_types,
              token_hash)
           VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6)`,
          [
            replicaId,
            current.collection_id,
            current.user_id,
            current.mirror_name,
            current.mode,
            options.hostedProvider ? null : tokenHash(token)
          ]
        );
        await connection.query(
          `UPDATE mirror_pairing_requests
           SET replica_id = $2, consumed_at = now()
           WHERE id = $1`,
          [pairingId, replicaId]
        );
        await audit(
          connection,
          current.user_id,
          "hosted_replica.created",
          replicaId,
          {
            collection_id: current.collection_id,
            mode: current.mode,
            source: "browser_pairing"
          }
        );
        await connection.query("COMMIT");
        return pairedResponse(options, {
          id: replicaId,
          collection_id: current.collection_id,
          name: current.mirror_name,
          mode: current.mode
        }, token, tokenExpiresAt);
      } catch (error) {
        await connection.query("ROLLBACK");
        if (registered) {
          if (options.hostedProvider) {
            await options.hostedProvider
              .revokeReplica(replicaId)
              .catch(() => undefined);
          } else {
            await options.hostedReference!
              .revokeReplica(pending.collection_id, replicaId)
              .catch(() => undefined);
          }
        }
        throw error;
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    "/v1/mirror-pairing-requests/:pairingId/renew",
    async (request, reply) => {
      const { pairingId } = z.object({
        pairingId: z.uuid()
      }).parse(request.params);
      const secret = bearerToken(request);
      if (!secret) {
        return reply.code(401).send(apiError(
          "invalid_mirror_pairing",
          "Mirror refresh credential required."
        ));
      }
      try {
        return await rotateMirrorPairingToken(options, pairingId, secret);
      } catch (error) {
        if (error instanceof SyncError && error.code === "replica_revoked") {
          return reply.code(404).send(apiError(
            "mirror_pairing_not_found",
            "This device can no longer renew mirror access."
          ));
        }
        throw error;
      }
    }
  );
}

async function rotateMirrorPairingToken(
  options: MirrorPairingRoutesOptions,
  pairingId: string,
  secret: string
) {
  const connection = await options.db.connect();
  try {
    await connection.query("BEGIN");
    const active = await connection.query<{
      id: string;
      collection_id: string;
      name: string;
      mode: "read_only" | "read_write";
    }>(
      `SELECT replica.id, replica.collection_id, replica.name, replica.mode
       FROM mirror_pairing_requests pairing
       JOIN users account ON account.id = pairing.user_id
       JOIN hosted_replicas replica ON replica.id = pairing.replica_id
       WHERE pairing.id = $1 AND pairing.secret_hash = $2
         AND pairing.consumed_at IS NOT NULL
         AND pairing.revoked_at IS NULL
         AND account.suspended_at IS NULL
         AND replica.collection_id = pairing.collection_id
         AND replica.purpose = 'mirror'
         AND replica.revoked_at IS NULL
       FOR UPDATE`,
      [pairingId, tokenHash(secret)]
    );
    const replica = active.rows[0];
    if (!replica) {
      throw new SyncError("replica_revoked", "This mirror has been revoked.");
    }
    const token = randomToken("hsr");
    if (options.hostedProvider) {
      await options.hostedProvider.rotateReplicaToken(replica.id, token);
    } else {
      await connection.query(
        `UPDATE hosted_replicas SET token_hash = $2
         WHERE id = $1 AND revoked_at IS NULL`,
        [replica.id, tokenHash(token)]
      );
      if (!options.hostedReference) {
        throw new Error("Hosted reference authority is unavailable.");
      }
    }
    await connection.query("COMMIT");
    return pairedResponse(
      options,
      replica,
      token,
      replicaTokenExpiry()
    );
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function pairedResponse(
  options: MirrorPairingRoutesOptions,
  replica: {
    id: string;
    collection_id: string;
    name: string;
    mode: "read_only" | "read_write";
  },
  token: string,
  tokenExpiresAt: string
) {
  return {
    status: "paired" as const,
    replica,
    token,
    token_expires_at: tokenExpiresAt,
    sync_url: authorityUrl(
      options.hostedProvider?.url ?? options.publicUrl,
      replica.collection_id,
      "sync"
    )
  };
}

function replicaTokenExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
}
