import { SyncError } from "@mdbase-dev/connect-sync";
import { resolveHostedCollectionAccess } from "../../collection-access.js";
import type {
  DatabasePool,
  DatabaseQueryable
} from "../../database-types.js";
import type { HostedAuthorityRegistry } from "../../hosted.js";
import {
  HostedProviderResponseError,
  type HostedProviderClient
} from "../../hosted-provider.js";
import { tokenHash } from "../../security.js";

export interface AuthorityTransferRow {
  id: string;
  user_id: string;
  hosted_collection_id: string;
  pairing_id: string;
  replica_id: string;
  local_collection_id: string | null;
  state:
    | "requested"
    | "approved"
    | "prepared"
    | "activating"
    | "completed"
    | "cancelled"
    | "expired";
  final_head: string | number | null;
  next_authority_epoch: string | number | null;
  manifest_digest: string | null;
  expires_at: string | Date;
}

export interface AuthorityTransferDetails extends AuthorityTransferRow {
  collection_name?: string;
  mirror_name?: string;
}

export interface AuthorityImportTransferRow {
  id: string;
  user_id: string;
  hosted_collection_id: string;
  local_collection_id: string;
  state:
    | "requested"
    | "prepared"
    | "activating"
    | "completed"
    | "cancelled"
    | "expired";
  final_head: string | number | null;
  next_authority_epoch: string | number;
  manifest_digest: string | null;
  source_revision: string | null;
  expires_at: string | Date;
}

export interface AuthorityPairing {
  pairing_id: string;
  user_id: string;
  collection_id: string;
  replica_id: string;
  mode: "read_only" | "read_write";
  allowed_types: string[];
  authority_state: "active" | "transferring" | "transferred";
}

export async function authorityPairing(
  db: DatabasePool,
  pairingId: string,
  secret: string | null
): Promise<AuthorityPairing | null> {
  if (!secret) return null;
  const result = await db.query<AuthorityPairing & {
    replica_collection_id: string;
    consumed_at: string | null;
    purpose: "mirror" | "application";
    revoked_at: string | null;
  }>(
    `SELECT pairing.id AS pairing_id, pairing.user_id,
            pairing.collection_id, pairing.replica_id, pairing.mode,
            pairing.consumed_at, replica.allowed_types,
            replica.collection_id AS replica_collection_id,
            replica.purpose, replica.revoked_at, hosted.authority_state
     FROM mirror_pairing_requests pairing
     JOIN hosted_replicas replica ON replica.id = pairing.replica_id
     JOIN hosted_collections hosted ON hosted.id = pairing.collection_id
     JOIN users account ON account.id = pairing.user_id
     WHERE pairing.id = $1 AND pairing.secret_hash = $2
       AND pairing.revoked_at IS NULL
       AND account.suspended_at IS NULL`,
    [pairingId, tokenHash(secret)]
  );
  const pairing = result.rows[0];
  if (
    !pairing
    || !pairing.consumed_at
    || pairing.purpose !== "mirror"
    || pairing.revoked_at
    || pairing.replica_collection_id !== pairing.collection_id
  ) {
    return null;
  }
  const access = await resolveHostedCollectionAccess(
    db,
    pairing.user_id,
    pairing.collection_id
  );
  if (!access?.actions.has("authority.transfer")) return null;
  const {
    replica_collection_id: _replicaCollectionId,
    consumed_at: _consumedAt,
    purpose: _purpose,
    revoked_at: _revokedAt,
    ...authenticated
  } = pairing;
  return authenticated;
}

export async function mirrorAuthorityTransfer(
  db: DatabasePool,
  transferId: string,
  secret: string | null
): Promise<AuthorityTransferRow | null> {
  if (!secret) return null;
  const result = await db.query<AuthorityTransferRow>(
    `SELECT transfer.id, transfer.user_id,
            transfer.hosted_collection_id, transfer.pairing_id,
            transfer.replica_id, transfer.local_collection_id,
            transfer.state, transfer.final_head,
            transfer.next_authority_epoch, transfer.manifest_digest,
            transfer.expires_at
     FROM authority_transfers transfer
     JOIN mirror_pairing_requests pairing ON pairing.id = transfer.pairing_id
     JOIN users account ON account.id = transfer.user_id
     WHERE transfer.id = $1 AND pairing.secret_hash = $2
       AND pairing.revoked_at IS NULL
       AND account.suspended_at IS NULL`,
    [transferId, tokenHash(secret)]
  );
  const transfer = result.rows[0];
  if (!transfer) return null;
  const access = await resolveHostedCollectionAccess(
    db,
    transfer.user_id,
    transfer.hosted_collection_id
  );
  return access?.actions.has("authority.transfer") ? transfer : null;
}

