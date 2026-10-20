// Pre-archive source authority only. Never an archive acceptance, account-start,
// target/key/native readiness, serving grant or replacement original H6 journal.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabasePool } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { legacyMigrationDrainSchema, legacyNotificationWatermarkSchema, migrationFenceSchema, migrationUuid } from "../../hosted-provider-replies.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { inTransaction } from "./bootstrap-common.js";
import { archiveBindingSchema, COHORT_NAME, HEX64, type ArchiveBinding } from "./migration-archive-profile.js";
import { prearchiveInventory } from "./migration-prearchive-inventory.js";
import { migrationServiceRateLimit } from "./migration-rate-limit.js";
import { readCohortCaptureSnapshot, RolloutRefused } from "./migration-rollout.js";

interface Options {
  db: DatabasePool; token: string; environment?: string;
  provider?: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationFence" | "legacyMigrationSource">;
}
const requestBody = z.object({ binding: archiveBindingSchema, inventory_sha256: z.string().regex(HEX64) }).strict();
const expectedRun = z.object({ migration_id: migrationUuid, started_at: z.iso.datetime({ offset: true }) }).strict();
const drainBody = requestBody.extend({ expected_run: expectedRun }).strict();
const empty = z.object({}).strict();
const params = z.object({ name: z.string().regex(COHORT_NAME), ordinal: z.string().regex(/^(0|[1-9][0-9]{0,3})(?![\s\S])/u).transform(Number).refine(value => value < 1000) }).strict();
const changed = (): never => { throw new RolloutRefused("migration_prearchive_inventory_changed", "The complete pre-archive source inventory is not current."); };

/** Acquire owner/member/held-row locks BEFORE the cohort lock used by capture.
 * No SQL transaction/lock survives a provider await. Every new invocation sees
 * a fresh complete inventory, never a filtered eligible subset or old RR view. */
