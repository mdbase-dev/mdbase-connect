// Migration-token fronts for the fence-first Driver's replica, rollback and
// cutover-policy and member-policy steps. Every route is bound to the presented migration claim
// (owner account + start) AND the provider run its fence settled, and rechecks
// both around every await and inside the final transaction. Provider bodies are
// passed through unchanged for the native settlement mirror.
//
// Effects on one collection are serialized by a session advisory lock held on a
// dedicated connection with NO open transaction, so a revoke can never land
// between the cutover's revoked-set read and its queued policy. Once a cutover is
// queued, revoke, unrevoke and unfence refuse: rollback is pre-cutover only.
// The cutover also refuses until the target's queued members match Connect's.
//
// Rollback fronts the provider's receipted pre-cutover rollback for the native
// rollback adapter, which holds no provider credentials. Connect records the
// exact binding before the first dispatch; a retry or receipt read must present
// that same binding, and the provider receipt is returned only after its echo
// of the binding is verified (hosted-provider-legacy-migration.ts).
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
import { migrationMemberPlan, queueMigrationMembers } from "./migration-members.js";
import { claim } from "./migration-provider.js";
import { RolloutRefused } from "./migration-rollout.js";
import { queueNextPolicy, type PolicyEmitter } from "./policy-outbox.js";
import { existingCloudCopy } from "./service-cloud-copy.js";

type Provider = Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationReplicas" | "legacyMigrationRevokeReplicas"
  | "legacyMigrationRestoreReplicas" | "legacyMigrationRevokedReplicas" | "legacyMigrationUnfence"
  | "legacyMigrationRollback" | "legacyMigrationRollbackReceipt">;
interface Options {
  db: DatabasePool; token: string; provider?: Provider;
  /** Cutover and member policy: the log head (base landed) and a best-effort wake. */
  log?: Pick<LogServiceClient, "head">; emitter?: Pick<PolicyEmitter, "drainCollection">;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![\s\S])/u;
