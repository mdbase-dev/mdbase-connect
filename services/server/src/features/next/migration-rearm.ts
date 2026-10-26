// Operator re-arm of a managed account whose attempt was verifiably routed back
// (docs/managed-account-migration.md). In one transaction under the account lock
// it retires the attempt's ledger events and detaches the member from its old
// cohort into next_migration_rearms, which keeps counting it there. The account
// is then an ordinary legacy account without a cohort: a new cohort, archive,
// acceptance and start make the next attempt. The operator command
// (next-migration-lab re-arm) first re-runs the idempotent route-back, requires
// every member's Worker idle and every legacy source settled active.
import { randomUUID } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { audit } from "../../platform/audit-events.js";
import { inTransaction } from "./bootstrap-common.js";
import { RolloutRefused } from "./migration-archive-profile.js";
import { ATTEMPT_EVENTS, CURRENT_ATTEMPT, lockManagedAccount, latchRefused, readIntents, readPhaseLatch, readQuietIntents,
  requireBoundHeldSet } from "./migration-managed-ledger.js";
import { codeOf, commands, labDeployment, type LabDeps, type LabOutcome, refusalDetails, routeBack } from "./migration-lab.js";
import { currentAttempt, workerIdle } from "./migration-lab-status.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

export interface Rearmed { account_id: string; previous_cohort: string; collection_ids: string[]; previous_started_at: string }

