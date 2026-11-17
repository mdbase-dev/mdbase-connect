import { lockMirrorForRenewal } from "../hosted/hosted-mirror-policy.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SyncError } from "@mdbase-dev/connect-sync";
import type { DatabasePool } from "../../database-types.js";
import type { HostedAuthorityRegistry } from "../hosted/hosted.js";
import type { HostedProviderClient } from "../hosted/hosted-provider.js";
import { randomToken, tokenHash } from "../../security.js";
import { authorityUrl } from "../../platform/authority-url.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";

interface MirrorRenewalRouteOptions {
  db: DatabasePool;
  publicUrl: string;
  hostedProvider?: HostedProviderClient;
  hostedReference?: HostedAuthorityRegistry;
}

/**
 * Renews the access token of a synced folder that was paired in the browser.
 *
 * Pairing itself was removed, so no new folder can reach this route. It stays
 * for folders that already exist: Obsidian plugin releases 0.4.2 and earlier
 * and the deprecated `mdbase-mirror` CLI call it unattended before the
 * provider's 30-day token expiry, and have no other way to keep syncing. It
 * goes when the legacy hosted provider is switched off.
 */
export function registerMirrorRenewalRoute(
  app: FastifyInstance,
  options: MirrorRenewalRouteOptions
): void {
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
  options: MirrorRenewalRouteOptions,
  pairingId: string,
  secret: string
) {
  const connection = await options.db.connect();
  try {
    await connection.query("BEGIN");
    const located = await connection.query<{replica_id: string; user_id: string}>(
      `SELECT replica_id, user_id FROM mirror_pairing_requests
       WHERE id = $1 AND secret_hash = $2 AND consumed_at IS NOT NULL AND revoked_at IS NULL`,
      [pairingId, tokenHash(secret)]);
    const pairing = located.rows[0];
    if (!pairing) throw new SyncError("replica_revoked", "This mirror has been revoked.");
    const replica = await lockMirrorForRenewal(connection, pairing.user_id, pairing.replica_id);
    const active = await connection.query(
      `SELECT id FROM mirror_pairing_requests WHERE id = $1 AND secret_hash = $2
       AND replica_id = $3 AND user_id = $4 AND collection_id = $5
       AND consumed_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`,
      [pairingId, tokenHash(secret), replica.id, pairing.user_id, replica.collection_id]);
    if (!active.rows[0]) throw new SyncError("replica_revoked", "This mirror has been revoked.");
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
    return {
      status: "paired" as const,
      replica,
      token,
      token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      sync_url: authorityUrl(
        options.hostedProvider?.url ?? options.publicUrl,
        replica.collection_id,
        "sync"
      )
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
