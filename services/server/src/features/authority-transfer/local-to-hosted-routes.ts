import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import { reconcileHostedAccount } from "../../entitlements.js";
import type { HostedAuthorityRegistry } from "../../hosted.js";
import {
  HostedProviderResponseError,
  type HostedProviderClient
} from "../../hosted-provider.js";
import type { RelayHub } from "../../relay.js";
import { randomToken } from "../../security.js";
import { audit } from "../../platform/audit-events.js";
import { authorityImportCapability } from "../../platform/authority-url.js";
import {
  apiError,
  RequestValidationError
} from "../../platform/http-errors.js";
import {
  requireConnector,
  type ConnectorIdentity
} from "../../platform/request-authentication.js";
import {
  authorityImportTransferView,
  recoverExpiredAuthorityTransfers,
  type AuthorityImportTransferRow
} from "./lifecycle.js";

interface LocalToHostedRoutesOptions {
  db: DatabasePool;
  hostedCollections?: boolean;
  hostedProvider?: HostedProviderClient;
  hostedReference?: HostedAuthorityRegistry;
  relay: RelayHub;
}

export function registerLocalToHostedTransferRoutes(
  app: FastifyInstance,
  options: LocalToHostedRoutesOptions
): void {
  app.post(
    "/v1/connectors/collections/:collectionId/authority-transfers",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      const { collectionId } = z.object({
        collectionId: z.uuid()
      }).parse(request.params);
      z.object({}).strict().parse(request.body ?? {});
      if (!options.hostedCollections || !options.hostedProvider) {
        return remoteAuthorityUnavailable(reply);
      }
      await recoverExpiredAuthorityTransfers(
        options.db,
        options.hostedProvider,
        options.hostedReference
      );
      const source = await options.db.query<{
        id: string;
        local_id: string;
        display_name: string;
        authority_epoch: string | number;
        contracts: CollectionContractDescriptor[];
        authority_state: "active" | "retired";
        enabled: boolean;
        reported_enabled: boolean;
      }>(
        `SELECT id, local_id, display_name, authority_epoch, contracts,
                authority_state, enabled, reported_enabled
         FROM collections
         WHERE connector_id = $1 AND user_id = $2 AND local_id = $3
           AND authority_state IN ('active', 'retired')
           AND present = true`,
        [connector.id, connector.user_id, collectionId]
      );
      const local = source.rows[0];
      if (!local) {
        return reply.code(404).send(apiError(
          "authority_source_not_found",
          "The active local collection authority was not found."
        ));
      }
      const existing = await options.db.query<AuthorityImportTransferRow>(
        `SELECT id, user_id, hosted_collection_id, local_collection_id,
                state, final_head, next_authority_epoch, manifest_digest,
                source_revision, expires_at
         FROM authority_transfers
         WHERE local_collection_id = $1 AND direction = 'to_hosted'
           AND (
             (
               state IN ('requested', 'prepared', 'activating')
               AND next_authority_epoch = $2
             )
             OR (
               state = 'completed'
               AND next_authority_epoch = $3
             )
           )
         ORDER BY created_at DESC LIMIT 1`,
        [
          local.id,
          Number(local.authority_epoch) + 1,
          Number(local.authority_epoch)
        ]
      );
      if (
        existing.rows[0]?.state === "completed"
        && local.authority_state === "retired"
      ) {
        return {
          transfer: authorityImportTransferView(existing.rows[0])
        };
      }
      if (existing.rows[0]?.state === "activating") {
        return {
          transfer: authorityImportTransferView(existing.rows[0])
        };
      }
      if (
        local.authority_state !== "active"
        || !local.enabled
        || !local.reported_enabled
      ) {
        return reply.code(409).send(apiError(
          "authority_transfer_inactive",
          "The local collection is no longer an active authority."
        ));
      }
      let transfer = existing.rows[0];
      if (!transfer) {
        transfer = await createImportTransfer(
          options,
          options.hostedProvider,
          connector,
          local
        );
      }
      const transferId = transfer.id;
      const importToken = randomToken("ati");
      const account = await reconcileHostedAccount(
        options.db,
        options.hostedProvider,
        connector.user_id
      );
      const prepared = await options.hostedProvider.prepareAuthorityImport({
        transferId,
        accountId: account.providerAccountId,
        collectionId: local.local_id,
        displayName: local.display_name,
        token: importToken,
        authorityEpoch: Number(transfer.next_authority_epoch),
        ttlSeconds: 30 * 60
      });
      const refreshed = await options.db.query<AuthorityImportTransferRow>(
        `UPDATE authority_transfers
         SET state = 'prepared', expires_at = $2
         WHERE id = $1 AND state IN ('requested', 'prepared')
         RETURNING id, user_id, hosted_collection_id, local_collection_id,
                   state, final_head, next_authority_epoch, manifest_digest,
                   source_revision, expires_at`,
        [transferId, prepared.expires_at]
      );
      transfer = refreshed.rows[0];
      if (!transfer) {
        throw new RequestValidationError(
          "Authority transfer changed state while its import capability was prepared."
        );
      }
      return reply.code(existing.rows[0] ? 200 : 201).send({
        transfer: authorityImportTransferView(transfer),
        import: authorityImportCapability(
          options.hostedProvider.url,
          transferId,
          importToken
        )
      });
    }
  );

  app.post(
    "/v1/connectors/authority-transfers/:transferId/complete",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      if (!options.hostedProvider) {
        return remoteAuthorityUnavailable(reply);
      }
      const { transferId } = z.object({
        transferId: z.uuid()
      }).parse(request.params);
      const input = z.object({
        manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
        source_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        source_head: z.number().int().nonnegative()
      }).strict().parse(request.body);
      const transfer = await findConnectorImportTransfer(
        options.db,
        connector,
        transferId
      );
      if (!transfer) {
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found for this connector."
        ));
      }
      if (transfer.state === "completed") {
        return completedResponse(transfer);
      }
      if (
        !["prepared", "activating"].includes(transfer.state)
        || (
          transfer.state === "prepared"
          && new Date(transfer.expires_at).getTime() <= Date.now()
        )
      ) {
        return reply.code(409).send(apiError(
          "authority_transfer_inactive",
          "Authority transfer is no longer prepared."
        ));
      }
      if (
        transfer.state === "activating"
        && !matchesSnapshot(transfer, input)
      ) {
        return reply.code(409).send(apiError(
          "authority_transfer_snapshot_mismatch",
          "Authority activation must resume with the same fenced source snapshot."
        ));
      }
      if (transfer.state === "prepared") {
        await reserveActivation(
          options.db,
          connector,
          transfer,
          input
        );
      }
      let completed;
      try {
        completed = await options.hostedProvider.completeAuthorityImport(
          transferId,
          input.manifest_digest,
          input.source_revision
        );
      } catch (error) {
        if (
          error instanceof HostedProviderResponseError
          && error.code === "projection_activation_pending"
        ) {
          return reply.code(202).send({
            status: "activating",
            collection_id: transfer.hosted_collection_id,
            authority_epoch: Number(transfer.next_authority_epoch)
          });
        }
        throw error;
      }
      if (
        completed.id !== transferId
        || completed.collection_id !== transfer.hosted_collection_id
        || completed.state !== "completed"
        || completed.authority_epoch !== Number(transfer.next_authority_epoch)
        || completed.manifest_digest !== input.manifest_digest
        || completed.source_revision !== input.source_revision
        || completed.source_head !== input.source_head
      ) {
        throw new RequestValidationError(
          "The remote authority activated a different transfer snapshot."
        );
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const current = await connection.query<{ state: string }>(
          "SELECT state FROM authority_transfers WHERE id = $1 FOR UPDATE",
          [transferId]
        );
        if (current.rows[0]?.state === "completed") {
          await connection.query("COMMIT");
          return completedResponse(transfer);
        }
        if (current.rows[0]?.state !== "activating") {
          throw new RequestValidationError(
            "Authority transfer is not reserved for activation."
          );
        }
        const source = await connection.query<{
          authority_state: string;
          authority_epoch: string | number;
        }>(
          `SELECT authority_state, authority_epoch FROM collections
           WHERE id = $1 AND connector_id = $2 FOR UPDATE`,
          [transfer.local_collection_id, connector.id]
        );
        if (
          source.rows[0]?.authority_state !== "active"
          || Number(source.rows[0].authority_epoch) + 1
            !== completed.authority_epoch
        ) {
          throw new RequestValidationError(
            "The local authority epoch changed while the transfer was staged."
          );
        }
        const retired = await connection.query(
          `UPDATE collections
           SET authority_state = 'retired', enabled = false,
               authority_epoch = $2, last_seen_at = now()
           WHERE id = $1 AND authority_state = 'active'
             AND authority_epoch = $3`,
          [
            transfer.local_collection_id,
            completed.authority_epoch,
            completed.authority_epoch - 1
          ]
        );
        const activated = await connection.query(
          `UPDATE hosted_collections
           SET authority_state = 'active', authority_epoch = $2,
               transferred_collection_id = NULL
           WHERE id = $1 AND authority_state = 'importing'`,
          [transfer.hosted_collection_id, completed.authority_epoch]
        );
        if (retired.rowCount !== 1 || activated.rowCount !== 1) {
          throw new RequestValidationError(
            "Authority metadata changed while remote activation completed."
          );
        }
        const grants = await connection.query<{ id: string }>(
          `SELECT id FROM grants
           WHERE collection_id = $1 AND revoked_at IS NULL`,
          [transfer.local_collection_id]
        );
        for (const grant of grants.rows) {
          await connection.query(
            `UPDATE access_tokens
             SET revoked_at = COALESCE(revoked_at, now())
             WHERE grant_id = $1`,
            [grant.id]
          );
          await connection.query(
            `UPDATE refresh_tokens
             SET revoked_at = COALESCE(revoked_at, now())
             WHERE grant_id = $1`,
            [grant.id]
          );
        }
        await connection.query(
          `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
           WHERE collection_id = $1`,
          [transfer.local_collection_id]
        );
        const committed = await connection.query(
          `UPDATE authority_transfers
           SET state = 'completed', completed_at = now()
           WHERE id = $1 AND state = 'activating'`,
          [transferId]
        );
        if (committed.rowCount !== 1) {
          throw new RequestValidationError(
            "Authority transfer changed state while completion was committed."
          );
        }
        await audit(
          connection,
          connector.user_id,
          "authority_transfer.completed",
          transferId,
          {
            collection_id: transfer.hosted_collection_id,
            direction: "to_hosted",
            connector_id: connector.id,
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
      await options.relay.pushPolicy(connector.id);
      return {
        status: "completed",
        collection_id: transfer.hosted_collection_id,
        authority_epoch: completed.authority_epoch
      };
    }
  );

  app.delete(
    "/v1/connectors/authority-transfers/:transferId",
    async (request, reply) => {
      const connector = await requireConnector(request, reply, options.db);
      if (!connector) return;
      if (!options.hostedProvider) {
        return remoteAuthorityUnavailable(reply);
      }
      const { transferId } = z.object({
        transferId: z.uuid()
      }).parse(request.params);
      const transfer = await findConnectorImportTransfer(
        options.db,
        connector,
        transferId
      );
      if (!transfer) {
        return reply.code(404).send(apiError(
          "authority_transfer_not_found",
          "Authority transfer was not found for this connector."
        ));
      }
      if (transfer.state === "completed") {
        return reply.code(409).send(apiError(
          "authority_transfer_completed",
          "Completed authority transfer cannot be cancelled."
        ));
      }
      if (!["requested", "prepared"].includes(transfer.state)) {
        return reply.code(409).send(apiError(
          "authority_transfer_activation_started",
          "Authority activation has started and can no longer be cancelled."
        ));
      }
      try {
        await options.hostedProvider.abortAuthorityImport(transferId);
      } catch (error) {
        if (
          !(error instanceof HostedProviderResponseError)
          || error.code !== "authority_import_not_found"
        ) {
          throw error;
        }
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        const cancelled = await connection.query(
          `UPDATE authority_transfers SET state = 'cancelled'
           WHERE id = $1 AND state IN ('requested', 'prepared')`,
          [transferId]
        );
        if (cancelled.rowCount !== 1) {
          throw new RequestValidationError(
            "Authority transfer changed state while cancellation was committed."
          );
        }
        await audit(
          connection,
          connector.user_id,
          "authority_transfer.cancelled",
          transferId,
          {
            collection_id: transfer.hosted_collection_id,
            direction: "to_hosted"
          }
        );
        await connection.query(
          `UPDATE hosted_collections
           SET authority_state = 'transferred', authority_epoch = $2
           WHERE id = $1 AND authority_state = 'importing'
             AND transferred_collection_id IS NOT NULL`,
          [
            transfer.hosted_collection_id,
            Number(transfer.next_authority_epoch) - 1
          ]
        );
        await connection.query(
          `DELETE FROM hosted_collections
           WHERE id = $1 AND authority_state = 'importing'
             AND transferred_collection_id IS NULL`,
          [transfer.hosted_collection_id]
        );
        await connection.query("COMMIT");
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
      return { ok: true };
    }
  );
}

async function createImportTransfer(
  options: LocalToHostedRoutesOptions,
  hostedProvider: HostedProviderClient,
  connector: ConnectorIdentity,
  local: {
    id: string;
    local_id: string;
    display_name: string;
    authority_epoch: string | number;
    contracts: CollectionContractDescriptor[];
  }
): Promise<AuthorityImportTransferRow> {
  const transferId = randomUUID();
  const authorityEpoch = Number(local.authority_epoch) + 1;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1_000);
  const connection = await options.db.connect();
  try {
    await connection.query("BEGIN");
    const target = await connection.query<{ id: string }>(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url, contracts,
          authority_state, authority_epoch)
       VALUES ($1, $2, $3, 'mdbase', $4, $5::jsonb, 'importing', $6)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         provider_url = EXCLUDED.provider_url,
         contracts = EXCLUDED.contracts,
         authority_state = 'importing',
         authority_epoch = EXCLUDED.authority_epoch
       WHERE hosted_collections.user_id = EXCLUDED.user_id
         AND hosted_collections.authority_state = 'transferred'
       RETURNING id`,
      [
        local.local_id,
        connector.user_id,
        local.display_name,
        hostedProvider.url,
        JSON.stringify(local.contracts ?? []),
        authorityEpoch
      ]
    );
    if (!target.rows[0]) {
      throw new RequestValidationError(
        "The remote collection identity is already in use by an active authority."
      );
    }
    const inserted = await connection.query<AuthorityImportTransferRow>(
      `INSERT INTO authority_transfers
         (id, user_id, hosted_collection_id, local_collection_id, direction,
          state, next_authority_epoch, expires_at)
       VALUES ($1, $2, $3, $4, 'to_hosted', 'requested', $5, $6)
       RETURNING id, user_id, hosted_collection_id, local_collection_id,
                 state, final_head, next_authority_epoch, manifest_digest,
                 source_revision, expires_at`,
      [
        transferId,
        connector.user_id,
        local.local_id,
        local.id,
        authorityEpoch,
        expiresAt
      ]
    );
    await audit(
      connection,
      connector.user_id,
      "authority_transfer.requested",
      transferId,
      {
        collection_id: local.local_id,
        direction: "to_hosted",
        connector_id: connector.id,
        authority_epoch: authorityEpoch
      }
    );
    await connection.query("COMMIT");
    return inserted.rows[0];
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function findConnectorImportTransfer(
  db: DatabasePool,
  connector: ConnectorIdentity,
  transferId: string
): Promise<AuthorityImportTransferRow | null> {
  const found = await db.query<AuthorityImportTransferRow>(
    `SELECT transfer.id, transfer.user_id,
            transfer.hosted_collection_id, transfer.local_collection_id,
            transfer.state, transfer.final_head,
            transfer.next_authority_epoch, transfer.manifest_digest,
            transfer.source_revision, transfer.expires_at
     FROM authority_transfers transfer
     JOIN collections source ON source.id = transfer.local_collection_id
     WHERE transfer.id = $1 AND transfer.direction = 'to_hosted'
       AND source.connector_id = $2 AND transfer.user_id = $3`,
    [transferId, connector.id, connector.user_id]
  );
  return found.rows[0] ?? null;
}

async function reserveActivation(
  db: DatabasePool,
  connector: ConnectorIdentity,
  transfer: AuthorityImportTransferRow,
  input: {
    manifest_digest: string;
    source_revision: string;
    source_head: number;
  }
): Promise<void> {
  const preflight = await db.connect();
  try {
    await preflight.query("BEGIN");
    const source = await preflight.query<{
      authority_state: string;
      authority_epoch: string | number;
    }>(
      `SELECT authority_state, authority_epoch FROM collections
       WHERE id = $1 AND connector_id = $2 FOR UPDATE`,
      [transfer.local_collection_id, connector.id]
    );
    if (
      source.rows[0]?.authority_state !== "active"
      || Number(source.rows[0].authority_epoch) + 1
        !== Number(transfer.next_authority_epoch)
    ) {
      throw new RequestValidationError(
        "The local authority epoch changed while the transfer was staged."
      );
    }
    const reserved = await preflight.query(
      `UPDATE authority_transfers
       SET state = 'activating', manifest_digest = $2,
           source_revision = $3, final_head = $4
       WHERE id = $1 AND state = 'prepared'`,
      [
        transfer.id,
        input.manifest_digest,
        input.source_revision,
        input.source_head
      ]
    );
    if (reserved.rowCount !== 1) {
      throw new RequestValidationError(
        "Authority transfer changed state while activation was reserved."
      );
    }
    await preflight.query("COMMIT");
  } catch (error) {
    await preflight.query("ROLLBACK");
    throw error;
  } finally {
    preflight.release();
  }
}

function matchesSnapshot(
  transfer: AuthorityImportTransferRow,
  input: {
    manifest_digest: string;
    source_revision: string;
    source_head: number;
  }
): boolean {
  return transfer.manifest_digest === input.manifest_digest
    && transfer.source_revision === input.source_revision
    && Number(transfer.final_head) === input.source_head;
}

function completedResponse(transfer: AuthorityImportTransferRow) {
  return {
    status: "completed" as const,
    collection_id: transfer.hosted_collection_id,
    authority_epoch: Number(transfer.next_authority_epoch)
  };
}

function remoteAuthorityUnavailable(reply: {
  code(statusCode: number): {
    send(payload: unknown): unknown;
  };
}): unknown {
  return reply.code(404).send(apiError(
    "remote_authority_unavailable",
    "This Connect server has no remote collection authority."
  ));
}
