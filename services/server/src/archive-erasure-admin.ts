import type { DatabasePool } from "./database-types.js";
import { drainDeferredAccountDeletions } from "./account-management.js";
import { ProviderRevocationWorker } from "./hosted-capability-lifecycle.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import type { OperatorMutation } from "./instance-admin.js";
import { audit } from "./platform/audit-events.js";

interface QueueObservation {
  revision: string;
  unfrozen: boolean;
  accounts_empty: boolean;
  collections_empty: boolean;
  revocations_empty: boolean;
}

// One bounded statement, including future/sending/unready work. Never replace
// this with the workers' completed count or a due-only predicate.
const OBSERVE = `SELECT membership_revision::text AS revision,
  frozen_at IS NULL AS unfrozen,
  NOT EXISTS (SELECT 1 FROM next_migration_deferred_account_deletions LIMIT 1) AS accounts_empty,
  NOT EXISTS (SELECT 1 FROM provider_collection_deletion_jobs
    WHERE completed_at IS NULL OR state <> 'completed' LIMIT 1) AS collections_empty,
  NOT EXISTS (SELECT 1 FROM provider_revocation_jobs
    WHERE completed_at IS NULL OR state <> 'completed' LIMIT 1) AS revocations_empty
  FROM next_migration_cohorts WHERE name=$1`;
class ArchiveErasureRefused extends Error {}
const refused = (reason: string): Error => new ArchiveErasureRefused(`archive_erasure_${reason}`);

async function observe(db: DatabasePool, cohort: string): Promise<QueueObservation> {
  const client = await db.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='250ms'");
    const result = await client.query<QueueObservation>(OBSERVE, [cohort]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || typeof row.revision !== "string"
        || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(row.revision)
        || BigInt(row.revision) > 9223372036854775807n
        || [row.unfrozen, row.accounts_empty, row.collections_empty, row.revocations_empty]
          .some(value => typeof value !== "boolean")) throw refused("observation_invalid");
    if (row.unfrozen !== true) throw refused("cohort_frozen");
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Existing service-local administrator only; not a new HTTP authority.
 * A successful result is a current observation, never a reusable empty receipt,
 * stopped-writer assertion, physical object-erasure proof or capture/restore GO.
 * One bounded pass; uncertain/nonempty outcomes require explicit reconciliation.
 */
export async function drainArchiveErasures(
  db: DatabasePool,
  provider: HostedProviderClient | undefined,
  runtimeRevision: string | undefined,
  input: OperatorMutation & { cohort: string; expectedRevision: string }
) {
  const { cohort, expectedRevision, operationId, actor, reason } = input;
  if (!/^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/.test(cohort)
      || !/^[0-9a-f]{40}(?![\s\S])/.test(expectedRevision)
      || runtimeRevision !== expectedRevision
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/.test(operationId)
      || operationId === "00000000-0000-0000-0000-000000000000"
      || !actor.trim() || actor.length > 200
      || !reason.trim() || reason.length > 500) throw refused("input_or_revision_invalid");
  if (!provider) throw refused("provider_unconfigured");
  try {
    await observe(db, cohort); // Refuse an already-frozen target BEFORE effects.
    const metadata = { operation_id: operationId, actor, reason, cohort, runtime_revision: runtimeRevision };
    await audit(db, null, "archive.erasure_drain_started", null, metadata);
    // Keep the canonical ready-at/freeze checks and provider timeout/retry logic.
    // No forced readiness, unfreeze, new worker, arbitrary limits or sleep loop.
    const accounts = await drainDeferredAccountDeletions(db, 25);
    const providerJobs = await new ProviderRevocationWorker(db, provider).drain(5);
    const current = await observe(db, cohort);
    if (current.accounts_empty !== true || current.collections_empty !== true
        || current.revocations_empty !== true) throw refused("queue_not_empty");
    if (!Number.isSafeInteger(accounts) || accounts < 0 || accounts > 25
        || !Number.isSafeInteger(providerJobs) || providerJobs < 0 || providerJobs > 5)
      throw refused("completion_invalid");
    await audit(db, null, "archive.erasure_drain_observed_empty", null,
      { ...metadata, membership_revision: current.revision, accounts, provider_jobs: providerJobs });
    return { schema: "mdbase-archive-erasure-preflight/v1", operation_id: operationId,
      runtime_revision: runtimeRevision, membership_revision: current.revision,
      unfrozen: true, queues_empty: { deferred_accounts: true, provider_collections: true, provider_revocations: true },
      completed: { accounts, provider_jobs: providerJobs } };
  } catch (error) {
    // Never emit raw database/provider diagnostics or identities via job logs.
    if (error instanceof ArchiveErasureRefused) throw error;
    throw refused("check_failed");
  }
}
