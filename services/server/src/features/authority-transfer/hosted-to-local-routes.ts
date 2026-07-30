import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveHostedCollectionAccess } from "../../collection-access.js";
import type { DatabasePool } from "../../database-types.js";
import type { HostedAuthorityRegistry } from "../../hosted.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import {
  authenticatedUser,
  bearerToken,
  requireUser
} from "../../platform/request-authentication.js";
import {
  authorityPairing,
  authorityTransferResponse,
  authorityTransferView,
  mirrorAuthorityTransfer,
  recoverExpiredAuthorityTransfers,
  retireAuthorityCandidates,
  type AuthorityTransferDetails,
  type AuthorityTransferRow
} from "./lifecycle.js";

interface HostedToLocalRoutesOptions {
  db: DatabasePool;
  publicUrl: string;
  tailscaleAuth?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReference?: HostedAuthorityRegistry;
  relay: RelayHub;
}

export function registerHostedToLocalTransferRoutes(
  app: FastifyInstance,
  options: HostedToLocalRoutesOptions
): void {
  app.post(
    "/v1/mirror-pairing-requests/:pairingId/authority-transfers",
    async (request, reply) => {
      const { pairingId } = z.object({
        pairingId: z.uuid()
      }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      await recoverExpiredAuthorityTransfers(
        options.db,
        options.hostedProvider,
        options.hostedReference
      );
      const secret = bearerToken(request);
      if (!secret) {
        return reply.code(401).send(apiError(
          "invalid_mirror_pairing",
          "Mirror refresh credential required."
        ));
      }
      const pairing = await authorityPairing(options.db, pairingId, secret);
      if (!pairing) {
        return reply.code(404).send(apiError(
          "mirror_pairing_not_found",
          "This device can no longer move collection authority."
        ));
      }
      if (pairing.mode !== "read_write" || pairing.allowed_types.length > 0) {
        return reply.code(409).send(apiError(
          "promotion_mirror_ineligible",
          "Authority can move only to an active, two-way, full collection mirror."
        ));
      }
      const existing = await options.db.query<AuthorityTransferRow>(
        `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                local_collection_id, state, final_head,
                next_authority_epoch, manifest_digest, expires_at
         FROM authority_transfers
         WHERE pairing_id = $1
           AND state IN ('requested', 'approved', 'prepared')
         ORDER BY created_at DESC LIMIT 1`,
        [pairingId]
      );
      if (existing.rows[0]) {
        return reply.code(200).send(authorityTransferResponse(
          existing.rows[0],
          options.publicUrl
        ));
      }
      if (pairing.authority_state !== "active") {
        return reply.code(409).send(apiError(
          "authority_transfer_unavailable",
          "This hosted collection is not available for authority transfer."
        ));
      }
      const transferId = randomUUID();
      const transfer = await options.db.query<AuthorityTransferRow>(
        `INSERT INTO authority_transfers
           (id, user_id, hosted_collection_id, pairing_id, replica_id,
            expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes')
         RETURNING id, user_id, hosted_collection_id, pairing_id, replica_id,
                   local_collection_id, state, final_head,
                   next_authority_epoch, manifest_digest, expires_at`,
        [
          transferId,
          pairing.user_id,
          pairing.collection_id,
          pairingId,
          pairing.replica_id
        ]
      );
      await audit(
        options.db,
        pairing.user_id,
        "authority_transfer.requested",
        transferId,
        {
          collection_id: pairing.collection_id,
          replica_id: pairing.replica_id
        }
      );
      return reply.code(201).send(authorityTransferResponse(
        transfer.rows[0],
        options.publicUrl
      ));
    }
  );

  app.get("/v1/authority-transfers/:transferId", async (request, reply) => {
    const user = await requireUser(
      request,
      reply,
      options.db,
      options.tailscaleAuth
    );
    if (!user) return;
    const { transferId } = z.object({
      transferId: z.uuid()
    }).parse(request.params);
    await recoverExpiredAuthorityTransfers(
      options.db,
      options.hostedProvider,
      options.hostedReference
    );
    const transfer = await options.db.query<AuthorityTransferDetails>(
      `SELECT transfer.id, transfer.user_id,
              transfer.hosted_collection_id, transfer.pairing_id,
              transfer.replica_id, transfer.local_collection_id,
              transfer.state, transfer.final_head,
              transfer.next_authority_epoch, transfer.manifest_digest,
              transfer.expires_at, hosted.display_name AS collection_name,
              replica.name AS mirror_name
       FROM authority_transfers transfer
       JOIN hosted_collections hosted
         ON hosted.id = transfer.hosted_collection_id
       JOIN hosted_replicas replica ON replica.id = transfer.replica_id
       WHERE transfer.id = $1 AND transfer.user_id = $2`,
      [transferId, user.id]
    );
    if (!transfer.rows[0]) {
      return reply.code(404).send(apiError(
        "authority_transfer_not_found",
        "Authority transfer was not found."
      ));
    }
    return {
      transfer: authorityTransferView(
        transfer.rows[0],
        options.publicUrl
      )
    };
  });

  app.post(
    "/v1/authority-transfers/:transferId/approve",
    async (request, reply) => {
      const user = await requireUser(
        request,
        reply,
        options.db,
        options.tailscaleAuth
      );
      if (!user) return;
      const { transferId } = z.object({
        transferId: z.uuid()
      }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      await recoverExpiredAuthorityTransfers(
        options.db,
        options.hostedProvider,
        options.hostedReference
      );
      const candidate = await options.db.query<{
        hosted_collection_id: string;
      }>(
        `SELECT hosted_collection_id FROM authority_transfers
         WHERE id = $1 AND user_id = $2`,
        [transferId, user.id]
      );
      const transferAccess = candidate.rows[0]
        ? await resolveHostedCollectionAccess(
            options.db,
            user.id,
            candidate.rows[0].hosted_collection_id
          )
        : null;
      if (!transferAccess?.actions.has("authority.transfer")) {
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found."
        ));
      }
      const approved = await options.db.query<AuthorityTransferRow>(
        `UPDATE authority_transfers
         SET state = 'approved', approved_at = now()
         WHERE id = $1 AND user_id = $2 AND state = 'requested'
           AND expires_at > now()
         RETURNING id, user_id, hosted_collection_id, pairing_id, replica_id,
                   local_collection_id, state, final_head,
                   next_authority_epoch, manifest_digest, expires_at`,
        [transferId, user.id]
      );
      if (!approved.rows[0]) {
        const existing = await options.db.query<AuthorityTransferRow>(
          `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                  local_collection_id, state, final_head,
                  next_authority_epoch, manifest_digest, expires_at
           FROM authority_transfers
           WHERE id = $1 AND user_id = $2`,
          [transferId, user.id]
        );
        if (
          existing.rows[0]?.state === "approved"
          || existing.rows[0]?.state === "prepared"
        ) {
          return {
            transfer: authorityTransferView(
              existing.rows[0],
              options.publicUrl
            )
          };
        }
        return reply.code(409).send(apiError(
          "authority_transfer_inactive",
          "Authority transfer expired or is no longer awaiting approval."
        ));
      }
      await audit(
        options.db,
        user.id,
        "authority_transfer.approved",
        transferId,
        { collection_id: approved.rows[0].hosted_collection_id }
      );
      return {
        transfer: authorityTransferView(
          approved.rows[0],
          options.publicUrl
        )
      };
    }
  );

  app.post(
    "/v1/authority-transfers/:transferId/prepare",
    async (request, reply) => {
      const { transferId } = z.object({
        transferId: z.uuid()
      }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      await recoverExpiredAuthorityTransfers(
        options.db,
        options.hostedProvider,
        options.hostedReference
      );
      const transfer = await mirrorAuthorityTransfer(
        options.db,
        transferId,
        bearerToken(request)
      );
      if (!transfer) {
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found for this mirror."
        ));
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const locked = await connection.query<AuthorityTransferRow>(
          `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                  local_collection_id, state, final_head,
                  next_authority_epoch, manifest_digest, expires_at
           FROM authority_transfers WHERE id = $1 FOR UPDATE`,
          [transferId]
        );
        const current = locked.rows[0];
        if (!current || current.pairing_id !== transfer.pairing_id) {
          await connection.query("ROLLBACK");
          return reply.code(404).send(apiError(
            "authority_transfer_not_found",
            "Authority transfer was not found for this mirror."
          ));
        }
        if (current.state === "requested") {
          await connection.query("COMMIT");
          return reply.code(202).send({ status: "pending" });
        }
        if (current.state === "prepared") {
          await connection.query("COMMIT");
          return {
            transfer: authorityTransferView(
              current,
              options.publicUrl
            )
          };
        }
        if (current.state !== "approved") {
          await connection.query("ROLLBACK");
          return reply.code(409).send(apiError(
            "authority_transfer_inactive",
            "Authority transfer is no longer active."
          ));
        }
        const prepared = options.hostedProvider
          ? await options.hostedProvider.prepareAuthorityTransfer(
              current.hosted_collection_id,
              {
                transferId,
                replicaId: current.replica_id,
                ttlSeconds: 900
              }
            )
          : await options.hostedReference!.prepareAuthorityTransfer(
              current.hosted_collection_id,
              {
                transferId,
                replicaId: current.replica_id,
                ttlSeconds: 900
              }
            );
        const saved = await connection.query<AuthorityTransferRow>(
          `UPDATE authority_transfers
           SET state = 'prepared', final_head = $2,
               next_authority_epoch = $3, manifest_digest = $4,
               expires_at = $5, prepared_at = now()
           WHERE id = $1 AND state = 'approved'
           RETURNING id, user_id, hosted_collection_id, pairing_id,
                     replica_id, local_collection_id, state, final_head,
                     next_authority_epoch, manifest_digest, expires_at`,
          [
            transferId,
            prepared.final_head,
            prepared.authority_epoch,
            prepared.manifest_digest,
            prepared.expires_at
          ]
        );
        await connection.query(
          `UPDATE hosted_collections
           SET authority_state = 'transferring'
           WHERE id = $1 AND authority_state = 'active'`,
          [current.hosted_collection_id]
        );
        await audit(
          connection,
          current.user_id,
          "authority_transfer.prepared",
          transferId,
          {
            collection_id: current.hosted_collection_id,
            final_head: prepared.final_head,
            authority_epoch: prepared.authority_epoch
          }
        );
        await connection.query("COMMIT");
        return {
          transfer: authorityTransferView(
            saved.rows[0],
            options.publicUrl
          )
        };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
  );

  app.post(
    "/v1/authority-transfers/:transferId/complete",
    async (request, reply) => {
      const { transferId } = z.object({
        transferId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        manifest_digest: z.string().regex(/^[a-f0-9]{64}$/)
      }).strict().parse(request.body);
      const transfer = await mirrorAuthorityTransfer(
        options.db,
        transferId,
        bearerToken(request)
      );
      if (!transfer) {
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found for this mirror."
        ));
      }
      if (transfer.state === "completed" && transfer.local_collection_id) {
        return completedResponse(
          transfer.hosted_collection_id,
          transfer.local_collection_id,
          Number(transfer.next_authority_epoch)
        );
      }
      if (transfer.state !== "prepared") {
        return reply.code(409).send(apiError(
          "authority_transfer_inactive",
          "Authority transfer is not prepared."
        ));
      }
      const candidates = await options.db.query<{
        id: string;
        connector_id: string;
      }>(
        `SELECT collection.id, collection.connector_id
         FROM collections collection
         JOIN connectors connector
           ON connector.id = collection.connector_id
         WHERE connector.user_id = $1
           AND connector.revoked_at IS NULL
           AND collection.local_id = $2
           AND collection.authority_state = 'candidate'
         ORDER BY collection.last_seen_at DESC`,
        [transfer.user_id, transfer.hosted_collection_id]
      );
      if (candidates.rows.length === 0) {
        return reply.code(202).send({
          status: "waiting_for_connector",
          message:
            "The local connector has not registered the promoted collection yet."
        });
      }
      if (candidates.rows.length > 1) {
        return reply.code(409).send(apiError(
          "authority_target_ambiguous",
          "More than one computer registered this promoted collection."
        ));
      }
      const candidate = candidates.rows[0];
      const completed = options.hostedProvider
        ? await options.hostedProvider.completeAuthorityTransfer(
            transferId,
            input.manifest_digest
          )
        : await options.hostedReference!.completeAuthorityTransfer(
            transferId,
            input.manifest_digest
          );
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const locked = await connection.query<AuthorityTransferRow>(
          `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                  local_collection_id, state, final_head,
                  next_authority_epoch, manifest_digest, expires_at
           FROM authority_transfers WHERE id = $1 FOR UPDATE`,
          [transferId]
        );
        if (
          locked.rows[0]?.state === "completed"
          && locked.rows[0].local_collection_id
        ) {
          await connection.query("COMMIT");
          return completedResponse(
            transfer.hosted_collection_id,
            locked.rows[0].local_collection_id,
            Number(locked.rows[0].next_authority_epoch)
          );
        }
        await connection.query(
          `UPDATE collections
           SET authority_state = 'active', authority_epoch = $2,
               enabled = true, last_seen_at = now()
           WHERE id = $1 AND authority_state = 'candidate'`,
          [candidate.id, completed.authority_epoch]
        );
        await connection.query(
          `UPDATE hosted_collections
           SET authority_state = 'transferred', authority_epoch = $2,
               transferred_collection_id = $3
           WHERE id = $1`,
          [
            transfer.hosted_collection_id,
            completed.authority_epoch,
            candidate.id
          ]
        );
        const grants = await connection.query<{ id: string }>(
          "SELECT id FROM grants WHERE hosted_collection_id = $1",
          [transfer.hosted_collection_id]
        );
        await connection.query(
          `UPDATE access_tokens
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE grant_id IN (
             SELECT id FROM grants WHERE hosted_collection_id = $1
           )`,
          [transfer.hosted_collection_id]
        );
        await connection.query(
          `UPDATE refresh_tokens
           SET revoked_at = COALESCE(revoked_at, now())
           WHERE grant_id IN (
             SELECT id FROM grants WHERE hosted_collection_id = $1
           )`,
          [transfer.hosted_collection_id]
        );
        await connection.query(
          `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
           WHERE hosted_collection_id = $1`,
          [transfer.hosted_collection_id]
        );
        await connection.query(
          `UPDATE hosted_replicas
           SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
           WHERE collection_id = $1`,
          [transfer.hosted_collection_id]
        );
        await connection.query(
          `UPDATE authority_transfers
           SET state = 'completed', local_collection_id = $2,
               next_authority_epoch = $3, completed_at = now()
           WHERE id = $1`,
          [transferId, candidate.id, completed.authority_epoch]
        );
        await audit(
          connection,
          transfer.user_id,
          "authority_transfer.completed",
          transferId,
          {
            collection_id: transfer.hosted_collection_id,
            local_collection_id: candidate.id,
            connector_id: candidate.connector_id,
            authority_epoch: completed.authority_epoch,
            revoked_grants: grants.rows.length
          }
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
      await options.relay.pushPolicy(candidate.connector_id);
      return completedResponse(
        transfer.hosted_collection_id,
        candidate.id,
        completed.authority_epoch
      );
    }
  );

  app.delete(
    "/v1/authority-transfers/:transferId",
    async (request, reply) => {
      const { transferId } = z.object({
        transferId: z.uuid()
      }).parse(request.params);
      const user = await authenticatedUser(
        request,
        options.db,
        options.tailscaleAuth
      );
      const transfer = user
        ? (await options.db.query<AuthorityTransferRow>(
            `SELECT id, user_id, hosted_collection_id, pairing_id,
                    replica_id, local_collection_id, state, final_head,
                    next_authority_epoch, manifest_digest, expires_at
             FROM authority_transfers
             WHERE id = $1 AND user_id = $2`,
            [transferId, user.id]
          )).rows[0]
        : await mirrorAuthorityTransfer(
            options.db,
            transferId,
            bearerToken(request)
          );
      if (!transfer) {
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found."
        ));
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const locked = await connection.query<AuthorityTransferRow>(
          `SELECT id, user_id, hosted_collection_id, pairing_id, replica_id,
                  local_collection_id, state, final_head,
                  next_authority_epoch, manifest_digest, expires_at
           FROM authority_transfers WHERE id = $1 FOR UPDATE`,
          [transferId]
        );
        const current = locked.rows[0];
        if (!current || current.user_id !== transfer.user_id) {
          await connection.query("ROLLBACK");
          return reply.code(404).send(apiError(
            "authority_transfer_not_found",
            "Authority transfer was not found."
          ));
        }
        if (current.state === "completed") {
          await connection.query("ROLLBACK");
          return reply.code(409).send(apiError(
            "authority_transfer_completed",
            "Completed authority transfer cannot be cancelled."
          ));
        }
        if (current.state === "prepared") {
          if (options.hostedProvider) {
            await options.hostedProvider.abortAuthorityTransfer(transferId);
          } else {
            await options.hostedReference!.abortAuthorityTransfer(transferId);
          }
        }
        await connection.query(
          `UPDATE authority_transfers
           SET state = 'cancelled', cancelled_at = now()
           WHERE id = $1 AND state <> 'completed'`,
          [transferId]
        );
        await connection.query(
          `UPDATE hosted_collections SET authority_state = 'active'
           WHERE id = $1 AND authority_state = 'transferring'`,
          [current.hosted_collection_id]
        );
        await retireAuthorityCandidates(
          connection,
          current.user_id,
          current.hosted_collection_id
        );
        await audit(
          connection,
          current.user_id,
          "authority_transfer.cancelled",
          transferId,
          { collection_id: current.hosted_collection_id }
        );
        await connection.query("COMMIT");
        return { ok: true };
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
  );
}

function completedResponse(
  collectionId: string,
  localCollectionId: string,
  authorityEpoch: number
) {
  return {
    status: "completed" as const,
    collection_id: collectionId,
    local_collection_id: localCollectionId,
    authority_epoch: authorityEpoch
  };
}
