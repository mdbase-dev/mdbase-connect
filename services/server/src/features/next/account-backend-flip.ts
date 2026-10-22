// The writes that put an account on the next backend. The staged migration's
// flip and next-backend account creation both use them, so a new next account
// carries exactly the state of an account with no hosted collections that
// flipped: the backend marker, its flip record and the audit event.
import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";

export type AccountBackend = "legacy" | "next";

/** The flip evidence digest: SHA-256 over the sorted `collection:barrier_f:final_digest` lines. */
export function flipEvidenceDigest(records: readonly { collection_id: string; barrier_f: string | number; final_digest: string }[]): string {
  const lines = records.map((r) => `${r.collection_id.toLowerCase()}:${r.barrier_f}:${r.final_digest}\n`).sort();
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/**
 * Switch the account to next and record its flip. The caller owns the
 * transaction and has checked the account may flip; `collections` is sorted.
 */
export async function recordAccountFlip(
  client: DatabaseQueryable, account: string, collections: readonly string[], evidenceDigest: string,
  facts: Record<string, unknown> = {}
): Promise<Date> {
  await client.query("UPDATE users SET account_backend = 'next' WHERE id = $1", [account]);
  const flipped = (await client.query<{ flipped_at: Date }>(
    `INSERT INTO next_migration_account_flips (account_id, collections, evidence_digest)
     VALUES ($1, $2::uuid[], $3) RETURNING flipped_at`, [account, collections, evidenceDigest]
  )).rows[0]!;
  await audit(client, account, "next_migration.flip", account, { collections, evidence_digest: evidenceDigest, ...facts });
  return flipped.flipped_at;
}

/**
 * Put a just-inserted account on the deployment's backend for new accounts
 * (MDBASE_NEW_ACCOUNT_BACKEND), in the creating transaction. A legacy account
 * keeps the column default; a next account is flipped with no collections.
 */
export async function provisionNewAccountBackend(
  client: DatabaseQueryable, account: string, backend: AccountBackend
): Promise<void> {
  if (backend === "legacy") return;
  await recordAccountFlip(client, account, [], flipEvidenceDigest([]), { new_account: true });
}