const NIL = "00000000-0000-0000-0000-000000000000";
const uuid = z.string().regex(UUID).refine(id => id !== NIL);
/** Canonical, sorted and unique as given: never normalized for the caller. */
const ids = (min: number) => z.array(uuid).min(min).max(1000).refine(list => list.every((id, i) => i === 0 || list[i - 1]! < id));
const binding = z.object({ owner_account: uuid, started_us: z.string().regex(/^[1-9][0-9]{0,23}(?![\s\S])/u), migration_id: uuid }).strict();
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rollbackBody = binding.extend({
  fixed_head: counter, driver_id: uuid, action_id: uuid, replica_ids: ids(0),
  /** Only to re-read a recorded rollback; it must equal that binding's epoch. */
  authority_epoch: counter.min(1).optional()
}).strict();
const bodies = {
  replicas: binding,
  "replicas/revoke": binding.extend({ replica_ids: ids(1) }).strict(),
  "replicas/unrevoke": binding.extend({ replica_ids: ids(1) }).strict(),
  unfence: binding,
  "members-policy": binding,
  "cutover-policy": binding.extend({ revoked: ids(0), base_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  rollback: rollbackBody,
  "rollback-receipt": rollbackBody
} as const;
type Kind = keyof typeof bodies;
type Binding = z.infer<typeof binding>;
type RollbackBody = z.infer<typeof rollbackBody>;
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
  if (kind === "rollback" || kind === "rollback-receipt") return rollback(kind, collection, body as RollbackBody, options, deadline);
  await onRun(provider, collection, presented, deadline);
  if (kind === "replicas") {
    const listed = await provider.legacyMigrationReplicas(collection, { deadline });
    await onRun(provider, collection, presented, deadline);
    await bound(options.db, collection, presented);
    return listed;
  }
  return serialized(options.db, collection, async () => {
    if (kind === "cutover-policy") return cutoverPolicy(collection, body as Binding & { revoked: string[]; base_seq: number }, options, deadline);
    if (kind === "members-policy") return membersPolicy(collection, presented, options);
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

const ROLLBACK_INTENT = "next_migration.rollback_intent", ROLLBACK_DONE = "next_migration.rollback";
type ProviderBinding = Parameters<Provider["legacyMigrationRollback"]>[1];
const providerBinding = (b: RollbackBody, epoch: number): ProviderBinding => ({ owner_account_id: b.owner_account, provider_migration_id: b.migration_id,
  authority_epoch: epoch, fixed_head: b.fixed_head, driver_id: b.driver_id, action_id: b.action_id, replica_ids: b.replica_ids });
const sameBinding = (a: Record<string, unknown>, b: ProviderBinding) => (Object.keys(b) as Array<keyof ProviderBinding>)
  .every(key => JSON.stringify(a[key]) === JSON.stringify(b[key])) && Object.keys(a).length === Object.keys(b).length;

/** The collection's current provider authority epoch, as Connect binds it: never
 * caller-supplied, and never assumed. */
async function currentEpoch(db: DatabaseQueryable, collection: string, locked = false) {
  const epoch = (await db.query<{ epoch: string }>(
    `SELECT authority_epoch::text AS epoch FROM hosted_collections WHERE id=$1${locked ? " FOR SHARE" : ""}`, [collection])).rows[0]?.epoch;
  if (!epoch || !/^[1-9][0-9]{0,15}$/u.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw new RolloutRefused("migration_source_not_current", "No current hosted authority epoch.");
  }
  return Number(epoch);
}
const epochMoved = () => new RolloutRefused("migration_epoch_not_current", "The collection's authority epoch changed since the rollback was recorded.");

/** Whether Connect recorded this exact binding for the run; any other binding
 * for the same run (another driver, action, epoch, head or scope) refuses. */
async function intended(db: DatabaseQueryable, collection: string, account: string, input: ProviderBinding) {
  const rows = (await db.query<{ binding: Record<string, unknown> }>(
    `SELECT metadata->'binding' AS binding FROM audit_events WHERE user_id=$1 AND event_type=$2 AND subject_id=$3 AND metadata->>'migration_id'=$4`,
    [account, ROLLBACK_INTENT, collection, input.provider_migration_id])).rows;
  for (const { binding: recorded } of rows) {
    if (recorded && typeof recorded === "object" && sameBinding(recorded, input)) continue;
    if (recorded && typeof recorded === "object" && sameBinding({ ...recorded, authority_epoch: input.authority_epoch }, input)) throw epochMoved();
    throw new RolloutRefused("migration_rollback_binding_conflict", "A different rollback binding was recorded for this run.");
  }
  return rows.length > 0;
}

/** Atomic receipted pre-cutover rollback, or a read of its receipt. The first
 * dispatch needs the presented fenced run and a scope covering every revocation
 * the run owns; Connect adds the current epoch and records the binding before
 * dispatch. A replay or read presents the rest of that binding again. */
async function rollback(kind: "rollback" | "rollback-receipt", collection: string, body: RollbackBody,
  options: Options & { provider: Provider }, deadline: number) {
  return serialized(options.db, collection, async () => {
    await refuseQueuedCutover(options.db, collection);
    const input = providerBinding(body, await currentEpoch(options.db, collection));
    const known = await intended(options.db, collection, body.owner_account, input);
    // A presented epoch names a recorded original binding; it is never authority for a fresh dispatch.
    if ((kind === "rollback-receipt" || body.authority_epoch !== undefined) && !known) {
      throw new RolloutRefused("migration_rollback_unknown", "No rollback with this exact binding was dispatched.", 404);
    }
    if (body.authority_epoch !== undefined && body.authority_epoch !== input.authority_epoch) {
      throw new RolloutRefused("migration_rollback_binding_conflict", "The presented epoch is not the recorded binding's.");
    }
    if (!known) {
      await onRun(options.provider, collection, body, deadline);
      const owned = await options.provider.legacyMigrationRevokedReplicas(collection, { deadline });
      if (owned.migration_id !== body.migration_id) throw new RolloutRefused("migration_run_not_current", "The provider run changed.");
      if (owned.revoked.some(id => !body.replica_ids.includes(id))) {
        throw new RolloutRefused("migration_revoked_set_mismatch", "The rollback scope must cover every revocation the run owns.");
      }
      await inTransaction(options.db, async client => {
        const current = await bound(client, collection, body, true);
        await refuseQueuedCutover(client, collection);
        if (await currentEpoch(client, collection, true) !== input.authority_epoch) throw epochMoved();
        if (await intended(client, collection, current.account, input)) return;
        await audit(client, current.account, ROLLBACK_INTENT, collection, { migration_id: body.migration_id, binding: input });
      });
    }
    let receipt;
    try {
      receipt = kind === "rollback" ? await options.provider.legacyMigrationRollback(collection, input, { deadline })
        : await options.provider.legacyMigrationRollbackReceipt(collection, input, { deadline });
    } catch (error) {
      if (error instanceof HostedProviderResponseError && error.code === "legacy_rollback_binding_conflict") {
        throw new RolloutRefused("migration_rollback_binding_conflict", "The provider source or receipt does not match this binding.");
      }
      if (error instanceof HostedProviderResponseError && error.code === "legacy_rollback_receipt_unknown") {
        throw new RolloutRefused("migration_rollback_unknown", "The provider holds no receipt for this exact binding.", 404);
      }
      throw error;
    }
    if (receipt.collection_id !== collection || !sameBinding(receipt.binding, input) || receipt.restored_ids.some(id => !input.replica_ids.includes(id))) {
      throw new RolloutRefused("migration_source_unavailable", "The provider receipt does not echo this binding.", 503);
    }
    // Evidence of the provider's receipt, once; a repeated read records nothing.
    return inTransaction(options.db, async client => {
      const current = await bound(client, collection, body, true);
      const recorded = await client.query(
        "SELECT 1 FROM audit_events WHERE user_id=$1 AND event_type=$2 AND subject_id=$3 AND metadata->>'migration_id'=$4 LIMIT 1",
        [current.account, ROLLBACK_DONE, collection, body.migration_id]);
      if (!recorded.rows.length) {
        await audit(client, current.account, ROLLBACK_DONE, collection,
          { migration_id: body.migration_id, binding: input, restored_ids: receipt.restored_ids, recorded_at: receipt.recorded_at });
      }
      return receipt;
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
    // Members follow the cutover in no log: the native comparison runs before Route.
    if ((await migrationMemberPlan(client, collection, current.account)).ops.length) {
      throw new RolloutRefused("migration_members_not_queued", "Queue the collection's current members before the cutover.");
    }
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

/** Queue a member policy item for each current member the SHADOW target's queue
 * does not already hold, and remove any it holds that is no longer a member.
 * Returns the exact owner-inclusive member map for the native comparison. */
async function membersPolicy(collection: string, body: Binding, options: Options) {
  const result = await inTransaction(options.db, async client => {
    const current = await bound(client, collection, body, true);
    await refuseQueuedCutover(client, collection);
    const shadow = await existingCloudCopy(client, collection, current.account)
      && (await client.query("SELECT 1 FROM next_collections WHERE collection_id=$1 AND runtime='shadow'", [collection])).rows.length === 1;
    if (!shadow) throw new RolloutRefused("migration_target_unavailable", "No SHADOW target for this collection.");
    const plan = await migrationMemberPlan(client, collection, current.account);
    if (!plan.ownerQueued) throw new RolloutRefused("migration_target_unavailable", "The target's genesis owner is not queued.");
    await queueMigrationMembers(client, collection, plan.ops);
    const set = plan.ops.filter(op => op.op === "member-set").length;
    if (plan.ops.length) {
      await audit(client, current.account, "next_migration.members_policy", collection,
        { migration_id: body.migration_id, set, removed: plan.ops.length - set });
    }
    return { collection_id: collection, migration_id: body.migration_id, members: plan.members, queued: plan.ops.length };
  });
  if (result.queued) await options.emitter?.drainCollection(collection).catch(() => undefined);
  return result;
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
