// A managed account's durable driver ledger: control-plane audit events, no table.
// - `next_migration.start` (written only by startAccountMigration) selects the job;
// - `managed_run` binds the original held set, hold and operator pause intent;
// - `worker_run_intent` reserves ONE original Worker dispatch per collection;
// - `managed_cutover` / `managed_route_back` are the account's one-way phase latch.
// Writers hold the account lock (lockManagedAccount) for the whole transaction.
// Every read sees the current attempt only: a re-arm retires its predecessor's
// events (migration-rearm.ts).
// Each latch refuses the other under that lock, so the driver sends no resume
// after a route-back began, and route-back rolls nothing back once a resume
// could have been sent (whatever its reply), however members interleave.
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { RolloutRefused } from "./migration-archive-profile.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
/** SQL predicate: the `audit_events` row (alias `e`) belongs to the account's current attempt. */
export const CURRENT_ATTEMPT = (e = "audit_events") =>
  `NOT EXISTS (SELECT 1 FROM next_migration_rearms r WHERE r.account_id=${e}.user_id AND ${e}.id=ANY(r.retired_events))`;
export const BINDING = "two-phase-v1";
export const MANAGED_RUN = "next_migration.managed_run", WORKER_INTENT = "next_migration.worker_run_intent";
/** Every Worker run of the binding is in pause mode; `operator_stop_before_flip`
 * only decides whether lab-run returns at the shared barrier. */
export type ManagedRun = z.infer<typeof managedRunSchema>;
export const managedRunSchema = z.object({ binding: z.literal(BINDING), collections: z.array(z.string().regex(UUID)).min(1).max(16),
  backup_hold: z.string().regex(UUID), operator_stop_before_flip: z.boolean(), started_us: z.string().regex(/^[1-9][0-9]*$/u) }).strict();
// The unversioned binding meant "Worker pause mode = operator flag"; it is never reinterpreted.
const unversionedRunSchema = z.object({ collections: z.array(z.string()), backup_hold: z.string(), stop_before_flip: z.boolean(),
  started_us: z.string() }).strict();

export async function readManagedRun(db: DatabaseQueryable, account: string): Promise<ManagedRun | null> {
  const rows = (await db.query<{ metadata: unknown }>(
    "SELECT metadata FROM audit_events WHERE user_id=$1 AND event_type=$2 AND subject_id=$1::text AND " + CURRENT_ATTEMPT(), [account, MANAGED_RUN])).rows;
  if (!rows.length) return null;
  const parsed = managedRunSchema.safeParse(rows[0]!.metadata);
  if (rows.length === 1 && parsed.success) return parsed.data;
  if (rows.length === 1 && unversionedRunSchema.safeParse(rows[0]!.metadata).success)
    throw new RolloutRefused("managed_run_legacy_binding", "The original run binding predates the two-phase driver.");
  throw new RolloutRefused("managed_run_invalid", "The original managed run binding is unavailable.");
}

/** Under lockManagedAccount: bind the complete distinct held set, hold and pause intent once;
 * a later bind must present exactly the original. */
export async function bindManagedRun(client: DatabaseQueryable, account: string, collections: readonly string[], hold: string,
  operatorStop: boolean): Promise<void> {
  const started_us = await startedUs(client, account);
  // The same fresh whole-set admission as dispatch and the cutover latch, after the account lock.
  await requireBoundHeldSet(client, account, { collections });
  const expected = managedRunSchema.parse({ binding: BINDING, collections, backup_hold: hold,
    operator_stop_before_flip: operatorStop, started_us });
  const original = await readManagedRun(client, account);
  if (original) {
    if (JSON.stringify(original) !== JSON.stringify(expected)) throw new RolloutRefused("managed_run_conflict", "Resume the original collection set, hold and pause intent.");
  } else await audit(client, account, MANAGED_RUN, account, expected);
}

