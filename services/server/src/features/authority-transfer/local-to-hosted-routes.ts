import { randomUUID } from "node:crypto";
import { requireAccountNotMigrationFrozen, requireHostedCollectionNotMigrationFrozen } from "../next/migration-topology.js";
import { recoverAccountImportCancellation } from "./account-cancellation.js";
import type { FastifyInstance } from "fastify";
import type { CollectionContractDescriptor } from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
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
  finishAuthorityImportAbort,
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

interface LocalAuthoritySource {
  id: string;
  local_id: string;
  display_name: string;
  authority_epoch: string | number;
  contracts: CollectionContractDescriptor[];
  authority_state: "active" | "candidate" | "retired";
  enabled: boolean;
  reported_enabled: boolean;
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
      let local: LocalAuthoritySource;
      let transfer: AuthorityImportTransferRow;
      let existing: AuthorityImportTransferRow | undefined;
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        // Inventory, lookup and intent creation use one authority snapshot.
        // Concurrent starts must find the same transfer, not stage twice.
        await requireAccountNotMigrationFrozen(connection, connector.user_id);
        const source = await connection.query<LocalAuthoritySource>(
          `SELECT id, local_id, display_name, authority_epoch, contracts,
                  authority_state, enabled, reported_enabled
           FROM collections
           WHERE connector_id = $1 AND user_id = $2 AND local_id = $3
             AND present = true FOR UPDATE`,
          [connector.id, connector.user_id, collectionId]
        );
        if (!source.rows[0]) {
          await connection.query("ROLLBACK");
          return reply.code(404).send(apiError(
            "authority_source_not_found",
            "The local collection authority was not found."
          ));
        }
        local = source.rows[0];
        existing = (await connection.query<AuthorityImportTransferRow>(
          `SELECT id, user_id, hosted_collection_id, local_collection_id,
                  state, final_head, next_authority_epoch, manifest_digest,
                  source_revision, expires_at
           FROM authority_transfers
           WHERE local_collection_id = $1 AND user_id = $3 AND direction = 'to_hosted'
             AND (
               state IN ('requested', 'prepared', 'activating')
               OR (state = 'completed' AND next_authority_epoch = $2)
             )
           ORDER BY created_at DESC LIMIT 1`,
          [local.id, Number(local.authority_epoch), connector.user_id]
        )).rows[0];
        if (existing?.state === "completed") {
          if (local.authority_state === "active") {
            throw new Error("Completed authority transfer still has an active local source.");
          }
          await connection.query("COMMIT");
          return { transfer: authorityImportTransferView(existing) };
        }
        if (existing?.state === "activating") {
          await connection.query("COMMIT");
          return { transfer: authorityImportTransferView(existing) };
        }
        if (existing && (
          local.authority_state !== "active"
          || Number(local.authority_epoch) + 1 !== Number(existing.next_authority_epoch)
        )) {
          throw importSourceConflict(
            existing.id, collectionId, Number(existing.next_authority_epoch), local, "preflight"
          );
        }
        if (local.authority_state !== "active" || !local.enabled || !local.reported_enabled) {
          await connection.query("ROLLBACK");
          return reply.code(409).send(apiError(
            "authority_transfer_inactive",
            "The local collection is no longer an active authority."
          ));
        }
        transfer = existing ?? await createImportTransfer(
          connection, options.hostedProvider, connector, local
        );
        await connection.query("COMMIT");
        // Keep the staged intent durable on provider uncertainty. Reacquire the
        // account/cohort guard BEFORE prepare/replay, retaining it to publication.
        await connection.query("BEGIN");
        if (await requireHostedCollectionNotMigrationFrozen(connection, local.local_id, connector.user_id) !== connector.user_id) {
          throw new RequestValidationError("Authority import target changed owner.");
        }
        const replay = (await connection.query<AuthorityImportTransferRow>(
          `SELECT id,user_id,hosted_collection_id,local_collection_id,state,final_head,
                  next_authority_epoch,manifest_digest,source_revision,expires_at
           FROM authority_transfers WHERE id=$1 AND user_id=$2 FOR UPDATE`, [transfer.id, connector.user_id]
        )).rows[0];
        if (!replay || !["requested", "prepared"].includes(replay.state)) throw new RequestValidationError("Authority import changed before preparation.");
        transfer = replay;
      const transferId = transfer.id;
      const importToken = randomToken("ati");
      const account = await reconcileHostedAccount(
        connection,
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
      const refreshed = await connection.query<AuthorityImportTransferRow>(
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
      await connection.query("COMMIT");
      return reply.code(existing ? 200 : 201).send({
        transfer: authorityImportTransferView(transfer),
        import: authorityImportCapability(
          options.hostedProvider.url,
          transferId,
          importToken
        )
      });
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally { connection.release(); }
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
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        if (await requireHostedCollectionNotMigrationFrozen(connection, transfer.hosted_collection_id, connector.user_id) !== connector.user_id) {
          throw new RequestValidationError("Authority import target changed owner.");
        }
        const current = (await connection.query<Pick<AuthorityImportTransferRow, "state" | "manifest_digest" | "source_revision" | "final_head">>(
          "SELECT state,manifest_digest,source_revision,final_head FROM authority_transfers WHERE id=$1 FOR UPDATE", [transferId]
        )).rows[0];
        if (!current || !matchesSnapshot(current, input)) throw new RequestValidationError("Authority activation must resume with the same fenced source snapshot.");
        if (current.state === "completed") { await connection.query("COMMIT"); return completedResponse(transfer); }
        if (current.state !== "activating") throw new RequestValidationError("Authority transfer is not reserved for activation.");
        const source = (await connection.query<{ authority_state: string; authority_epoch: string | number }>(
          "SELECT authority_state,authority_epoch FROM collections WHERE id=$1 AND connector_id=$2 FOR UPDATE", [transfer.local_collection_id, connector.id]
        )).rows[0];
        if (source?.authority_state !== "active" || Number(source.authority_epoch) + 1 !== Number(transfer.next_authority_epoch)) {
          throw importSourceConflict(transferId, transfer.hosted_collection_id, Number(transfer.next_authority_epoch), source, "activation");
        }
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
          await connection.query("ROLLBACK");
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
      const receipt = await options.db.query(
        `SELECT transfer_id FROM authority_import_abort_receipts
         WHERE transfer_id = $1 AND connector_id = $2`,
        [transferId, connector.id]
      );
      if (receipt.rows.length > 0) return { ok: true };
      const transfer = await findConnectorImportTransfer(
        options.db,
        connector,
        transferId
      );
      if (!transfer && await recoverAccountImportCancellation(options.db, options.hostedProvider, connector, transferId)) {
        return { ok: true };
      }
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
      // A retained terminal row written by a pre-receipt server can be
      // reconfirmed with the provider; a missing row is never proof of safety.
      if (!["requested", "prepared", "expired", "cancelled"].includes(transfer.state)) {
        return reply.code(409).send(apiError(
          "authority_transfer_activation_started",
          "Authority activation has started and can no longer be cancelled."
        ));
      }
      const connection = await options.db.connect();
      try {
        await connection.query("BEGIN");
        if (await requireHostedCollectionNotMigrationFrozen(connection, transfer.hosted_collection_id, connector.user_id) !== connector.user_id) {
          throw new RequestValidationError("Authority import target changed owner.");
        }
        const current = (await connection.query<{ state: string }>(
          "SELECT state FROM authority_transfers WHERE id=$1 FOR UPDATE", [transferId]
        )).rows[0];
        if (!current || !["requested", "prepared", "expired", "cancelled"].includes(current.state)) {
          throw new RequestValidationError("Authority transfer changed before cancellation.");
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
        if (!await finishAuthorityImportAbort(connection, transfer, "cancelled")) {
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

// Caller owns the account/source locks and commits the staged intent.
async function createImportTransfer(
  connection: DatabaseConnection,
  hostedProvider: HostedProviderClient,
  connector: ConnectorIdentity,
  local: LocalAuthoritySource
): Promise<AuthorityImportTransferRow> {
  const transferId = randomUUID();
  const authorityEpoch = Number(local.authority_epoch) + 1;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1_000);
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
      JSON.stringify(local.contracts),
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
  return inserted.rows[0];
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
    if (await requireHostedCollectionNotMigrationFrozen(preflight, transfer.hosted_collection_id, connector.user_id) !== connector.user_id) {
      throw new RequestValidationError("Authority import target changed owner.");
    }
    const current = (await preflight.query<Pick<AuthorityImportTransferRow,
      "state" | "manifest_digest" | "source_revision" | "final_head"
    >>(
      `SELECT state, manifest_digest, source_revision, final_head
       FROM authority_transfers WHERE id = $1 FOR UPDATE`,
      [transfer.id]
    )).rows[0];
    if (current?.state === "activating" || current?.state === "completed") {
      if (!matchesSnapshot(current, input)) {
        throw new RequestValidationError(
          "Authority activation must resume with the same fenced source snapshot."
        );
      }
      await preflight.query("COMMIT");
      return;
    }
    if (current?.state !== "prepared") {
      throw new RequestValidationError("Authority transfer is no longer prepared for activation.");
    }
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
      throw importSourceConflict(
        transfer.id,
        transfer.hosted_collection_id,
        Number(transfer.next_authority_epoch),
        source.rows[0],
        "preflight"
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
      throw new Error("Authority activation reservation violated its locked transfer state.");
    }
    await preflight.query("COMMIT");
  } catch (error) {
    await preflight.query("ROLLBACK");
    throw error;
  } finally {
    preflight.release();
  }
}

function importSourceConflict(
  transferId: string,
  collectionId: string,
  stagedEpoch: number,
  source: { authority_state: string; authority_epoch: string | number } | undefined,
  phase: "preflight" | "activation"
): RequestValidationError {
  const sourceEpoch = source ? Number(source.authority_epoch) : null;
  const action = phase === "preflight" ? "start activation" : "finish activation";
  const recovery = phase === "preflight"
    ? "Provider activation has not started for this transfer; cancel the transfer before starting another move."
    : "Provider activation may have completed; keep the local source fenced and reconcile this transfer.";
  return new RequestValidationError(
    `Authority transfer ${transferId} for collection ${collectionId} cannot ${action}: `
    + `the control-plane source is ${source?.authority_state ?? "missing"} at epoch ${sourceEpoch ?? "unknown"}; `
    + `expected active at epoch ${stagedEpoch - 1} for staged epoch ${stagedEpoch}. ${recovery}`,
    {
      code: "authority_transfer_source_changed",
      statusCode: 409,
      details: {
        transfer_id: transferId,
        collection_id: collectionId,
        phase,
        source_state: source?.authority_state ?? null,
        source_epoch: sourceEpoch,
        expected_source_epoch: stagedEpoch - 1,
        staged_epoch: stagedEpoch
      }
    }
  );
}

function matchesSnapshot(
  transfer: Pick<AuthorityImportTransferRow, "manifest_digest" | "source_revision" | "final_head">,
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
