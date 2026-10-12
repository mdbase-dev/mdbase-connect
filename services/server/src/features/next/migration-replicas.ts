// Migration-token fronts for the fence-first Driver's replica, rollback and
// cutover-policy steps. Every route is bound to the presented migration claim
// (owner account + start) AND the provider run its fence settled, and rechecks
// both around every await and inside the final transaction. Provider bodies are
// passed through unchanged for the native settlement mirror.
//
// Effects on one collection are serialized by a session advisory lock held on a
// dedicated connection with NO open transaction, so a revoke can never land
// between the cutover's revoked-set read and its queued policy. Once a cutover is
// queued, revoke, unrevoke and unfence refuse: rollback is pre-cutover only.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatabaseConnection, DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { HostedProviderResponseError, HostedProviderUnavailableError, type HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { CreateError, inTransaction } from "./bootstrap-common.js";
import type { LogServiceClient } from "./log-service-client.js";
import { claim } from "./migration-provider.js";
import { RolloutRefused } from "./migration-rollout.js";
import { queueNextPolicy, type PolicyEmitter } from "./policy-outbox.js";
import { existingCloudCopy } from "./service-cloud-copy.js";

type Provider = Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationReplicas" | "legacyMigrationRevokeReplicas"
  | "legacyMigrationRestoreReplicas" | "legacyMigrationRevokedReplicas" | "legacyMigrationUnfence">;
interface Options {
  db: DatabasePool; token: string; provider?: Provider;
  /** Cutover policy only: the log head (base landed) and a best-effort wake. */
  log?: Pick<LogServiceClient, "head">; emitter?: Pick<PolicyEmitter, "drainCollection">;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u;
const NIL = "00000000-0000-0000-0000-000000000000";
const uuid = z.string().regex(UUID).refine(id => id !== NIL);
/** Canonical, sorted and unique as given: never normalized for the caller. */
const ids = (min: number) => z.array(uuid).min(min).max(1000).refine(list => list.every((id, i) => i === 0 || list[i - 1]! < id));
const binding = z.object({ owner_account: uuid, started_us: z.string().regex(/^[1-9][0-9]{0,23}(?![\s\S])/u), migration_id: uuid }).strict();
const bodies = {
  replicas: binding,
  "replicas/revoke": binding.extend({ replica_ids: ids(1) }).strict(),
  "replicas/unrevoke": binding.extend({ replica_ids: ids(1) }).strict(),
  unfence: binding,
  "cutover-policy": binding.extend({ revoked: ids(0), base_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
} as const;
type Kind = keyof typeof bodies;
type Binding = z.infer<typeof binding>;
const LOCK_CLASS = 20261012;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The presented claim must be the CURRENT one for this collection. */
async function bound(db: DatabaseQueryable, collection: string, presented: Binding, locked = false) {
  const current = await claim(db, collection, locked);
  if (current.account !== presented.owner_account || current.started_us !== presented.started_us) {
    throw new RolloutRefused("migration_claim_not_current", "The presented migration claim is not current.");
  }
  return current;
}

/** The provider source is fenced, uncut and on the presented run. */
async function onRun(provider: Provider, collection: string, presented: Binding, deadline: number) {
  const source = await provider.legacyMigrationDrain(collection, { deadline });
  if (source.collection_id !== collection) throw new RolloutRefused("migration_source_unavailable", "The source identity does not match.", 503);
  if (source.state !== "migrating" || source.retain_until !== null || !source.started_at || source.migration_id !== presented.migration_id) {
    throw new RolloutRefused("migration_run_not_current", "The provider run is not the presented fenced run.");
  }
}

interface QueuedCutover { legacyCollection: string; revoked: string[]; frozen: boolean | null }
async function queuedCutovers(db: DatabaseQueryable, collection: string): Promise<QueuedCutover[]> {
  const rows = (await db.query<{ ops: { ops: Array<Record<string, unknown>> } }>(
    `SELECT ops FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> '[{"op":"migration-cutover"}]'::jsonb ORDER BY id`,
    [collection])).rows;
  return rows.map(({ ops: { ops } }) => {
    const cut = ops.find(op => op.op === "migration-cutover")!, freeze = ops.find(op => op.op === "freeze");
    return { legacyCollection: String(cut.legacyCollection), revoked: [...(cut.revoked as string[])].sort(),
      frozen: freeze ? freeze.frozen === true : null };
  });
}
async function refuseQueuedCutover(db: DatabaseQueryable, collection: string) {
  if ((await queuedCutovers(db, collection)).length) throw new RolloutRefused("migration_cutover_queued", "The cutover policy is queued; rollback is pre-cutover only.");
}

/** Session advisory lock on a dedicated connection with no open transaction:
 * never waits (busy instead), always released before the connection returns. */
async function serialized<T>(db: DatabasePool, collection: string, run: () => Promise<T>): Promise<T> {
  const connection: DatabaseConnection = await db.connect();
  let locked = false, broken = false;
  try {
    locked = (await connection.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1::uuid::text, $2)) AS acquired", [collection, LOCK_CLASS])).rows[0]?.acquired === true;
    if (!locked) throw new RolloutRefused("busy", "Another migration step holds this collection; retry.", 503);
    return await run();
  } finally {
    if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1::uuid::text, $2))", [collection, LOCK_CLASS]).catch(() => { broken = true; });
    // A connection that may still hold the lock must never return to the pool.
    (connection.release as (destroy?: boolean) => void)(broken);
  }
}

