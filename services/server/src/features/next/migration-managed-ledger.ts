// A managed account's durable driver ledger: control-plane audit events, no table.
// - `next_migration.start` (written only by startAccountMigration) selects the job;
// - `managed_run` binds the original held set, hold and operator pause intent;
// - `worker_run_intent` reserves ONE original Worker dispatch per collection;
// - `managed_cutover` / `managed_route_back` are the account's one-way phase latch.
// Writers hold the account lock (lockManagedAccount) for the whole transaction.
// Each latch refuses the other under that lock, so the driver sends no resume
// after a route-back began, and route-back rolls nothing back once a resume
// could have been sent (whatever its reply), however members interleave.
import { z } from "zod";
import type { DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { RolloutRefused } from "./migration-archive-profile.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
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
    "SELECT metadata FROM audit_events WHERE user_id=$1 AND event_type=$2 AND subject_id=$1::text", [account, MANAGED_RUN])).rows;
  if (!rows.length) return null;
  const parsed = managedRunSchema.safeParse(rows[0]!.metadata);
  if (rows.length === 1 && parsed.success) return parsed.data;
  if (rows.length === 1 && unversionedRunSchema.safeParse(rows[0]!.metadata).success)
    throw new RolloutRefused("managed_run_legacy_binding", "The original run binding predates the two-phase driver.");
  throw new RolloutRefused("managed_run_invalid", "The original managed run binding is unavailable.");
}

/** Members with a durable dispatch intent (a read; claimWorkerRun stays authoritative). */
export async function readIntents(db: DatabaseQueryable, account: string): Promise<string[]> {
  return (await db.query<{ id: string }>("SELECT DISTINCT subject_id AS id FROM audit_events WHERE user_id=$1 AND event_type=$2 ORDER BY subject_id",
    [account, WORKER_INTENT])).rows.map(r => r.id);
}

/** Only the authenticated start transition writes this contract. Read every
 * matching event (bounded at two), never filter by the desired profile first.
 * Bind/claim/latch callers hold the same account lock as startAccountMigration. */
export async function recordedStartContract(db: DatabaseQueryable, account: string, deployment: string): Promise<"lab" | "managed"> {
  const starts = (await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_events WHERE user_id=$1 AND event_type='next_migration.start'
       AND subject_id=$1::text LIMIT 2`, [account])).rows;
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
export const latchRefused = (latch: PhaseLatch) => latch === "cutover"
  ? new RolloutRefused("managed_cutover_started", "Phase 2 began; the account only moves forward.")
  : new RolloutRefused("managed_route_back_started", "Route-back began; only route-back continues.");

/** The account's one-way phase: null until phase 2's first resume or route-back's first rollback. */
export async function readPhaseLatch(db: DatabaseQueryable, account: string): Promise<PhaseLatch | null> {
  const rows = (await db.query<{ event_type: string }>(
    "SELECT DISTINCT event_type FROM audit_events WHERE user_id=$1 AND subject_id=$1::text AND event_type=ANY($2::text[])",
    [account, Object.values(LATCH)])).rows;
  if (rows.length > 1) throw new RolloutRefused("managed_phase_inconsistent", "Both phase latches are recorded.");
  return !rows.length ? null : rows[0]!.event_type === LATCH.cutover ? "cutover" : "route_back";
}

/** Under lockManagedAccount: record `phase` unless the other phase is recorded. Idempotent. */
export async function latchPhase(client: DatabaseQueryable, account: string, phase: PhaseLatch, run: ManagedRun): Promise<void> {
  const current = await readPhaseLatch(client, account);
  if (current && current !== phase) throw latchRefused(current);
  if (!current) await audit(client, account, LATCH[phase], account, { binding: run.binding, backup_hold: run.backup_hold, started_us: run.started_us });
}
