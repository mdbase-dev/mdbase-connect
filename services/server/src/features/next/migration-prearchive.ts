// Pre-archive source authority only. Never an archive acceptance, account-start,
// target/key/native readiness, serving grant or replacement original H6 journal.
// Unfence is the one way back for a pre-archive fence whose archive failed
// before acceptance: the account never started, so the started-claim unfence
// and rollback (migration-replicas.ts) cannot apply.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
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
import { serialized } from "./migration-replicas.js";
import { readCohortCaptureSnapshot, RolloutRefused } from "./migration-rollout.js";

interface Options {
  db: DatabasePool; token: string; environment?: string;
  provider?: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationFence" | "legacyMigrationSource"
    | "legacyMigrationRevokedReplicas" | "legacyMigrationUnfence">;
}
interface Target { account_id: string; collection_id: string }
const requestBody = z.object({ binding: archiveBindingSchema, inventory_sha256: z.string().regex(HEX64) }).strict();
type Body = z.infer<typeof requestBody>;
const expectedRun = z.object({ migration_id: migrationUuid, started_at: z.iso.datetime({ offset: true }) }).strict();
const drainBody = requestBody.extend({ expected_run: expectedRun }).strict();
const empty = z.object({}).strict();
const params = z.object({ name: z.string().regex(COHORT_NAME), ordinal: z.string().regex(/^(0|[1-9][0-9]{0,3})(?![\s\S])/u).transform(Number).refine(value => value < 1000) }).strict();
const changed = (): never => { throw new RolloutRefused("migration_prearchive_inventory_changed", "The complete pre-archive source inventory is not current."); };

/** Acquire owner/member/held-row locks BEFORE the cohort lock used by capture.
 * No SQL transaction/lock survives a provider await. Every new invocation sees
 * a fresh complete migratable inventory (missing-provider quarantines excluded). */
async function scope(client: DatabaseConnection, name: string, ordinal: number, binding: ArchiveBinding, digest: string): Promise<Target> {
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
  return target!;
}

