// Dedicated migration-token fronts for the existing provider fence and drain.
// These deny-first actions do not create keys, grant serving authority, cut over,
// restore replicas or unfreeze a collection. Native source admission is separate.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { HostedProviderResponseError, HostedProviderUnavailableError, type HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { inTransaction } from "./bootstrap-common.js";
import { RolloutRefused } from "./migration-rollout.js";

interface Claim { account: string; started_us: string }
interface Options {
  db: DatabasePool; token: string;
  provider?: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationFence">;
}

/** Current migration claim, not target/key readiness. Internal migration may
 * preserve an existing suspension; nothing here enables ordinary user access.
 * The locked form is for the final publication/audit, never a network await. */
async function claim(db: DatabaseQueryable, collection: string, locked = false): Promise<Claim> {
  const row = (await db.query<Claim>(
    `SELECT h.user_id::text AS account, (extract(epoch FROM m.started_at)*1000000)::bigint::text AS started_us
     FROM hosted_collections h JOIN users u ON u.id=h.user_id
     JOIN next_migration_cohort_members m ON m.account_id=u.id
     WHERE h.id=$1 AND h.authority_state='active' AND h.quarantined_at IS NULL
       AND u.account_backend='legacy' AND m.started_at IS NOT NULL AND m.terminal_excluded_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id=h.id)
       AND NOT EXISTS (SELECT 1 FROM next_migration_collections c WHERE c.collection_id=h.id)
       AND NOT EXISTS (SELECT 1 FROM next_migration_account_flips f WHERE f.account_id=u.id)
     ${locked ? "FOR SHARE OF h,u,m" : ""}`, [collection]
  )).rows[0];
  if (!row) throw new RolloutRefused("migration_source_not_current", "No current hosted migration claim.");
  return row;
}

async function action(collection: string, fence: boolean, options: Options) {
  const before = await claim(options.db, collection);
  if (!options.provider) throw new RolloutRefused("migration_source_unavailable", "The legacy provider is unavailable.", 503);
  const deadline = Date.now() + 25_000;
  const source = await options.provider.legacyMigrationDrain(collection, { deadline });
  // Never re-fence a retained/cut-over collection through this launch front.
  // A missing run identity for a fenced source is not an active migration.
  if (!["active", "migrating"].includes(source.state) || source.retain_until !== null
      || (source.state === "migrating" && (!source.migration_id || !source.started_at))) {
    throw new RolloutRefused("migration_source_not_current", "The legacy source is not pre-cutover.");
  }
  if (source.collection_id !== collection) throw new RolloutRefused("migration_source_unavailable", "The source identity does not match.", 503);
  // Recheck after the read, before any provider effect. Provider fencing itself
  // orders with legacy writers using its existing collection row lock.
  const current = await claim(options.db, collection);
  if (current.account !== before.account || current.started_us !== before.started_us) {
    throw new RolloutRefused("migration_source_changed", "The migration claim changed.");
  }
  const result = fence ? await options.provider.legacyMigrationFence(collection, { deadline }) : source;
  if (result.collection_id !== collection || (fence && result.retain_until !== null)) {
    throw new RolloutRefused("migration_source_unavailable", "The provider outcome is not a current source.", 503);
  }
  return inTransaction(options.db, async client => {
    const after = await claim(client, collection, true);
    if (after.account !== before.account || after.started_us !== before.started_us) {
      throw new RolloutRefused("migration_source_changed", "The migration claim changed.");
    }
    await audit(client, after.account, fence ? "next_migration.fence" : "next_migration.source", collection,
      { migration_id: result.migration_id ?? null, state: result.state });
    return result;
  });
}

export function registerMigrationProviderRoutes(app: FastifyInstance, options: Options): void {
  const params = z.object({ id: z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u)
    .refine(id => id !== "00000000-0000-0000-0000-000000000000") }).strict();
  const empty = z.object({}).strict();
  for (const fence of [false, true]) {
    app.route({ method: fence ? "POST" : "GET", url: `/internal/v1/next/migration/collections/:id/${fence ? "fence" : "source"}`,
      bodyLimit: 4096, config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const token = bearerToken(request);
        if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
        const p = params.safeParse(request.params);
        if (!p.success || !empty.safeParse(request.query).success || !empty.safeParse(request.body ?? {}).success) {
          return reply.code(400).send(apiError("invalid_request", "A canonical collection UUID and no caller-selected source facts are required."));
        }
        try { return await action(p.data.id, fence, options); }
        catch (error) {
          if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
          if (error instanceof HostedProviderResponseError || error instanceof HostedProviderUnavailableError || error instanceof z.ZodError) {
            return reply.code(503).send(apiError("migration_source_unavailable", "No verified provider outcome; retry the same collection."));
          }
          if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) {
            return reply.code(503).send(apiError("busy", "Busy; retry."));
          }
          throw error;
        }
      }
    });
  }
}
