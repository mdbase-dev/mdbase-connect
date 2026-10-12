// LAB-only cleanup of one rolled-back provider run's imported timers, so the
// next fenced run can import the collection again (an earlier run's rows would
// otherwise refuse it with timer_import_conflict).
//
// Bound to the presented migration claim (owner account + start, still legacy,
// no cutover, flip or queued cutover policy) and to a verified, settled
// pre-cutover rollback of the presented run: Connect recorded that run's
// unfence or receipted rollback, and the provider now reports the source active with no run. Only
// rows that run's page provenance names (timers/hosted-import.ts) are deleted,
// in one transaction under the namespace locks. Native rows, other runs' rows
// and unattributed rows are never selected. A named row that drifted (changed
// generation or status, erased data, or an emitted event) stops the whole
// cleanup and nothing is deleted. Import manifests and page provenance stay;
// the cleanup appends its own audit event.
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { HostedProviderResponseError, HostedProviderUnavailableError, type HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { inTransaction } from "./bootstrap-common.js";
import { claim } from "./migration-provider.js";
import { RolloutRefused } from "./migration-rollout.js";
import { TIMER_PAGE_EVENT } from "./timers/hosted-import.js";
import { advanceTimerIntent, lockNamespace } from "./timers/store.js";

type Provider = Pick<HostedProviderClient, "legacyMigrationDrain">;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u;
const uuid = z.string().regex(UUID).refine(id => id !== "00000000-0000-0000-0000-000000000000");
const binding = z.object({ owner_account: uuid, started_us: z.string().regex(/^[1-9][0-9]{0,23}(?![\s\S])/u), migration_id: uuid }).strict();
type Binding = z.infer<typeof binding>;
const CLEANUP_EVENT = "next_migration.timers_rollback_cleanup";

async function bound(db: DatabaseQueryable, collection: string, presented: Binding, locked = false): Promise<void> {
  const current = await claim(db, collection, locked);
  if (current.account !== presented.owner_account || current.started_us !== presented.started_us) {
    throw new RolloutRefused("migration_claim_not_current", "The presented migration claim is not current.");
  }
}

async function requireSettledRollback(db: DatabaseQueryable, collection: string, presented: Binding): Promise<void> {
  const unfenced = await db.query(
    `SELECT 1 FROM audit_events WHERE user_id=$1 AND event_type IN ('next_migration.unfence','next_migration.rollback') AND subject_id=$2
       AND metadata->>'migration_id'=$3 LIMIT 1`, [presented.owner_account, collection, presented.migration_id]);
  const queued = await db.query(
    `SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> '[{"op":"migration-cutover"}]'::jsonb LIMIT 1`, [collection]);
  if (!unfenced.rows.length || queued.rows.length) {
    throw new RolloutRefused("migration_rollback_not_settled", "The presented run has no settled pre-cutover rollback.");
  }
}

/** Delete the presented rolled-back run's imported timer rows; see the file header. */
async function cleanUpRolledBackTimerImport(
  db: DatabasePool, provider: Provider | undefined, environment: string | undefined, collection: string, presented: Binding
): Promise<{ collection_id: string; migration_id: string; deleted: number }> {
  if (environment !== "lab") throw new RolloutRefused("migration_lab_only", "Timer rollback cleanup is available in LAB only.", 403);
  if (!provider) throw new RolloutRefused("migration_source_unavailable", "The legacy provider is unavailable.", 503);
  await bound(db, collection, presented);
  await requireSettledRollback(db, collection, presented);
  const source = await provider.legacyMigrationDrain(collection, { deadline: Date.now() + 25_000 });
  if (source.collection_id !== collection) throw new RolloutRefused("migration_source_unavailable", "The source identity does not match.", 503);
  if (source.state !== "active" || source.migration_id != null || source.started_at !== null || source.retain_until !== null) {
    throw new RolloutRefused("migration_rollback_not_settled", "The legacy source is not settled after a rollback.");
  }
  return inTransaction(db, async client => {
    await bound(client, collection, presented, true);
    await requireSettledRollback(client, collection, presented);
    const pages = (await client.query<{ records: unknown }>(
      `SELECT metadata->'records' AS records FROM audit_events WHERE user_id=$1 AND event_type=$2 AND subject_id=$3
         AND metadata->>'migration_id'=$4`, [presented.owner_account, TIMER_PAGE_EVENT, collection, presented.migration_id])).rows;
    const records = new Set<string>();
    for (const page of pages) {
      if (!Array.isArray(page.records) || page.records.some(r => typeof r !== "string" || !/^[0-9a-f]{64}$/u.test(r))) {
        throw new RolloutRefused("timer_cleanup_unverified", "The run's import provenance is malformed.");
      }
      for (const record of page.records as string[]) records.add(record);
    }
    const select = (lock: string) => client.query<{
      grant_id: string; namespace: string; timer_id: string; generation: string; status: string; origin: Record<string, unknown>; emitted: boolean;
    }>(
      `SELECT t.grant_id::text, t.namespace, t.timer_id, t.generation::text, t.status, t.legacy_import_origin AS origin,
         EXISTS (SELECT 1 FROM next_timer_events e WHERE e.grant_id=t.grant_id AND e.namespace=t.namespace AND e.timer_id=t.timer_id) AS emitted
       FROM next_timers t JOIN grants g ON g.id=t.grant_id
       WHERE g.hosted_collection_id=$1 AND t.legacy_import_origin->>'namespace'=$2 AND t.legacy_import_origin->>'record_sha256'=ANY($3::text[])
       ORDER BY t.grant_id, t.namespace, t.timer_id${lock}`,
      [collection, `connect-hosted:${collection}:notifications`, [...records]]);
    // Namespace locks precede row locks, in a deterministic order (as the import).
    const namespaces = [...new Set((await select("")).rows.map(row => `${row.grant_id}\n${row.namespace}`))].sort();
    for (const key of namespaces) { const [grant, namespace] = key.split("\n"); await lockNamespace(client, grant!, namespace!); }
    const rows = (await select(" FOR UPDATE OF t")).rows;
    if (rows.some(row => !namespaces.includes(`${row.grant_id}\n${row.namespace}`))) throw new RolloutRefused("busy", "Busy; retry.", 503);
    if (rows.some(row => row.emitted || row.origin.data_erased !== undefined || row.status === "firing"
        || row.origin.generation !== row.generation || row.origin.status !== row.status)) {
      throw new RolloutRefused("timer_cleanup_drifted", "An imported timer of this run changed since its import; nothing was deleted.");
    }
    for (const row of rows) {
      await client.query("DELETE FROM next_timers WHERE grant_id=$1 AND namespace=$2 AND timer_id=$3", [row.grant_id, row.namespace, row.timer_id]);
    }
    for (const key of new Set(rows.map(row => `${row.grant_id}\n${row.namespace}`))) {
      const [grant, namespace] = key.split("\n"); await advanceTimerIntent(client, grant!, namespace!);
    }
    if (rows.length) {
      const identity = createHash("sha256").update(rows.map(row => String(row.origin.record_sha256)).sort().join("\n"), "utf8").digest("hex");
      await audit(client, presented.owner_account, CLEANUP_EVENT, collection,
        { collection_id: collection, migration_id: presented.migration_id, deleted: rows.length, identity_sha256: identity });
    }
    return { collection_id: collection, migration_id: presented.migration_id, deleted: rows.length };
  });
}

/** `POST …/collections/:id/timers/rollback-cleanup`: the migration token only. */
export function registerMigrationTimerCleanupRoute(app: FastifyInstance, options: {
  db: DatabasePool; token: string; environment?: string; provider?: Provider;
}): void {
  const params = z.object({ id: uuid }).strict(), empty = z.object({}).strict();
  app.post("/internal/v1/next/migration/collections/:id/timers/rollback-cleanup", {
    bodyLimit: 4096, config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const token = bearerToken(request);
    if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
    const p = params.safeParse(request.params), body = binding.safeParse(request.body);
    if (!p.success || !body.success || !empty.safeParse(request.query).success) {
      return reply.code(400).send(apiError("invalid_request", "A canonical collection UUID, the current claim and the rolled-back provider run are required."));
    }
    try {
      return await cleanUpRolledBackTimerImport(options.db, options.provider, options.environment, p.data.id, body.data);
    } catch (error) {
      if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
      if (error instanceof HostedProviderResponseError || error instanceof HostedProviderUnavailableError || error instanceof z.ZodError) {
        return reply.code(503).send(apiError("migration_source_unavailable", "No verified provider outcome; retry."));
      }
      if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) return reply.code(503).send(apiError("busy", "Busy; retry."));
      throw error; // Includes an unknown COMMIT: never report a cleanup.
    }
  });
}
