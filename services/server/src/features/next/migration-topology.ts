import type { DatabaseConnection } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";

/**
 * Call on the mutation's actual transaction client BEFORE provider effects,
 * publication or long awaits; retain the transaction through effects/commit.
 * Supply BOTH actual transfer owners together, not merely the requesting member.
 * User/current-member locks serialize assignment/moves, including absent
 * membership (assignment locks the user FOR UPDATE). Cohorts lock in name order.
 * FOR UPDATE up front avoids a SHARE->UPDATE upgrade when 0062's revision
 * triggers update the same parent AFTER effects. Inspect state AFTER locking;
 * a frozen-state WHERE predicate would incorrectly treat refusal as absence.
 */
export async function requireAccountNotMigrationFrozen(client: DatabaseConnection, accountId: string, ...otherAccountIds: string[]): Promise<void> {
  const accounts = [...new Set([accountId, ...otherAccountIds])].sort();
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE", [accounts]);
    const members = (await client.query<{ cohort: string }>(
      "SELECT cohort FROM next_migration_cohort_members WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR SHARE", [accounts]
    )).rows;
    const names = [...new Set(members.map((m) => m.cohort))].sort();
    if (!names.length) return;
    const cohorts = (await client.query<{ name: string; frozen_at: Date | null }>(
      "SELECT name, frozen_at FROM next_migration_cohorts WHERE name = ANY($1::text[]) ORDER BY name FOR UPDATE", [names]
    )).rows;
    if (cohorts.length !== names.length) throw new Error("Migration membership has no cohort.");
    if (cohorts.some((c) => c.frozen_at !== null)) throw new RequestValidationError("Migration topology is frozen.", {
      statusCode: 409, code: "migration_frozen"
    });
  } catch (error) {
    if (["55P03", "40P01", "40001", "57014"].includes(String((error as { code?: string } | null)?.code))) {
      throw new RequestValidationError("Busy; retry.", { statusCode: 409, code: "busy" });
    }
    throw error;
  }
}
