import { randomUUID } from "node:crypto";
import type { DatabaseQueryable } from "./database-types.js";

export interface ApplicationReconciliationClaim {
  applicationId: string;
  cursorGrantId: string | null;
  phase: "scan" | "retry";
  token: string;
}

// This marker is intentionally private and stable: the pg-mem adapter uses it
// to recognize only this PostgreSQL-only statement.
const CLAIM_SQL_MARKER = "/* mdbase:application-reconciliation-claim:v1 */";
const CLAIM_SQL = `${CLAIM_SQL_MARKER}
WITH candidate AS (
  SELECT application_id FROM application_reconciliation_jobs
  WHERE available_at<=now() AND NOT (application_id=ANY($2::uuid[]))
    AND (state='pending' OR (state='leased' AND lease_expires_at<=now())
      OR (state='completed' AND next_scan_at<=now()))
  ORDER BY available_at,application_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE application_reconciliation_jobs AS job SET state='leased',lease_token=$1,
  lease_expires_at=now()+(($3::text || ' milliseconds')::interval),
  phase=CASE WHEN job.state='completed' THEN 'scan' ELSE job.phase END,
  cursor_grant_id=CASE WHEN job.state='completed' THEN NULL ELSE job.cursor_grant_id END,
  attempts=job.attempts+1,updated_at=now()
FROM candidate WHERE job.application_id=candidate.application_id
RETURNING job.application_id,job.cursor_grant_id,job.phase`;

export async function claimApplicationReconciliationJob(
  db: DatabaseQueryable,
  excludedApplicationIds: string[],
  leaseMs: number
): Promise<ApplicationReconciliationClaim | null> {
  const token = randomUUID();
  const row = (await db.query<{
    application_id: string;
    cursor_grant_id: string | null;
    phase: "scan" | "retry";
  }>(CLAIM_SQL, [token, excludedApplicationIds, leaseMs])).rows[0];
  return row ? {
    applicationId: row.application_id,
    cursorGrantId: row.cursor_grant_id,
    phase: row.phase,
    token
  } : null;
}