// Caller owns the transaction and the user's inventory/authority lock, and
// must have confirmed provider abortion first.
// Save the acknowledgement before collection deletion cascades away the transfer.
export async function finishAuthorityImportAbort(
  db: DatabaseQueryable,
  transfer: Pick<AuthorityTransferRow, "id" | "hosted_collection_id" | "next_authority_epoch">,
  state: "cancelled" | "expired"
): Promise<boolean> {
  const changed = await db.query(
    `UPDATE authority_transfers SET state = $2
     WHERE id = $1 AND direction = 'to_hosted'
       AND state IN ('requested', 'prepared', 'expired', 'cancelled')`,
    [transfer.id, state]
  );
  if (changed.rowCount !== 1) return false;
  await db.query(
    `INSERT INTO authority_import_abort_receipts (transfer_id, connector_id)
     SELECT transfer.id, source.connector_id
     FROM authority_transfers transfer
     JOIN collections source ON source.id = transfer.local_collection_id
     WHERE transfer.id = $1
     ON CONFLICT (transfer_id) DO NOTHING`,
    [transfer.id]
  );
  await db.query(
    `UPDATE hosted_collections
     SET authority_state = 'transferred', authority_epoch = $2
     WHERE id = $1 AND authority_state = 'importing'
       AND transferred_collection_id IS NOT NULL`,
    [transfer.hosted_collection_id, Number(transfer.next_authority_epoch) - 1]
  );
  await db.query(
    `DELETE FROM hosted_collections
     WHERE id = $1 AND authority_state = 'importing'
       AND transferred_collection_id IS NULL`,
    [transfer.hosted_collection_id]
  );
  return true;
}

// Discovery is advisory. Every destructive action uses a fresh, locked row.
const expirableTransfer = `expires_at <= now() AND (
  (direction = 'to_hosted' AND state IN ('requested', 'prepared'))
  OR (direction = 'to_local' AND state IN ('requested', 'approved', 'prepared'))
)`;

