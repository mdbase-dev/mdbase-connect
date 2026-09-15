import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import type { ConnectorIdentity } from "../../platform/request-authentication.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { audit } from "../../platform/audit-events.js";
import { finishAuthorityImportAbort, type AuthorityImportTransferRow } from "./lifecycle.js";

/** Account-authorized recovery, not a cross-connector lookup relaxation. The
 * provider installs a durable no-prepare fence before local authority can reopen.
 * Keep the server row locked through provider confirmation so activation cannot
 * reserve a conflicting outcome between inspection and acknowledgement.
 */
export async function recoverAccountImportCancellation(
  db: DatabasePool, provider: HostedProviderClient, connector: ConnectorIdentity, transferId: string
): Promise<boolean> {
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const history = await connection.query<{ event_type: string; metadata: unknown }>(
      `SELECT event_type, metadata FROM audit_events WHERE subject_id = $1 AND user_id = $2
       AND event_type IN ('authority_transfer.requested', 'authority_transfer.cancelled', 'authority_transfer.completed') LIMIT 101`,
      [transferId, connector.user_id]
    );
    const requests = history.rows.filter(row => row.event_type === "authority_transfer.requested");
    if (history.rows.length >= 101 || requests.length !== 1 || history.rows.some(row => row.event_type === "authority_transfer.completed")) return false;
    const parsed = z.object({ connector_id: z.uuid(), collection_id: z.uuid(), direction: z.literal("to_hosted"),
      authority_epoch: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER) }).safeParse(requests[0]!.metadata);
    if (!parsed.success) return false;
    const binding = parsed.data;
    const cancellation = z.object({ collection_id: z.literal(binding.collection_id), direction: z.literal("to_hosted") });
    if (history.rows.some(row => row.event_type === "authority_transfer.cancelled" && !cancellation.safeParse(row.metadata).success)) return false;

    const account = await connection.query("SELECT id FROM users WHERE id = $1 AND suspended_at IS NULL FOR UPDATE", [connector.user_id]);
    if (account.rows.length !== 1) return false;
    const computers = await connection.query<{ id: string; user_id: string; revoked_at: unknown }>(
      "SELECT id, user_id, revoked_at FROM connectors WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
      [connector.id, binding.connector_id]
    );
    const current = computers.rows.find(row => row.id === connector.id);
    const original = computers.rows.find(row => row.id === binding.connector_id);
    if (!current || current.user_id !== connector.user_id || current.revoked_at !== null) return false;
    if (original && original.user_id !== connector.user_id) return false;
    if (original && original.id !== current.id && original.revoked_at === null) {
      throw new RequestValidationError("Revoke the original computer before recovering its unfinished move on this registration.");
    }
    const receipts = await connection.query<{ id: string; user_id: string; revoked_at: unknown }>(
      `SELECT c.id, c.user_id, c.revoked_at FROM authority_import_abort_receipts r
       JOIN connectors c ON c.id = r.connector_id WHERE r.transfer_id = $1`, [transferId]
    );
    if (receipts.rows.some(row => row.user_id !== connector.user_id || (row.id !== connector.id && row.revoked_at === null))) return false;
    const found = await connection.query<AuthorityImportTransferRow & { direction: string }>(
      `SELECT id, user_id, hosted_collection_id, local_collection_id, direction, state, final_head,
              next_authority_epoch, manifest_digest, source_revision, expires_at
       FROM authority_transfers WHERE id = $1 FOR UPDATE`, [transferId]
    );
    const transfer = found.rows[0];
    if (transfer && (transfer.user_id !== connector.user_id || transfer.hosted_collection_id !== binding.collection_id
      || Number(transfer.next_authority_epoch) !== binding.authority_epoch
      || transfer.direction !== "to_hosted")) return false;
    if (transfer && !["requested", "prepared", "cancelled", "expired"].includes(transfer.state)) {
      throw new RequestValidationError("This move has entered activation and cannot be cancelled. Its exact activation must be reconciled before reopening the folder.");
    }
    const targets = await connection.query<{ user_id: string; authority_state: string; authority_epoch: string | number }>(
      "SELECT user_id, authority_state, authority_epoch FROM hosted_collections WHERE id = $1 FOR UPDATE", [binding.collection_id]);
    const target = targets.rows[0];
    if (target && (target.user_id !== connector.user_id || !(
      (target.authority_state === "importing" && transfer && Number(target.authority_epoch) === binding.authority_epoch)
      || (target.authority_state === "transferred" && Number(target.authority_epoch) === binding.authority_epoch - 1)
    ))) return false;
    if (transfer?.local_collection_id) {
      const source = await connection.query<{ connector_id: string; local_id: string; user_id: string }>(
        "SELECT connector_id, local_id, user_id FROM collections WHERE id = $1", [transfer.local_collection_id]);
      if (source.rows.length !== 1 || source.rows[0]!.connector_id !== binding.connector_id
        || source.rows[0]!.local_id !== binding.collection_id || source.rows[0]!.user_id !== connector.user_id) return false;
    }
    await provider.reconcileAuthorityImportCancellation(transferId, binding.collection_id, binding.authority_epoch);
    if (transfer && !await finishAuthorityImportAbort(connection, transfer, "cancelled")) {
      throw new RequestValidationError("The transfer changed while cancellation was confirmed.");
    }
    await connection.query(
      `INSERT INTO authority_import_abort_receipts (transfer_id, connector_id) VALUES ($1, $2)
       ON CONFLICT (transfer_id) DO UPDATE SET connector_id = EXCLUDED.connector_id`, [transferId, connector.id]
    );
    await audit(connection, connector.user_id, "authority_transfer.cancelled", transferId, {
      collection_id: binding.collection_id, direction: "to_hosted", recovery: "account_provider_fence"
    });
    await connection.query("COMMIT");
    return true;
  } finally {
    try { await connection.query("ROLLBACK"); } finally { connection.release(); }
  }
}