async function step(kind: Kind, collection: string, body: Record<string, unknown>, options: Options & { provider: Provider }): Promise<unknown> {
  const presented = body as Binding, provider = options.provider, deadline = Date.now() + 25_000;
  await bound(options.db, collection, presented);
  await onRun(provider, collection, presented, deadline);
  if (kind === "replicas") {
    const listed = await provider.legacyMigrationReplicas(collection, { deadline });
    await onRun(provider, collection, presented, deadline);
    await bound(options.db, collection, presented);
    return listed;
  }
  return serialized(options.db, collection, async () => {
    if (kind === "cutover-policy") return cutoverPolicy(collection, body as Binding & { revoked: string[]; base_seq: number }, options, deadline);
    await refuseQueuedCutover(options.db, collection);
    const replicas = (body as { replica_ids?: string[] }).replica_ids ?? [];
    let result: unknown, metadata: Record<string, unknown>;
    if (kind === "unfence") {
      // `active` cannot restore: every run-owned revocation must be undone first.
      const owned = await provider.legacyMigrationRevokedReplicas(collection, { deadline });
      if (owned.migration_id !== presented.migration_id) throw new RolloutRefused("migration_run_not_current", "The provider run changed.");
      if (owned.revoked.length) throw new RolloutRefused("migration_replicas_revoked", "Restore the run's revoked replicas before unfencing.");
      await bound(options.db, collection, presented);
      result = await provider.legacyMigrationUnfence(collection, { deadline });
      metadata = { migration_id: presented.migration_id };
    } else {
      const revoke = kind === "replicas/revoke";
      result = revoke ? await provider.legacyMigrationRevokeReplicas(collection, replicas, { deadline })
        : await provider.legacyMigrationRestoreReplicas(collection, replicas, { deadline });
      // The effect used whatever run was current; a changed run is no verified outcome.
      await onRun(provider, collection, presented, deadline).catch(error => {
        throw error instanceof RolloutRefused ? new RolloutRefused("migration_source_unavailable", "No verified outcome on the presented run.", 503) : error;
      });
      metadata = { migration_id: presented.migration_id, ...(revoke ? { revoked: (result as { revoked: string[] }).revoked } : { restored: (result as { restored: string[] }).restored }) };
    }
    return inTransaction(options.db, async client => {
      const current = await bound(client, collection, presented, true);
      await refuseQueuedCutover(client, collection);
      await audit(client, current.account, `next_migration.${kind === "unfence" ? "unfence" : kind === "replicas/revoke" ? "revoke" : "unrevoke"}`, collection, metadata);
      return result;
    });
  });
}