export async function recoverExpiredAuthorityTransfers(
  db: DatabasePool,
  hostedProvider?: HostedProviderClient,
  hostedReference?: HostedAuthorityRegistry
): Promise<void> {
  const deadline = Date.now() + 15_000;
  const discovered = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM authority_transfers
     WHERE ${expirableTransfer} ORDER BY expires_at, id LIMIT 25`
  );
  for (const candidate of discovered.rows) {
    if (Date.now() >= deadline) break;
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      // Same lock order as activation and inventory. Keep these locks through
      // provider acknowledgement and cleanup; an uncertain RPC rolls back CP
      // changes and is reconciled by the idempotent expiry operation on retry.
      await connection.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [candidate.user_id]);
      const locked = await connection.query<{
        id: string; user_id: string; hosted_collection_id: string;
        direction: "to_local" | "to_hosted";
        state: "requested" | "approved" | "prepared";
        next_authority_epoch: string | number;
      }>(
        `SELECT id, user_id, hosted_collection_id, direction, state, next_authority_epoch
         FROM authority_transfers WHERE id = $1 AND user_id = $2
           AND ${expirableTransfer} FOR UPDATE`,
        [candidate.id, candidate.user_id]
      );
      const transfer = locked.rows[0];
      if (!transfer) {
        await connection.query("ROLLBACK");
        continue;
      }
      if (transfer.direction === "to_hosted" || transfer.state === "prepared") {
        const parent = await connection.query<{ id: string }>(
          `SELECT id FROM hosted_collections WHERE id = $1 AND user_id = $2
             AND authority_state = $3 AND authority_epoch = $4 FOR UPDATE`,
          [transfer.hosted_collection_id, transfer.user_id,
            transfer.direction === "to_hosted" ? "importing" : "transferring",
            Number(transfer.next_authority_epoch) - (transfer.direction === "to_local" ? 1 : 0)]
        );
        if (parent.rows.length !== 1) {
          await connection.query("ROLLBACK");
          continue;
        }
      }
      if (transfer.direction === "to_hosted") {
        if (!hostedProvider) {
          await connection.query("ROLLBACK");
          continue;
        }
        // A provider renewal can commit before its CP deadline is published.
        // Only the provider's locked current deadline can authorize expiration.
        // Never fall back to generic user cancellation, even on an old provider.
        await hostedProvider.expireAuthorityImport(
          transfer.id, transfer.hosted_collection_id, Number(transfer.next_authority_epoch)
        );
        if (!await finishAuthorityImportAbort(connection, transfer, "expired")) {
          await connection.query("ROLLBACK");
          continue;
        }
      } else {
        const candidates = transfer.state === "prepared"
          ? await connection.query<{ id: string }>(
              `SELECT collection.id FROM collections collection
               JOIN connectors connector ON connector.id = collection.connector_id
               WHERE collection.local_id = $1 AND collection.authority_state = 'candidate'
                 AND connector.user_id = $2 ORDER BY collection.id LIMIT 257 FOR UPDATE OF collection`,
              [transfer.hosted_collection_id, transfer.user_id]
            )
          : { rows: [] };
        if (candidates.rows.length > 256) {
          throw new Error("Authority transfer recovery candidate limit exceeded.");
        }
        if (transfer.state === "prepared") {
          if (hostedProvider) {
            await hostedProvider.expireAuthorityTransfer(
              transfer.id, transfer.hosted_collection_id, Number(transfer.next_authority_epoch)
            );
          } else if (hostedReference) {
            await hostedReference.abortAuthorityTransfer(transfer.id);
          } else {
            await connection.query("ROLLBACK");
            continue;
          }
        }
        const expired = await connection.query(
          `UPDATE authority_transfers SET state = 'expired'
           WHERE id = $1 AND user_id = $2 AND state = $3 AND ${expirableTransfer}`,
          [transfer.id, transfer.user_id, transfer.state]
        );
        if (expired.rowCount !== 1) {
          await connection.query("ROLLBACK");
          continue;
        }
        if (transfer.state === "prepared") {
          const restored = await connection.query(
            `UPDATE hosted_collections SET authority_state = 'active'
             WHERE id = $1 AND user_id = $2 AND authority_state = 'transferring'
               AND authority_epoch = $3`,
            [transfer.hosted_collection_id, transfer.user_id, Number(transfer.next_authority_epoch) - 1]
          );
          if (restored.rowCount !== 1) throw new Error("Authority transfer recovery parent changed.");
          // Retire only the exact candidates locked for this transition, never
          // a broad post-RPC search that can catch a replacement promotion.
          if (candidates.rows.length) await connection.query(
            `UPDATE collections SET authority_state = 'retired', enabled = false
             WHERE id = ANY($1::uuid[]) AND authority_state = 'candidate'`,
            [candidates.rows.map((local) => local.id)]
          );
        }
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      if ((error instanceof HostedProviderResponseError || error instanceof SyncError)
        && ["authority_transfer_completed", "authority_transfer_not_expired",
          "authority_import_completed", "authority_import_indexing", "authority_import_not_expired"].includes(error.code)) {
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

export async function retireAuthorityCandidates(
  db: DatabaseQueryable,
  userId: string,
  hostedCollectionId: string
): Promise<void> {
  await db.query(
    `UPDATE collections
     SET authority_state = 'retired', enabled = false
     WHERE local_id = $1 AND authority_state = 'candidate'
       AND connector_id IN (
         SELECT id FROM connectors WHERE user_id = $2
       )`,
    [hostedCollectionId, userId]
  );
}

export function authorityTransferView(
  transfer: AuthorityTransferDetails,
  publicUrl: string
): Record<string, unknown> {
  return {
    id: transfer.id,
    collection_id: transfer.hosted_collection_id,
    replica_id: transfer.replica_id,
    state: transfer.state,
    final_head:
      transfer.final_head === null ? null : Number(transfer.final_head),
    authority_epoch: transfer.next_authority_epoch === null
      ? null
      : Number(transfer.next_authority_epoch),
    manifest_digest: transfer.manifest_digest,
    expires_at: new Date(transfer.expires_at).toISOString(),
    verification_uri: `${publicUrl}/transfer/${transfer.id}`,
    ...(transfer.local_collection_id
      ? { local_collection_id: transfer.local_collection_id }
      : {}),
    ...(transfer.collection_name
      ? { collection_name: transfer.collection_name }
      : {}),
    ...(transfer.mirror_name ? { mirror_name: transfer.mirror_name } : {})
  };
}

export function authorityTransferResponse(
  transfer: AuthorityTransferRow,
  publicUrl: string
): Record<string, unknown> {
  return {
    transfer: authorityTransferView(transfer, publicUrl),
    verification_uri: `${publicUrl}/transfer/${transfer.id}`,
    expires_in: Math.max(
      0,
      Math.floor(
        (new Date(transfer.expires_at).getTime() - Date.now()) / 1_000
      )
    )
  };
}

export function authorityImportTransferView(
  transfer: AuthorityImportTransferRow
): Record<string, unknown> {
  return {
    id: transfer.id,
    direction: "to_hosted",
    collection_id: transfer.hosted_collection_id,
    local_collection_id: transfer.local_collection_id,
    state: transfer.state,
    final_head:
      transfer.final_head === null ? null : Number(transfer.final_head),
    authority_epoch: Number(transfer.next_authority_epoch),
    manifest_digest: transfer.manifest_digest,
    source_revision: transfer.source_revision,
    expires_at: new Date(transfer.expires_at).toISOString()
  };
}