/** The account's latest re-arm while it is in no cohort (a replay), else null. */
export async function readRearmed(db: DatabaseQueryable, account: string): Promise<Rearmed | null> {
  const row = (await db.query<{ cohort: string; collections: string[]; started_at: Date }>(
    `SELECT r.cohort, r.collections::text[] AS collections, r.started_at FROM next_migration_rearms r
     WHERE r.account_id=$1 AND NOT EXISTS (SELECT 1 FROM next_migration_cohort_members m WHERE m.account_id=r.account_id)
     ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [account])).rows[0];
  return row ? { account_id: account, previous_cohort: row.cohort, collection_ids: [...row.collections].sort(),
    previous_started_at: new Date(row.started_at).toISOString() } : null;
}

/** `observed`: members whose Worker run under the attempt's hold the caller saw idle; any other dispatch intent must be quiet. */
export async function rearmAccount(client: DatabaseQueryable, account: string, collections: readonly string[],
  observed: readonly string[], actor: string, deployment: string): Promise<Rearmed> {
  // The start's lock order: account, member, cohort.
  await lockManagedAccount(client, account, deployment);
  const user = (await client.query<{ backend: string }>("SELECT account_backend AS backend FROM users WHERE id=$1", [account])).rows[0];
  if (user?.backend !== "legacy") throw new RolloutRefused("account_already_next", "The account already uses the next backend.");
  const member = (await client.query<{ cohort: string; started_at: Date | null; excluded: boolean }>(
    `SELECT cohort, started_at, terminal_excluded_at IS NOT NULL AS excluded FROM next_migration_cohort_members
     WHERE account_id=$1 FOR UPDATE`, [account])).rows[0];
  if (!member?.started_at) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
  if (member.excluded) throw new RolloutRefused("account_deletion_accepted", "The account's deletion was accepted.");
  await client.query("SELECT 1 FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [member.cohort]);
  const latch = await readPhaseLatch(client, account);
  if (latch === "cutover") throw latchRefused(latch);
  if (latch !== "route_back") throw new RolloutRefused("rearm_not_routed_back", "Only an attempt that was routed back can be re-armed.");
  const cutover = await client.query(
    `SELECT 1 FROM next_migration_collections WHERE account_id=$1
     UNION ALL SELECT 1 FROM next_migration_account_flips WHERE account_id=$1 LIMIT 1`, [account]);
  if (cutover.rows.length) throw new RolloutRefused("rearm_cutover_recorded", "A cutover or flip is recorded for the account.");
  const held = [...collections].sort();
  if (!held.length) throw new RolloutRefused("managed_inventory_empty", "No held hosted collections.");
  await requireBoundHeldSet(client, account, { collections: held });
  const quiet = new Set([...await readQuietIntents(client, account), ...observed]);
  const unknown = (await readIntents(client, account)).filter(id => !quiet.has(id));
  if (unknown.length) throw new RolloutRefused("worker_run_outcome_unknown", "A dispatch outcome is still unknown.", 409, { collection_ids: unknown });
  const retired = (await client.query<{ id: string }>(
    `SELECT id::text FROM audit_events WHERE user_id=$1 AND event_type=ANY($2::text[]) AND ${CURRENT_ATTEMPT()} ORDER BY id`,
    [account, [...ATTEMPT_EVENTS]])).rows.map(r => r.id);
  await client.query(
    `INSERT INTO next_migration_rearms(id,account_id,cohort,started_at,collections,retired_events,actor)
     VALUES($1,$2,$3,$4,$5::uuid[],$6::uuid[],$7)`, [randomUUID(), account, member.cohort, member.started_at, held, retired, actor]);
  // 0087's trigger: this deletion is not a membership change of the old cohort.
  await client.query("DELETE FROM next_migration_cohort_members WHERE account_id=$1", [account]);
  await audit(client, account, "next_migration.rearm", account,
    { previous_cohort: member.cohort, collections: held, retired_events: retired.length, actor });
  return { account_id: account, previous_cohort: member.cohort, collection_ids: held,
    previous_started_at: new Date(member.started_at).toISOString() };
}

export interface RearmConnect {
  /** The account's recorded re-arm while it is in no cohort. */
  rearmed(account: string): Promise<Rearmed | null>;
  rearm(account: string, collections: readonly string[], observed: readonly string[]): Promise<Rearmed>;
}

export function postgresRearm(options: { db: DatabasePool; actor: string; environment?: string;
  provider: Pick<HostedProviderClient, "legacyMigrationDrain"> }): RearmConnect {
  const { db, provider } = options, deployment = labDeployment(options.environment);
  return {
    rearmed: account => readRearmed(db, account),
    async rearm(account, collections, observed) {
      for (const collection of collections) {
        let source: Awaited<ReturnType<typeof provider.legacyMigrationDrain>>;
        try { source = await provider.legacyMigrationDrain(collection, { deadline: Date.now() + 25_000 }); } catch {
          throw new RolloutRefused("migration_source_unavailable", "No verified legacy provider outcome.", 503);
        }
        // The settled-active shape a completed rollback or unfence leaves (migration-replicas.ts).
        if (source.collection_id !== collection || source.state !== "active" || source.migration_id != null
            || source.started_at !== null || source.retain_until !== null) {
          throw new RolloutRefused("rearm_source_not_active", "Every legacy source must be active with no migration run.", 409, { collection_id: collection });
        }
      }
      return inTransaction(db, client => rearmAccount(client, account, collections, observed, options.actor, deployment));
    }
  };
}

/** Operator re-arm: re-runs the idempotent route-back, requires every member's Worker idle, then
 * the CP re-arm (fresh source reads, one locked transaction). A replay reports the recorded re-arm. */
export async function rearm(account: string, deps: LabDeps, cp: RearmConnect): Promise<LabOutcome> {
  const cmd = commands(account);
  const stop = (step: string, reason: string, extra: Record<string, unknown> = {}): LabOutcome => ({ stopped: { step, reason,
    inspect: cmd.inspect, resume: cmd.rearm, ...extra } });
  if (!UUID.test(account)) return stop("preflight", "invalid_request");
  try {
    const recorded = await cp.rearmed(account);
    if (recorded) return { done: { ...recorded, rearmed: true, already_rearmed: true } };
  } catch (error) { return stop("preflight", codeOf(error), refusalDetails(error)); }
  const routed = await routeBack(account, deps);
  if ("stopped" in routed) return { stopped: { ...routed.stopped, resume: cmd.rearm } };
  const collections = routed.done.collection_ids;
  if (!Array.isArray(collections) || !collections.length) return stop("route_back", "rearm_managed_only");
  let pre: Awaited<ReturnType<LabDeps["connect"]["preflight"]>>;
  try { pre = await deps.connect.preflight(account); } catch (error) { return stop("preflight", codeOf(error), refusalDetails(error)); }
  if (!("job" in pre)) return stop("preflight", "rearm_managed_only");
  const hold = pre.run?.backup_hold, observed: string[] = [];
  for (const collection of collections as string[]) {
    const reply = await deps.worker.status(collection);
    if (reply.kind !== "ok") return stop("worker_status", reply.kind === "refused" ? reply.code : reply.reason, { collection_id: collection });
    if (!workerIdle(reply.status)) return stop("worker_status", "rearm_worker_not_idle", { collection_id: collection });
    // This attempt's run settles its dispatch intent; any other intent must be quiet.
    if (hold !== undefined && currentAttempt(reply.status, pre.rearmed, hold).run?.backup_hold === hold) observed.push(collection);
  }
  try { return { done: { ...await cp.rearm(account, collections as string[], observed), rearmed: true } }; }
  catch (error) { return stop("rearm", codeOf(error), refusalDetails(error)); }
}