/** Queue `policy[migration-cutover, freeze false]` naming this legacy collection
 * and EXACTLY the revocations the current provider run owns. Found, never twice:
 * the log refuses a second cutover, which would park the collection's queue. */
async function cutoverPolicy(collection: string, body: Binding & { revoked: string[]; base_seq: number },
  options: Options & { provider: Provider }, deadline: number) {
  const reply = (created: boolean) => ({ collection_id: collection, migration_id: body.migration_id, revoked: body.revoked, freeze: false, created });
  const existing = async (db: DatabaseQueryable) => {
    const queued = await queuedCutovers(db, collection);
    if (queued.length > 1 || queued.some(c => c.legacyCollection !== collection || c.frozen !== false || !sameSet(c.revoked, body.revoked))) {
      throw new RolloutRefused("migration_cutover_conflict", "A different cutover policy is already queued.");
    }
    return queued.length === 1;
  };
  if (await existing(options.db)) return reply(false);
  const owned = await options.provider.legacyMigrationRevokedReplicas(collection, { deadline });
  if (owned.migration_id !== body.migration_id) throw new RolloutRefused("migration_run_not_current", "The provider run changed.");
  if (!sameSet(owned.revoked, body.revoked)) throw new RolloutRefused("migration_revoked_set_mismatch", "The revoked set is not the run's current revocations.");
  if (!options.log) throw new RolloutRefused("migration_target_unavailable", "The policy log is unavailable.", 503);
  // Policy appends at or after the head: a head at the base puts the cutover after it.
  if ((await options.log.head(collection)).seq < body.base_seq) throw new RolloutRefused("migration_base_not_logged", "The migration base is not in the log yet.");
  const created = await inTransaction(options.db, async client => {
    const current = await bound(client, collection, body, true);
    if (!await existingCloudCopy(client, collection, current.account)) throw new RolloutRefused("migration_target_unavailable", "No SHADOW target for this collection.");
    // existingCloudCopy row-locks next_collections, so a concurrent find waits here.
    if (await existing(client)) return false;
    const queued = await queueNextPolicy(client, collection, [
      { op: "migration-cutover", legacyCollection: collection, revoked: body.revoked, cutoverAt: Date.now() },
      { op: "freeze", frozen: false }
    ]);
    if (!queued) throw new RolloutRefused("migration_target_unavailable", "No SHADOW target for this collection.");
    await audit(client, current.account, "next_migration.cutover_policy", collection,
      { migration_id: body.migration_id, revoked: body.revoked, base_seq: body.base_seq });
    return true;
  });
  if (created) await options.emitter?.drainCollection(collection).catch(() => undefined);
  return reply(created);
}

export function registerMigrationReplicaRoutes(app: FastifyInstance, options: Options): void {
  const params = z.object({ id: uuid }).strict(), empty = z.object({}).strict();
  for (const kind of Object.keys(bodies) as Kind[]) {
    app.post(`/internal/v1/next/migration/collections/:id/${kind}`, {
      bodyLimit: 64 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const token = bearerToken(request);
      if (!token || !safeEqual(token, options.token)) return reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
      const p = params.safeParse(request.params), body = bodies[kind].safeParse(request.body);
      if (!p.success || !body.success || !empty.safeParse(request.query).success) {
        return reply.code(400).send(apiError("invalid_request", "A canonical collection UUID, the current claim and provider run are required."));
      }
      try {
        if (!options.provider) throw new RolloutRefused("migration_source_unavailable", "The legacy provider is unavailable.", 503);
        return await step(kind, p.data.id, body.data, { ...options, provider: options.provider });
      } catch (error) {
        if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
        if (error instanceof CreateError) return reply.code(error.status).send(apiError(error.code, "No current migration target."));
        if (error instanceof HostedProviderResponseError || error instanceof HostedProviderUnavailableError || error instanceof z.ZodError) {
          return reply.code(503).send(apiError("migration_source_unavailable", "No verified provider outcome; retry the same collection."));
        }
        if (["55P03", "57014", "40P01", "40001"].includes(String((error as { code?: unknown })?.code))) return reply.code(503).send(apiError("busy", "Busy; retry."));
        throw error;
      }
    });
  }
}