async function current(options: Options, name: string, ordinal: number, binding: ArchiveBinding, digest: string,
  publication?: { kind: string; run: string; watermark?: string }) {
  return inTransaction(options.db, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(`SELECT u.id FROM users u JOIN next_migration_cohort_members m ON m.account_id=u.id
      WHERE m.cohort=$1 ORDER BY u.id FOR SHARE OF u`, [name]);
    await client.query("SELECT account_id FROM next_migration_cohort_members WHERE cohort=$1 ORDER BY account_id FOR SHARE", [name]);
    await client.query(`SELECT h.id FROM hosted_collections h JOIN next_migration_cohort_members m ON m.account_id=h.user_id
      WHERE m.cohort=$1 ORDER BY h.id FOR SHARE OF h`, [name]);
    const capture = await readCohortCaptureSnapshot(client, name);
    const inventory = prearchiveInventory(capture);
    if (Object.entries(binding).some(([key, value]) => capture.binding[key as keyof ArchiveBinding] !== value)
        || inventory.inventory_sha256 !== digest) changed();
    const target = inventory.selected[ordinal];
    if (!target) changed();
    // Every nonterminal held collection is authorized together. Do not put
    // these predicates in inventory WHERE clauses and silently shrink it.
    const invalid = (await client.query<{ invalid: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
      JOIN next_migration_cohorts c ON c.name=m.cohort
      LEFT JOIN hosted_collections h ON h.user_id=u.id AND h.authority_state<>'transferred'
      WHERE m.cohort=$1 AND m.terminal_excluded_at IS NULL
        AND (c.released_at IS NULL OR u.account_backend<>'legacy'
          OR EXISTS(SELECT 1 FROM next_migration_account_flips f WHERE f.account_id=u.id)
          OR (h.id IS NOT NULL AND (h.authority_state<>'active' OR h.quarantined_at IS NOT NULL
            OR EXISTS(SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id=h.id)
            OR EXISTS(SELECT 1 FROM next_migration_collections x WHERE x.collection_id=h.id))))) AS invalid`, [name])).rows[0];
    if (invalid?.invalid !== false) changed();
    if (publication) await audit(client, target.account_id, `next_migration.prearchive_${publication.kind}`, target.collection_id,
      { inventory_sha256: digest, membership_revision: binding.membership_revision, migration_id: publication.run,
        ...(publication.watermark ? { notification_watermark: publication.watermark } : {}) });
    return target;
  });
}

async function action(options: Options, name: string, ordinal: number, body: z.infer<typeof drainBody> | z.infer<typeof requestBody>, fence: boolean) {
  const provider = options.provider;
  if (!provider) throw new RolloutRefused("migration_prearchive_unavailable", "The configured provider is unavailable.", 503);
  const target = await current(options, name, ordinal, body.binding, body.inventory_sha256);
  const deadline = Date.now() + 25_000;
  let dispatchedFence = false;
  try {
    if (fence) {
      const before = legacyMigrationDrainSchema.parse(await provider.legacyMigrationDrain(target.collection_id, { deadline }));
      if (before.collection_id !== target.collection_id || before.state !== "active" || before.migration_id != null
          || before.started_at !== null || before.retain_until !== null) {
        throw new RolloutRefused("migration_prearchive_source_not_active", "An original active unfenced source is required.");
      }
      await current(options, name, ordinal, body.binding, body.inventory_sha256);
      dispatchedFence = true;
      const result = migrationFenceSchema.parse(await provider.legacyMigrationFence(target.collection_id, { deadline }));
      if (result.collection_id !== target.collection_id || result.retain_until !== null) changed();
      await current(options, name, ordinal, body.binding, body.inventory_sha256, { kind: "fence", run: result.migration_id });
      return { schema: "mdbase-migration-prearchive-fence/1", binding: body.binding, inventory_sha256: body.inventory_sha256,
        ordinal, ...target, fence: result };
    }
    const run = drainBody.parse(body).expected_run;
    // Fresh metadata check immediately before the source read, in addition to
    // the first complete check. The provider uses the SAME bounded deadline.
    await current(options, name, ordinal, body.binding, body.inventory_sha256);
    const observed = await provider.legacyMigrationSource(target.collection_id, { deadline });
    const drain = legacyMigrationDrainSchema.parse(observed.drain);
    const watermark = legacyNotificationWatermarkSchema.parse(observed.notificationWatermark);
    if (drain.collection_id !== target.collection_id || drain.state !== "migrating" || drain.retain_until !== null
        || drain.migration_id !== run.migration_id || drain.started_at !== run.started_at || drain.in_flight !== 0) {
      throw new RolloutRefused("migration_prearchive_source_not_drained", "The original source run is not settled.");
    }
    // Preserve unresolved/applied receipt counts unchanged. Existing native H6
    // rules decide which retained evidence blocks external-I/O settlement.
    await current(options, name, ordinal, body.binding, body.inventory_sha256, { kind: "drain", run: run.migration_id, watermark });
    return { schema: "mdbase-migration-prearchive-drain/1", binding: body.binding, inventory_sha256: body.inventory_sha256,
      ordinal, ...target, expected_run: run, drain, notification_watermark: watermark };
  } catch (error) {
    // A dispatched fence may have committed even if its reply/postcheck failed.
    // Never expose it as a retryable effectless refusal or adopt/replay a run.
    if (dispatchedFence) throw new RolloutRefused("migration_prearchive_effect_unknown", "Original fence outcome is ambiguous; do not replay.", 503);
    if (error instanceof RolloutRefused) throw error;
    throw new RolloutRefused("migration_prearchive_unavailable", "No authenticated current source result.", 503);
  }
}

export function registerPrearchiveMigrationRoutes(app: FastifyInstance, options: Options): void {
  if (!options.token) throw new Error("Pre-archive routes require the dedicated migration token.");
  for (const kind of ["fence", "drain"] as const) {
    app.post(`/internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/${kind}`, {
      bodyLimit: 4096, config: { rateLimit: migrationServiceRateLimit(options.token, "service:migration:prearchive") },
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const token = bearerToken(request);
        if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The dedicated migration token is required."));
        if (options.environment !== "lab" && options.environment !== "staging" && options.environment !== "production") return reply.code(503).send(apiError("migration_prearchive_unavailable", "Pre-archive preparation requires a fixed managed environment."));
      }
    }, async (request, reply) => {
      const p = params.safeParse(request.params), body = (kind === "fence" ? requestBody : drainBody).safeParse(request.body);
      if (!p.success || !body.success || !empty.safeParse(request.query).success) return reply.code(400).send(apiError("invalid_request", "Only the original binding, complete inventory digest and original drain run are accepted."));
      try { return await action(options, p.data.name, p.data.ordinal, body.data, kind === "fence"); }
      catch (error) {
        if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
        if (["55P03", "57014", "40001", "40P01"].includes(String((error as { code?: unknown })?.code))) return reply.code(503).send(apiError("migration_prearchive_busy", "No source effect dispatched."));
        throw error;
      }
    });
  }
}
