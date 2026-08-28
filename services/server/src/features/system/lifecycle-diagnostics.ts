import type { FastifyInstance } from "fastify";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";

export const LIFECYCLE_DIAGNOSTICS_SCHEMA_VERSION = 1;

export interface CleanupLifecycleCounts {
  open: number;
  stale: number;
  poison: number;
  reclaimable_sending: number;
  impossible: number;
  oldest_open_seconds: number | null;
}

export interface ReconciliationLifecycleCounts {
  due: number;
  stale_due: number;
  expired_leases: number;
  applications_missing_jobs: number;
  retryable_results: number;
  quarantined_active_grants: number;
  impossible: number;
  oldest_due_seconds: number | null;
}

export interface ConnectLifecycleWork {
  cleanup: CleanupLifecycleCounts;
  application_reconciliation: ReconciliationLifecycleCounts;
}

interface LifecycleAggregateRow {
  cleanup_open: string | number;
  cleanup_stale: string | number;
  cleanup_poison: string | number;
  cleanup_reclaimable_sending: string | number;
  cleanup_impossible: string | number;
  cleanup_oldest_open_seconds: string | number | null;
  reconciliation_due: string | number;
  reconciliation_stale_due: string | number;
  reconciliation_expired_leases: string | number;
  reconciliation_missing_jobs: string | number;
  reconciliation_retryable_results: string | number;
  reconciliation_quarantined_active_grants: string | number;
  reconciliation_impossible: string | number;
  reconciliation_oldest_due_seconds: string | number | null;
}

export const CONNECT_LIFECYCLE_AGGREGATE_SQL = `
WITH cleanup_jobs AS (
  SELECT state, attempts, available_at, last_error, completed_at, created_at
  FROM provider_revocation_jobs
  UNION ALL
  SELECT state, attempts, available_at, last_error, completed_at, created_at
  FROM provider_collection_deletion_jobs
), cleanup AS (
  SELECT
    count(*) FILTER (WHERE completed_at IS NULL) AS open,
    count(*) FILTER (WHERE completed_at IS NULL
      AND created_at <= now() - interval '10 minutes') AS stale,
    count(*) FILTER (WHERE completed_at IS NULL AND attempts >= 5
      AND last_error IS NOT NULL
      AND created_at <= now() - interval '10 minutes') AS poison,
    count(*) FILTER (WHERE completed_at IS NULL AND state = 'sending'
      AND available_at <= now()) AS reclaimable_sending,
    count(*) FILTER (WHERE ((state = 'completed') <> (completed_at IS NOT NULL))
      OR (state = 'completed' AND last_error IS NOT NULL)) AS impossible,
    extract(epoch FROM now() - min(created_at)
      FILTER (WHERE completed_at IS NULL))::bigint AS oldest_open_seconds
  FROM cleanup_jobs
), reconciliation_jobs AS (
  SELECT *, CASE
    WHEN state = 'pending' AND available_at <= now() THEN available_at
    WHEN state = 'leased' AND lease_expires_at <= now() THEN lease_expires_at
    WHEN state = 'completed' AND next_scan_at <= now() THEN next_scan_at
    ELSE NULL END AS due_at
  FROM application_reconciliation_jobs
), reconciliation AS (
  SELECT
    count(*) FILTER (WHERE due_at IS NOT NULL) AS due,
    count(*) FILTER (WHERE due_at IS NOT NULL
      AND updated_at <= now() - interval '10 minutes') AS stale_due,
    count(*) FILTER (WHERE state = 'leased' AND lease_expires_at <= now()) AS expired_leases,
    count(*) FILTER (WHERE
      (state = 'leased') <> (lease_token IS NOT NULL)
      OR (state = 'leased') <> (lease_expires_at IS NOT NULL)
      OR (phase = 'retry' AND cursor_grant_id IS NOT NULL)
      OR (state = 'completed' AND (phase <> 'scan' OR cursor_grant_id IS NOT NULL
        OR next_scan_at IS NULL))) AS impossible,
    extract(epoch FROM now() - min(due_at))::bigint AS oldest_due_seconds
  FROM reconciliation_jobs
), reconciliation_related AS (
  SELECT
    (SELECT count(*) FROM applications application
      WHERE NOT EXISTS (SELECT 1 FROM application_reconciliation_jobs job
        WHERE job.application_id = application.id)) AS missing_jobs,
    (SELECT count(*) FROM application_reconciliation_results
      WHERE status = 'retryable') AS retryable_results,
    (SELECT count(*) FROM application_reconciliation_results result
      WHERE result.status = 'quarantined' AND EXISTS (
        SELECT 1 FROM grants grant_row WHERE grant_row.id = result.grant_id
          AND grant_row.application_id = result.application_id
          AND grant_row.revoked_at IS NULL AND grant_row.activated_at IS NOT NULL
      )) AS quarantined_active_grants
)
SELECT cleanup.open AS cleanup_open, cleanup.stale AS cleanup_stale,
  cleanup.poison AS cleanup_poison,
  cleanup.reclaimable_sending AS cleanup_reclaimable_sending,
  cleanup.impossible AS cleanup_impossible,
  cleanup.oldest_open_seconds AS cleanup_oldest_open_seconds,
  reconciliation.due AS reconciliation_due,
  reconciliation.stale_due AS reconciliation_stale_due,
  reconciliation.expired_leases AS reconciliation_expired_leases,
  reconciliation_related.missing_jobs AS reconciliation_missing_jobs,
  reconciliation_related.retryable_results AS reconciliation_retryable_results,
  reconciliation_related.quarantined_active_grants AS reconciliation_quarantined_active_grants,
  reconciliation.impossible AS reconciliation_impossible,
  reconciliation.oldest_due_seconds AS reconciliation_oldest_due_seconds
FROM cleanup CROSS JOIN reconciliation CROSS JOIN reconciliation_related`;