async function startedUs(client: DatabaseQueryable, account: string): Promise<string> {
  const member = (await client.query<{ started_us: string }>(
    `SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS started_us FROM next_migration_cohort_members
     WHERE account_id=$1 AND started_at IS NOT NULL AND terminal_excluded_at IS NULL`, [account])).rows[0];
  if (!member) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
  return member.started_us;
}

/** Members with a durable dispatch intent (a read; claimWorkerRun stays authoritative). */
export async function readIntents(db: DatabaseQueryable, account: string): Promise<string[]> {
  return (await db.query<{ id: string }>(`SELECT DISTINCT subject_id AS id FROM audit_events WHERE user_id=$1 AND event_type=$2 AND ${CURRENT_ATTEMPT()}
    ORDER BY subject_id`, [account, WORKER_INTENT])).rows.map(r => r.id);
}

/** An intent with no visible run stays UNKNOWN for longer than the Worker's held-ticket
 * retry deadline (300 s) plus the run request's 60 s timeout and a 60 s margin. */
const UNKNOWN_QUIET_SECONDS = 420;
/** Intents older than UNKNOWN_QUIET_SECONDS on the database clock. */
export async function readQuietIntents(db: DatabaseQueryable, account: string): Promise<string[]> {
  return (await db.query<{ id: string }>(
    `SELECT subject_id AS id FROM audit_events WHERE user_id=$1 AND event_type=$2 AND ${CURRENT_ATTEMPT()} GROUP BY subject_id
     HAVING max(created_at) < now() - make_interval(secs => $3) ORDER BY subject_id`, [account, WORKER_INTENT, UNKNOWN_QUIET_SECONDS])).rows.map(r => r.id);
}

/** Only the authenticated start transition writes this contract. Read every
 * matching event (bounded at two), never filter by the desired profile first.
 * Bind/claim/latch callers hold the same account lock as startAccountMigration. */
