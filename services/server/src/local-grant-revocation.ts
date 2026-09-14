import type { DatabasePool } from "./db.js";

/** Lock the same connector row as snapshot construction before narrowing grants.
 * Every policy at/above this barrier is therefore built after the revocation.
 * Repeating a request never replaces its original barrier or restores credentials.
 */
export async function queueLocalGrantRevocations(db: DatabasePool, userId: string, grantIds: string[]): Promise<void> {
  if (!grantIds.length) return;
  const ids = grantIds.map((_, index) => `$${index + 2}`).join(", ");
  const parameters = [userId, ...grantIds];
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    const connectors = await connection.query<{ connector_id: string }>(
      `SELECT DISTINCT col.connector_id FROM grants g
       JOIN collections col ON col.id = g.collection_id
       WHERE g.user_id = $1 AND g.id IN (${ids}) AND g.hosted_replica_id IS NULL
         AND col.connector_id IS NOT NULL
       ORDER BY col.connector_id`, parameters
    );
    for (const { connector_id } of connectors.rows) {
      const sequence = await connection.query<{ policy_sequence: string | number }>(
        `UPDATE connectors SET policy_sequence = policy_sequence + 1
         WHERE id = $1 AND policy_sequence < $2::bigint RETURNING policy_sequence`,
        [connector_id, Number.MAX_SAFE_INTEGER.toString()]
      );
      if (!sequence.rows[0]) throw new Error("The connector policy sequence cannot advance; revocation needs attention.");
      await connection.query(
        `UPDATE grants SET revocation_policy_sequence = COALESCE(revocation_policy_sequence, $${parameters.length + 1}::bigint)
         WHERE user_id = $1 AND id IN (${ids}) AND hosted_replica_id IS NULL
           AND collection_id IN (SELECT id FROM collections WHERE connector_id = $${parameters.length + 2})`,
        [...parameters, sequence.rows[0].policy_sequence, connector_id]
      );
    }
    await connection.query(
      `UPDATE grants SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND id IN (${ids}) AND hosted_replica_id IS NULL`, parameters
    );
    for (const table of ["access_tokens", "refresh_tokens"] as const) {
      await connection.query(
        `UPDATE ${table} SET revoked_at = COALESCE(revoked_at, now())
         WHERE grant_id IN (SELECT id FROM grants WHERE user_id = $1 AND id IN (${ids}) AND hosted_replica_id IS NULL)`,
        parameters
      );
    }
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally { connection.release(); }
}

/** Called only after the exact snapshot acknowledgement and current-generation checks. */
export async function confirmLocalGrantRevocations(db: DatabasePool, connectorId: string, generation: string, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid policy acknowledgement sequence.");
  await db.query(
    `UPDATE grants SET revocation_confirmed_at = COALESCE(revocation_confirmed_at, now())
     WHERE revoked_at IS NOT NULL AND hosted_replica_id IS NULL
       AND revocation_policy_sequence IS NOT NULL AND revocation_policy_sequence <= $3::bigint
       AND collection_id IN (
         SELECT col.id FROM collections col JOIN connectors c ON c.id = col.connector_id
         WHERE c.id = $1 AND c.relay_generation = $2::bigint AND c.revoked_at IS NULL
       )`, [connectorId, generation, sequence]
  );
}

export async function localGrantRevocationStatus(db: DatabasePool, userId: string, grantId: string): Promise<"revoking" | "revoked"> {
  const result = await db.query<{ revocation_confirmed_at: string | null }>(
    `SELECT revocation_confirmed_at FROM grants
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NOT NULL AND hosted_replica_id IS NULL`,
    [grantId, userId]
  );
  return result.rows[0]?.revocation_confirmed_at ? "revoked" : "revoking";
}