function count(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Lifecycle diagnostic count was outside the safe integer range.");
  }
  return parsed;
}

function age(value: string | number | null): number | null {
  return value === null ? null : count(value);
}

export async function readConnectLifecycleWork(db: DatabasePool): Promise<ConnectLifecycleWork> {
  const connection = await db.connect();
  let begun = false;
  try {
    await connection.query("BEGIN READ ONLY");
    begun = true;
    await connection.query("SET LOCAL statement_timeout = '2s'");
    await connection.query("SET LOCAL lock_timeout = '250ms'");
    const result = await connection.query<LifecycleAggregateRow>(CONNECT_LIFECYCLE_AGGREGATE_SQL);
    const row = result.rows[0];
    if (!row) throw new Error("Lifecycle aggregate returned no row.");
    await connection.query("COMMIT");
    begun = false;
    return {
      cleanup: {
        open: count(row.cleanup_open),
        stale: count(row.cleanup_stale),
        poison: count(row.cleanup_poison),
        reclaimable_sending: count(row.cleanup_reclaimable_sending),
        impossible: count(row.cleanup_impossible),
        oldest_open_seconds: age(row.cleanup_oldest_open_seconds)
      },
      application_reconciliation: {
        due: count(row.reconciliation_due),
        stale_due: count(row.reconciliation_stale_due),
        expired_leases: count(row.reconciliation_expired_leases),
        applications_missing_jobs: count(row.reconciliation_missing_jobs),
        retryable_results: count(row.reconciliation_retryable_results),
        quarantined_active_grants: count(row.reconciliation_quarantined_active_grants),
        impossible: count(row.reconciliation_impossible),
        oldest_due_seconds: age(row.reconciliation_oldest_due_seconds)
      }
    };
  } catch (error) {
    if (begun) await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export function registerLifecycleDiagnosticRoute(
  app: FastifyInstance,
  options: {
    db: DatabasePool;
    hostedProvider?: Pick<HostedProviderClient, "authorizesInternalToken">;
  }
): void {
  app.get("/internal/v1/lifecycle-diagnostics", async (request, reply) => {
    if (!options.hostedProvider?.authorizesInternalToken(bearerToken(request))) {
      return reply.code(401).send(apiError(
        "invalid_internal_token",
        "Hosted provider credential is invalid."
      ));
    }
    try {
      return {
        schema_version: LIFECYCLE_DIAGNOSTICS_SCHEMA_VERSION,
        lifecycle_work: { state: "ok", value: await readConnectLifecycleWork(options.db) }
      };
    } catch {
      return {
        schema_version: LIFECYCLE_DIAGNOSTICS_SCHEMA_VERSION,
        lifecycle_work: { state: "unavailable" }
      };
    }
  });
}