export async function recordedStartContract(db: DatabaseQueryable, account: string, deployment: string): Promise<"lab" | "managed"> {
  const starts = (await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'
       AND subject_id=$1::text AND ${CURRENT_ATTEMPT()} LIMIT 2`, [account])).rows;
  const metadata = starts[0]?.metadata;
  const refuse = () => new RolloutRefused("start_profile_invalid", "Exactly one recognized recorded migration start is required.");
  if (starts.length !== 1 || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw refuse();
  if (!Object.hasOwn(metadata, "profile")) return "managed";
  // The fixture profile is admissible only in a LAB (or explicit local) deployment.
  if ((metadata as { profile: unknown }).profile === "lab-fixture-v1" && deployment === "lab") return "lab";
  throw refuse();
}

/** Inside a transaction: take the account lock, then require an ordinary archived start.
 * NO KEY UPDATE still serializes with start, flip, topology, hosted creation and
 * deletion, but not with FK KEY SHARE checks of writers that locked a hosted row
 * first (e.g. hosted approval), so those cannot deadlock here. */
export async function lockManagedAccount(client: DatabaseQueryable, account: string, deployment: string): Promise<void> {
  await client.query("SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE", [account]);
  if (await recordedStartContract(client, account, deployment) !== "managed")
    throw new RolloutRefused("start_profile_invalid", "The recorded start is not an ordinary archived migration.");
}

export type PhaseLatch = "cutover" | "route_back";
const LATCH = { cutover: "next_migration.managed_cutover", route_back: "next_migration.managed_route_back" } as const;
/** Every ledger event of one attempt; a re-arm retires them together. */
export const ATTEMPT_EVENTS = ["next_migration.start", MANAGED_RUN, WORKER_INTENT, ...Object.values(LATCH)] as const;
export const latchRefused = (latch: PhaseLatch) => latch === "cutover"
  ? new RolloutRefused("managed_cutover_started", "Phase 2 began; the account only moves forward.")
  : new RolloutRefused("managed_route_back_started", "Route-back began; only route-back continues.");

/** The account's one-way phase: null until phase 2's first resume or route-back's first rollback. */
export async function readPhaseLatch(db: DatabaseQueryable, account: string): Promise<PhaseLatch | null> {
  const rows = (await db.query<{ event_type: string }>(
    `SELECT DISTINCT event_type FROM audit_events WHERE user_id=$1 AND subject_id=$1::text AND event_type=ANY($2::text[]) AND ${CURRENT_ATTEMPT()}`,
    [account, Object.values(LATCH)])).rows;
  if (rows.length > 1) throw new RolloutRefused("managed_phase_inconsistent", "Both phase latches are recorded.");
  return !rows.length ? null : rows[0]!.event_type === LATCH.cutover ? "cutover" : "route_back";
}

/** The original run's hold on a fence: called after the caller's lock on the account row,
 * this fresh read refuses once route-back began, so no late original run fences a member
 * route-back restores. Rollback, unfence and reads never call it. */
export async function refuseRoutedBack(client: DatabaseQueryable, account: string, collection: string): Promise<void> {
  if (await readPhaseLatch(client, account) === "route_back") throw new RolloutRefused("managed_route_back_started",
    "Route-back began; the original run may not fence.", 409, { collection_id: collection, predicate: "route_back_latch" });
}

/** Under lockManagedAccount, a fresh read before binding, each dispatch and the cutover latch:
 * the started, unexcluded legacy account still holds exactly the bound set, every member settled.
 * The held rows stay share-locked until the caller commits (bind's original lock order). */
export async function requireBoundHeldSet(client: DatabaseQueryable, account: string, run: { collections: readonly string[] }): Promise<void> {
  const rows = (await client.query<{ id: string; predicate: string | null }>(
    `SELECT h.id::text AS id, CASE WHEN u.account_backend<>'legacy' OR m.started_at IS NULL OR m.terminal_excluded_at IS NOT NULL THEN 'account'
       WHEN EXISTS (SELECT 1 FROM next_collection_deletion_facts d WHERE d.collection_id=h.id) THEN 'deleted'
       WHEN h.quarantined_at IS NOT NULL THEN 'quarantined' WHEN h.authority_state<>'active' THEN 'authority_other' END AS predicate
     FROM hosted_collections h JOIN users u ON u.id=h.user_id LEFT JOIN next_migration_cohort_members m ON m.account_id=u.id
     WHERE h.user_id=$1 AND h.authority_state<>'transferred' AND (h.quarantined_at IS NULL OR h.quarantine_reason IS DISTINCT FROM 'provider_collection_missing') ORDER BY h.id FOR SHARE OF h`, [account])).rows;
  const ids = rows.map(r => r.id);
  if (ids.join() !== run.collections.join()) throw new RolloutRefused("collections_mismatch", "The held set changed since the original run.", 409,
    { added: ids.filter(id => !run.collections.includes(id)), missing: run.collections.filter(id => !ids.includes(id)) });
  const unsettled = rows.filter(r => r.predicate).map(r => ({ collection_id: r.id, predicate: r.predicate }));
  if (unsettled.length) throw new RolloutRefused("collections_unsettled", "Every held hosted collection must remain eligible.", 409, { unsettled });
}

/** Under lockManagedAccount: record `phase` unless the other phase is recorded. Idempotent. */
export async function latchPhase(client: DatabaseQueryable, account: string, phase: PhaseLatch, run: ManagedRun): Promise<void> {
  const current = await readPhaseLatch(client, account);
  if (current && current !== phase) throw latchRefused(current);
  if (!current) await audit(client, account, LATCH[phase], account, { binding: run.binding, backup_hold: run.backup_hold, started_us: run.started_us });
}

/** Under lockManagedAccount: route-back of a started account never bound (so nothing dispatched)
 * latches on its recorded start and exact eligible held set. No hold or binding is invented. */
export async function latchUnboundRouteBack(client: DatabaseQueryable, account: string, collections: readonly string[]): Promise<void> {
  await requireBoundHeldSet(client, account, { collections });
  const current = await readPhaseLatch(client, account);
  if (current === "cutover") throw latchRefused(current);
  if (!current) await audit(client, account, LATCH.route_back, account, { started_us: await startedUs(client, account), collections });
}
