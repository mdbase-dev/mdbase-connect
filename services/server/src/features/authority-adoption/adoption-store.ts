import type { CollectionContractDescriptor } from "@mdbase/connect-protocol";
import type { DatabasePool } from "../../database-types.js";
import {
  HostedProviderResponseError,
  type HostedProviderClient
} from "../../hosted-provider.js";
import { tokenHash } from "../../security.js";

export interface AuthorityAdoptionRow {
  id: string;
  secret_hash: string;
  collection_id: string;
  display_name: string;
  source_name: string;
  retain_mirror: boolean;
  mirror_name: string | null;
  user_id: string | null;
  state:
    | "requested"
    | "approved"
    | "prepared"
    | "activating"
    | "completed"
    | "cancelled"
    | "expired";
  next_authority_epoch: string | number;
  final_head: string | number | null;
  manifest_digest: string | null;
  source_revision: string | null;
  contracts: CollectionContractDescriptor[];
  expires_at: string | Date;
  approved_at: string | Date | null;
  prepared_at: string | Date | null;
  completed_at: string | Date | null;
}

export function authorityAdoptionSelect(): string {
  return `SELECT adoption.id, adoption.secret_hash, adoption.collection_id,
                 adoption.display_name, adoption.source_name,
                 adoption.retain_mirror, adoption.mirror_name,
                 adoption.user_id, adoption.state,
                 adoption.next_authority_epoch, adoption.final_head,
                 adoption.manifest_digest, adoption.source_revision,
                 adoption.contracts, adoption.expires_at,
                 adoption.approved_at, adoption.prepared_at,
                 adoption.completed_at
          FROM authority_adoption_requests adoption`;
}

export async function authorityAdoptionBySecret(
  db: DatabasePool,
  adoptionId: string,
  secret: string
): Promise<AuthorityAdoptionRow | null> {
  const result = await db.query<AuthorityAdoptionRow>(
    `${authorityAdoptionSelect()}
     LEFT JOIN users account ON account.id = adoption.user_id
     WHERE adoption.id = $1 AND adoption.secret_hash = $2
       AND adoption.revoked_at IS NULL
       AND (adoption.user_id IS NULL OR account.suspended_at IS NULL)`,
    [adoptionId, tokenHash(secret)]
  );
  return result.rows[0] ?? null;
}

export function authorityAdoptionView(
  adoption: AuthorityAdoptionRow
): Record<string, unknown> {
  return {
    id: adoption.id,
    collection_id: adoption.collection_id,
    display_name: adoption.display_name,
    source_name: adoption.source_name,
    retain_mirror: adoption.retain_mirror,
    mirror_name: adoption.mirror_name,
    state: adoption.state,
    authority_epoch: Number(adoption.next_authority_epoch),
    final_head:
      adoption.final_head === null ? null : Number(adoption.final_head),
    manifest_digest: adoption.manifest_digest,
    source_revision: adoption.source_revision,
    contracts: adoption.contracts ?? [],
    expires_at: new Date(adoption.expires_at).toISOString(),
    approved_at: adoption.approved_at
      ? new Date(adoption.approved_at).toISOString()
      : null,
    prepared_at: adoption.prepared_at
      ? new Date(adoption.prepared_at).toISOString()
      : null,
    completed_at: adoption.completed_at
      ? new Date(adoption.completed_at).toISOString()
      : null
  };
}

export async function recoverExpiredAuthorityAdoptions(
  db: DatabasePool,
  hostedProvider?: HostedProviderClient
): Promise<void> {
  await db.query(
    `UPDATE authority_adoption_requests
     SET state = 'expired'
     WHERE expires_at <= now()
       AND state IN ('requested', 'approved', 'prepared')`
  );
  if (!hostedProvider) return;
  const pendingCleanup = await db.query<{
    id: string;
    collection_id: string;
  }>(
    `SELECT id, collection_id FROM authority_adoption_requests
     WHERE state = 'expired' AND cleanup_completed = false`
  );
  for (const adoption of pendingCleanup.rows) {
    try {
      await hostedProvider.abortAuthorityImport(adoption.id);
    } catch (error) {
      if (
        !(error instanceof HostedProviderResponseError)
        || ![
          "authority_import_not_found",
          "authority_import_inactive"
        ].includes(error.code)
      ) {
        throw error;
      }
    }
    const connection = await db.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "DELETE FROM mirror_pairing_requests WHERE id = $1",
        [adoption.id]
      );
      await connection.query(
        `DELETE FROM hosted_collections
         WHERE id = $1 AND authority_state = 'importing'`,
        [adoption.collection_id]
      );
      await connection.query(
        `UPDATE authority_adoption_requests
         SET cleanup_completed = true
         WHERE id = $1 AND state = 'expired'`,
        [adoption.id]
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      connection.release();
    }
  }
}
