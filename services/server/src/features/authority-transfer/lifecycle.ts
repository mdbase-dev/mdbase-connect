import { SyncError } from "@mdbase/connect-sync";
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

export async function recoverExpiredAuthorityTransfers(
  db: DatabasePool,
  hostedProvider?: HostedProviderClient,
  hostedReference?: HostedAuthorityRegistry
): Promise<void> {
  const prepared = await db.query<{
    id: string;
    hosted_collection_id: string;
    user_id: string;
    direction: "to_local" | "to_hosted";
    next_authority_epoch: string | number | null;
  }>(
    `SELECT id, hosted_collection_id, user_id, direction,
            next_authority_epoch
     FROM authority_transfers
     WHERE expires_at <= now()
       AND (
         (direction = 'to_hosted' AND state IN ('requested', 'prepared'))
         OR (direction = 'to_local' AND state = 'prepared')
       )`
  );
  for (const transfer of prepared.rows) {
    try {
      if (transfer.direction === "to_hosted") {
        if (!hostedProvider) continue;
        try {
          await hostedProvider.abortAuthorityImport(transfer.id);
        } catch (error) {
          if (
            !(error instanceof HostedProviderResponseError)
            || error.code !== "authority_import_not_found"
          ) {
            throw error;
          }
        }
      } else if (hostedProvider) {
        await hostedProvider.abortAuthorityTransfer(transfer.id);
      } else {
        await hostedReference?.abortAuthorityTransfer(transfer.id);
      }
    } catch (error) {
      if (
        (
          error instanceof HostedProviderResponseError
          || error instanceof SyncError
        )
        && [
          "authority_transfer_completed",
          "authority_import_completed"
        ].includes(error.code)
      ) {
        continue;
      }
      throw error;
    }
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      if (transfer.direction === "to_hosted") {
        await connection.query(
          `UPDATE authority_transfers SET state = 'expired'
           WHERE id = $1 AND state IN ('requested', 'prepared')`,
          [transfer.id]
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
      } else {
        await connection.query(
          `UPDATE authority_transfers SET state = 'expired'
           WHERE id = $1 AND state = 'prepared'`,
          [transfer.id]
        );
        await connection.query(
          `UPDATE hosted_collections SET authority_state = 'active'
           WHERE id = $1 AND authority_state = 'transferring'`,
          [transfer.hosted_collection_id]
        );
        await retireAuthorityCandidates(
          connection,
          transfer.user_id,
          transfer.hosted_collection_id
        );
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
  await db.query(
    `UPDATE authority_transfers SET state = 'expired'
     WHERE state IN ('requested', 'approved') AND expires_at <= now()`
  );
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