async function cohortSettled(client: DatabaseConnection, name: string) {
  // Every nonterminal migratable collection is authorized together. Only
  // missing-provider quarantines are excluded; other invalid members refuse.
  const invalid = (await client.query<{ invalid: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
    JOIN next_migration_cohorts c ON c.name=m.cohort
    LEFT JOIN hosted_collections h ON h.user_id=u.id AND h.authority_state<>'transferred' AND (h.quarantined_at IS NULL OR h.quarantine_reason IS DISTINCT FROM 'provider_collection_missing')
    WHERE m.cohort=$1 AND m.terminal_excluded_at IS NULL
      AND (c.released_at IS NULL OR u.account_backend<>'legacy'
        OR EXISTS(SELECT 1 FROM next_migration_account_flips f WHERE f.account_id=u.id)
        OR (h.id IS NOT NULL AND (h.authority_state<>'active' OR h.quarantined_at IS NOT NULL
          OR EXISTS(SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id=h.id)
          OR EXISTS(SELECT 1 FROM next_migration_collections x WHERE x.collection_id=h.id))))) AS invalid`, [name])).rows[0];
  if (invalid?.invalid !== false) changed();
}

type Publication = { kind: string; run: string; started_at?: string; authority_epoch?: string; watermark?: string };
const publish = (client: DatabaseConnection, target: Target, binding: ArchiveBinding, digest: string, publication: Publication) =>
  audit(client, target.account_id, `next_migration.prearchive_${publication.kind}`, target.collection_id,
    { inventory_sha256: digest, membership_revision: binding.membership_revision, migration_id: publication.run,
      ...(publication.started_at ? { started_at: publication.started_at } : {}),
      ...(publication.authority_epoch ? { authority_epoch: publication.authority_epoch } : {}),
      ...(publication.watermark ? { notification_watermark: publication.watermark } : {}) });

async function current(options: Options, name: string, ordinal: number, binding: ArchiveBinding, digest: string, publication?: Publication) {
  return inTransaction(options.db, async client => {
    const target = await scope(client, name, ordinal, binding, digest);
    await cohortSettled(client, name);
    if (publication) await publish(client, target, binding, digest, publication);
    return target;
  });
}

async function action(options: Options, name: string, ordinal: number, body: z.infer<typeof drainBody> | Body, fence: boolean) {
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
      await current(options, name, ordinal, body.binding, body.inventory_sha256, { kind: "fence", run: result.migration_id, started_at: result.started_at });
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

const UNFENCE_INTENT = "next_migration.prearchive_unfence_intent";
const runMoved = (message = "The source is not on Connect's latest pre-archive fence run."): never => {
  throw new RolloutRefused("migration_prearchive_run_not_current", message);
};
const authorityMoved = (): never => {
  throw new RolloutRefused("migration_prearchive_authority_not_current", "The collection's hosted authority is not the active epoch this unfence is bound to.");
};
const BUSY = ["55P03", "57014", "40001", "40P01"];
const busy = (error: unknown) => BUSY.includes(String((error as { code?: unknown })?.code));

interface Recorded {
  /** From Connect's own latest prearchive_fence audit, never the caller. */
  run: string;
  /** Recorded by fences audited since the unfence route; older audits carry
   * only the run id, which the provider mints fresh for every fence. */
  started_at: string | null;
  epoch: string;
  intent: { started_at: string } | null;
  done: boolean;
}

/** Unfence invariants inside scope's locked snapshot, BEFORE the cohort-wide
 * check, so each refusal keeps its own code. Unstarted means no claim exists,
 * which is exactly why the started-claim paths cannot route this back. */
async function unfenceGuard(client: DatabaseConnection, name: string, target: Target): Promise<Recorded> {
  if ((await client.query("SELECT 1 FROM next_migration_archive_acceptances WHERE cohort=$1 LIMIT 1", [name])).rows.length) {
    throw new RolloutRefused("migration_prearchive_archive_accepted", "The cohort archive was accepted; only the started-account rollback applies.");
  }
  const row = (await client.query<{ started: boolean; authority_state: string; epoch: string }>(`SELECT
      (m.started_at IS NOT NULL OR m.terminal_excluded_at IS NOT NULL OR u.account_backend<>'legacy'
        OR EXISTS(SELECT 1 FROM next_migration_account_flips f WHERE f.account_id=u.id)
        OR EXISTS(SELECT 1 FROM next_migration_collections x WHERE x.collection_id=h.id)
        OR EXISTS(SELECT 1 FROM next_policy_outbox o WHERE o.collection_id=h.id
          AND o.ops->'ops' @> '[{"op":"migration-cutover"}]'::jsonb)) AS started,
      h.authority_state, h.authority_epoch::text AS epoch
    FROM next_migration_cohort_members m JOIN users u ON u.id=m.account_id
    JOIN hosted_collections h ON h.user_id=u.id AND h.id=$3
    WHERE m.cohort=$1 AND m.account_id=$2`, [name, target.account_id, target.collection_id])).rows[0];
  if (!row) changed();
  if (row!.started) throw new RolloutRefused("migration_prearchive_account_started", "The account started, flipped, cut over or was excluded; only the started-account paths apply.");
  if (row!.authority_state !== "active") authorityMoved();
  const fence = (await client.query<{ migration_id: unknown; started_at: unknown; superseded: boolean }>(`SELECT
      f.metadata->'migration_id' AS migration_id, f.metadata->'started_at' AS started_at,
      EXISTS(SELECT 1 FROM audit_events x WHERE x.user_id=f.user_id AND x.subject_id=f.subject_id
        AND x.event_type='next_migration.fence' AND x.created_at>=f.created_at) AS superseded
    FROM audit_events f WHERE f.user_id=$1 AND f.subject_id=$2 AND f.event_type='next_migration.prearchive_fence'
    ORDER BY f.created_at DESC, f.id DESC LIMIT 1`, [target.account_id, target.collection_id])).rows[0];
  const run = migrationUuid.safeParse(fence?.migration_id);
  if (!fence || !run.success) return runMoved("Connect recorded no pre-archive fence for this collection.");
  if (fence.superseded) runMoved("A started-account fence superseded the pre-archive fence.");
  if (fence.started_at !== null && typeof fence.started_at !== "string") runMoved();
  const recorded = async (event: string) => (await client.query<{ metadata: { started_at?: unknown; authority_epoch?: unknown } }>(
    "SELECT metadata FROM audit_events WHERE user_id=$1 AND subject_id=$2 AND event_type=$3 AND metadata->>'migration_id'=$4 LIMIT 2",
    [target.account_id, target.collection_id, event, run.data])).rows;
  const intents = await recorded(UNFENCE_INTENT);
  if (intents.length > 1) throw new Error("ambiguous pre-archive unfence intent");
  const intent = intents[0]?.metadata;
  if (intent && (typeof intent.started_at !== "string" || intent.authority_epoch !== row!.epoch)) authorityMoved();
  return { run: run.data, started_at: fence.started_at as string | null, epoch: row!.epoch,
    intent: intent ? { started_at: intent.started_at as string } : null, done: (await recorded(`next_migration.prearchive_unfence`)).length > 0 };
}

async function unfenceCurrent(options: Options, name: string, ordinal: number, body: Body,
  then?: (client: DatabaseConnection, target: Target, recorded: Recorded) => Promise<void>) {
  return inTransaction(options.db, async client => {
    const target = await scope(client, name, ordinal, body.binding, body.inventory_sha256);
    const recorded = await unfenceGuard(client, name, target);
    await cohortSettled(client, name);
    await then?.(client, target, recorded);
    return { target, recorded };
  });
}

/** Undo THIS run's pre-archive fence, once, at an unchanged epoch. The intent
 * commits before the one provider attempt; a lost reply is UNKNOWN and a retry
 * that finds the source active with that intent answers done. */
async function unfence(options: Options, name: string, ordinal: number, body: Body) {
  const provider = options.provider;
  if (!provider) throw new RolloutRefused("migration_prearchive_unavailable", "The configured provider is unavailable.", 503);
  const collection = (await unfenceCurrent(options, name, ordinal, body)).target.collection_id;
  return serialized(options.db, collection, async () => {
    // Same session lock as the started-claim unfence/rollback/revocations, then
    // a fresh locked recheck: this attempt is bound to its run and epoch.
    const before = await unfenceCurrent(options, name, ordinal, body);
    const { target, recorded } = before;
    if (target.collection_id !== collection) changed();
    const same = (now: Target, current: Recorded) => {
      if (now.collection_id !== collection || now.account_id !== target.account_id) changed();
      if (current.run !== recorded.run) runMoved();
      if (current.epoch !== recorded.epoch) authorityMoved();
    };
    const reply = (outcome: "unfenced" | "already_unfenced", startedAt: string) => ({
      schema: "mdbase-migration-prearchive-unfence/1", binding: body.binding, inventory_sha256: body.inventory_sha256, ordinal, ...target,
      outcome, run: { migration_id: recorded.run, started_at: startedAt }, authority_epoch: recorded.epoch,
      source: { collection_id: collection, state: "active", migration_id: null, started_at: null, retain_until: null, restored: [] }
    });
    const done = (client: DatabaseConnection, now: Target, current: Recorded) => {
      same(now, current);
      return current.done ? Promise.resolve() : publish(client, now, body.binding, body.inventory_sha256, { kind: "unfence", run: recorded.run });
    };
    const deadline = Date.now() + 25_000;
    let dispatched = false;
    try {
      const source = legacyMigrationDrainSchema.parse(await provider.legacyMigrationDrain(collection, { deadline }));
      if (source.collection_id !== collection) throw new RolloutRefused("migration_prearchive_unavailable", "The source identity does not match.", 503);
      if (source.state === "active" && source.migration_id == null && source.started_at === null && source.retain_until === null) {
        // Settled: only Connect's recorded intent for this run makes it done.
        if (!recorded.intent) runMoved("The source is active but Connect recorded no unfence for this run.");
        await unfenceCurrent(options, name, ordinal, body, done);
        return reply("already_unfenced", recorded.intent!.started_at);
      }
      if (source.state !== "migrating" || source.retain_until !== null || source.migration_id !== recorded.run || !source.started_at
          || (recorded.started_at !== null && source.started_at !== recorded.started_at)
          || (recorded.intent !== null && source.started_at !== recorded.intent.started_at)) runMoved();
      // `active` cannot restore: a run that owns any revocation is never unfenced here.
      const owned = await provider.legacyMigrationRevokedReplicas(collection, { deadline });
      if (owned.collection_id !== collection || owned.migration_id !== recorded.run) runMoved();
      if (owned.revoked.length) throw new RolloutRefused("migration_prearchive_replicas_revoked", "The run owns replica revocations; unfencing would leave them revoked.");
      const startedAt = source.started_at!;
      await unfenceCurrent(options, name, ordinal, body, async (client, now, current) => {
        same(now, current);
        if (!current.intent) {
          await publish(client, now, body.binding, body.inventory_sha256,
            { kind: "unfence_intent", run: recorded.run, started_at: startedAt, authority_epoch: recorded.epoch });
        }
      });
      dispatched = true;
      const result = await provider.legacyMigrationUnfence(collection, { deadline });
      if (result.collection_id !== collection) throw new Error("pre-archive unfence identity differs");
      await unfenceCurrent(options, name, ordinal, body, done);
      return reply("unfenced", startedAt);
    } catch (error) {
      // One attempt: whatever happened after dispatch is never a retryable refusal.
      if (dispatched) throw new RolloutRefused("migration_prearchive_effect_unknown", "Unfence outcome is ambiguous; retry finds it done or still fenced.", 503);
      if (error instanceof RolloutRefused || busy(error)) throw error;
      throw new RolloutRefused("migration_prearchive_unavailable", "No authenticated current source result.", 503);
    }
  }).catch(error => {
    if (error instanceof RolloutRefused && error.code === "busy") throw new RolloutRefused("migration_prearchive_busy", "Another migration step holds this collection; no source effect dispatched.", 503);
    throw error;
  });
}

export function registerPrearchiveMigrationRoutes(app: FastifyInstance, options: Options): void {
  if (!options.token) throw new Error("Pre-archive routes require the dedicated migration token.");
  for (const kind of ["fence", "drain", "unfence"] as const) {
    app.post(`/internal/v1/next/migration/cohorts/:name/capture/collections/:ordinal/${kind}`, {
      bodyLimit: 4096, config: { rateLimit: migrationServiceRateLimit(options.token, "service:migration:prearchive") },
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        const token = bearerToken(request);
        if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The dedicated migration token is required."));
        if (options.environment !== "lab" && options.environment !== "staging" && options.environment !== "production") return reply.code(503).send(apiError("migration_prearchive_unavailable", "Pre-archive preparation requires a fixed managed environment."));
      }
    }, async (request, reply) => {
      const p = params.safeParse(request.params), body = (kind === "drain" ? drainBody : requestBody).safeParse(request.body);
      if (!p.success || !body.success || !empty.safeParse(request.query).success) return reply.code(400).send(apiError("invalid_request", "Only the original binding, complete inventory digest and original drain run are accepted."));
      try {
        if (kind === "unfence") return await unfence(options, p.data.name, p.data.ordinal, body.data);
        return await action(options, p.data.name, p.data.ordinal, body.data, kind === "fence");
      }
      catch (error) {
        if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
        if (busy(error)) return reply.code(503).send(apiError("migration_prearchive_busy", "No source effect dispatched."));
        throw error;
      }
    });
  }
}
