// Staged migration of hosted collections to mdbase-next.
//
// - Operators release cohorts; there is no user opt-in. One global pause stops
//   accounts from *starting*: `POST …/start` is the atomic claim and refuses while
//   paused. A started account is never stranded: `in-progress` ignores the pause,
//   and its cutovers and flip are allowed while paused.
// - Each hosted collection's cutover is recorded (`POST …/collections/:id/cutover`)
//   only for a started account and a control-plane cloud copy with the preserved
//   ID owned by that account. The record routes it (`next_collections.runtime =
//   'next'`).
// - The flip is the only setter of `users.account_backend = 'next'`
//   (docs/account-backend.md). It requires a started account, every current hosted
//   collection settled and cut over, and an evidence digest that this server
//   recomputes from those cutover records.
// - A deleted account is terminal: its rows cascade away and
//   every route answers not found; nothing restores it.
// - Routes accept only the dedicated migration token; every change is audited.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import { apiError } from "../../platform/http-errors.js";
import { bearerToken } from "../../platform/request-authentication.js";
import { safeEqual } from "../../security.js";
import { drainDeferredAccountDeletions } from "../../account-management.js";
import { completeMigrationBatch, releaseDeferredDeletions } from "./migration-topology.js";

export interface RolloutState { paused: boolean; reason: string; changed_by: string; changed_at: string }

export interface AccountMigrationView {
  account_id: string;
  backend: "legacy" | "next";
  cohort: string | null;
  released: boolean;
  started: boolean;
  terminal_excluded: boolean;
  paused: boolean;
  /** Hosted collections the account holds now (transferred excluded), by id. */
  hosted_collections: string[];
  /** Of those, mid import or authority transfer: the account cannot flip yet. */
  unsettled_collections: string[];
  /** Of those, cut over to mdbase-next. */
  cut_over_collections: string[];
}

export class RolloutRefused extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

// Canonical scalars must consume the entire string without normalization.
const COHORT_NAME = /^[a-z0-9][a-z0-9-]{0,62}(?![\s\S])/;
const HEX64 = /^[0-9a-f]{64}(?![\s\S])/;
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/;
const DAY_MS = 86_400_000;

const decimal = (max: bigint, positive = false) => z.string().max(20).refine((v) =>
  /^(0|[1-9][0-9]*)(?![\s\S])/.test(v) && BigInt(v) <= max && (!positive || BigInt(v) > 0n));
const millisecondTime = z.string().length(24).refine((v) => {
  if (!UTC_MILLISECONDS.test(v)) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
});
const archiveBindingSchema = z.object({
  batch_id: z.string().regex(COHORT_NAME),
  membership_revision: decimal(9_223_372_036_854_775_807n, true),
  membership_digest: z.string().regex(HEX64),
  membership_changed_at: millisecondTime
}).strict();
const verifiedArchiveSchema = z.object({
  schema: z.literal("mdbase-recovery-set/v4"),
  environment: z.enum(["production", "staging"]),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](?![\s\S])/),
  prefix: z.string().max(128).regex(/^(staging|production)\/20[0-9]{2}\/(0[1-9]|1[0-2])\/(0[1-9]|[12][0-9]|3[01])\/[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/),
  backup_id: z.string().max(80).regex(/^[a-z0-9][a-z0-9-]{0,79}(?![\s\S])/),
  complete_sha256: z.string().regex(HEX64),
  manifest_sha256: z.string().regex(HEX64),
  source_commit: z.string().regex(/^[0-9a-f]{40}(?![\s\S])/),
  migration_batch: archiveBindingSchema,
  archive_created_at: millisecondTime,
  archive_completed_at: millisecondTime,
  retention: z.object({
    mode: z.literal("GOVERNANCE"), days: z.literal(120), retain_until: millisecondTime,
    inventory_digest: z.string().regex(HEX64), count: decimal(18_446_744_073_709_551_615n, true)
  }).strict()
}).strict();
export type ArchiveBinding = z.infer<typeof archiveBindingSchema>;
type VerifiedBatchArchive = z.infer<typeof verifiedArchiveSchema>;

/** Private CP-owned inventory only; never return account/collection lists in the header. */
export function migrationMembershipDigest(inventory: readonly (readonly [string, readonly string[]])[]): string {
  const accounts = new Set<string>(), collections = new Set<string>();
  const uuid = (id: string) => UUID_CANONICAL.test(id) && id !== "00000000-0000-0000-0000-000000000000";
  const rows = inventory.map(([account, owned]) => {
    if (!uuid(account) || accounts.has(account)) throw new RolloutRefused("backup_missing", "Invalid batch membership.");
    accounts.add(account);
    const ids = owned.map((id) => {
      if (!uuid(id) || collections.has(id)) throw new RolloutRefused("backup_missing", "Invalid hosted collection coverage.");
      collections.add(id); return id;
    }).sort();
    return [account, ids] as const;
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return createHash("sha256").update("mdbase-legacy-batch-membership/v1\n", "ascii").update(JSON.stringify(rows), "utf8").digest("hex");
}

/** Structural decoding is NOT signature/retention verification; only the dedicated trusted verifier route may accept this result. */
export function parseVerifiedBatchArchive(body: unknown): VerifiedBatchArchive {
  const parsed = verifiedArchiveSchema.safeParse(body);
  if (!parsed.success) throw new RolloutRefused("backup_missing", "A complete verified v4 archive result is required.");
  const result = parsed.data;
  if (result.prefix.split("/")[0] !== result.environment || result.prefix.split("/").at(-1) !== result.backup_id) {
    throw new RolloutRefused("backup_missing", "Archive identity does not match.");
  }
  return result;
}

/** All times come from the verifier or trusted PostgreSQL clock, never retry/acceptance age. */
export function requireFreshBatchArchive(result: VerifiedBatchArchive, current: ArchiveBinding, acceptedAt: string, now: string, environment: string): void {
  const fail = () => { throw new RolloutRefused("backup_missing", "Current fresh batch archive evidence is required."); };
  if (!millisecondTime.safeParse(acceptedAt).success || !millisecondTime.safeParse(now).success || result.environment !== environment) fail();
  const binding = archiveBindingSchema.safeParse(current);
  if (!binding.success) return fail();
  if (result.migration_batch.batch_id !== binding.data.batch_id
      || result.migration_batch.membership_revision !== binding.data.membership_revision
      || result.migration_batch.membership_digest !== binding.data.membership_digest
      || result.migration_batch.membership_changed_at !== binding.data.membership_changed_at) fail();
  const created = Date.parse(result.archive_created_at), completed = Date.parse(result.archive_completed_at);
  const accepted = Date.parse(acceptedAt), clock = Date.parse(now), changed = Date.parse(current.membership_changed_at);
  if (!(changed <= created && created <= completed && completed <= accepted && accepted <= clock)
      || clock - created >= 7 * DAY_MS || Date.parse(result.retention.retain_until) < completed + 120 * DAY_MS) fail();
}

async function archiveClock(client: DatabaseQueryable): Promise<string> {
  const row = (await client.query<{ now: Date }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS now")).rows[0];
  if (!row) throw new Error("Trusted archive clock is unavailable.");
  return new Date(row.now).toISOString();
}

/** Caller holds this transaction's batch lock through inventory/currentness checks. */
async function readArchiveBinding(client: DatabaseQueryable, name: string): Promise<{ binding: ArchiveBinding; frozenAt: string }> {
  const batch = (await client.query<{ revision: string; changed: Date; frozen_at: Date | null }>(
    `SELECT membership_revision::text AS revision, membership_changed_at AS changed, frozen_at
     FROM next_migration_cohorts WHERE name = $1 FOR UPDATE`, [name]
  )).rows[0];
  if (!batch) throw new RolloutRefused("cohort_not_found", "Migration cohort not found.", 404);
  if (batch.frozen_at === null) throw new RolloutRefused("backup_missing", "Migration topology must be frozen before archive capture.");
  const members = (await client.query<{ account: string; collection: string | null }>(
    `SELECT m.account_id::text AS account, h.id::text AS collection
     FROM next_migration_cohort_members m
     LEFT JOIN hosted_collections h ON h.user_id = m.account_id AND h.authority_state <> 'transferred'
     WHERE m.cohort = $1 ORDER BY m.account_id, h.id`, [name]
  )).rows;
  const inventory = new Map<string, string[]>();
  for (const row of members) {
    const ids = inventory.get(row.account) ?? [];
    if (row.collection !== null) ids.push(row.collection);
    inventory.set(row.account, ids);
  }
  const binding = archiveBindingSchema.safeParse({
    batch_id: name, membership_revision: batch.revision,
    membership_digest: migrationMembershipDigest([...inventory]),
    membership_changed_at: new Date(batch.changed).toISOString()
  });
  if (!binding.success) throw new RolloutRefused("backup_missing", "Invalid current batch binding.");
  return { binding: binding.data, frozenAt: new Date(batch.frozen_at).toISOString() };
}

export async function cohortArchiveBinding(db: DatabasePool, name: string): Promise<ArchiveBinding> {
  return (await inTransaction(db, (client) => readArchiveBinding(client, name))).binding;
}

/** Dedicated ONE-verifier admin transition only; no caller data is cryptographic authority. */
export async function acceptCohortArchive(db: DatabasePool, name: string, body: unknown, environment: string | undefined): Promise<{ accepted_at: string }> {
  const result = parseVerifiedBatchArchive(body);
  const acceptance = await inTransaction(db, async (client) => {
    const { binding, frozenAt } = await readArchiveBinding(client, name);
    if (Date.parse(result.archive_created_at) < Date.parse(frozenAt)) {
      throw new RolloutRefused("backup_missing", "Archive capture must follow the topology freeze.");
    }
    const now = await archiveClock(client);
    requireFreshBatchArchive(result, binding, now, now, environment ?? "");
    const old = (await client.query<{ verified_result: unknown; accepted_at: Date }>(
      `SELECT verified_result, accepted_at FROM next_migration_archive_acceptances
       WHERE cohort = $1 AND membership_revision = $2::bigint`, [name, binding.membership_revision]
    )).rows[0];
    if (old) {
      if (JSON.stringify(parseVerifiedBatchArchive(old.verified_result)) !== JSON.stringify(result)) {
        throw new RolloutRefused("backup_conflict", "Another archive was accepted for this batch revision.");
      }
      const accepted = new Date(old.accepted_at).toISOString();
      requireFreshBatchArchive(result, binding, accepted, now, environment ?? "");
      await completeMigrationBatch(client, name, binding.membership_revision, new Date(frozenAt));
      return { accepted_at: accepted };
    }
    await client.query(
      `INSERT INTO next_migration_archive_acceptances (cohort, membership_revision, verified_result, accepted_at)
       VALUES ($1, $2::bigint, $3::jsonb, $4::timestamptz)`, [name, binding.membership_revision, JSON.stringify(result), now]
    );
    await audit(client, null, "next_migration.backup_accept", null,
      { cohort: name, membership_revision: binding.membership_revision, complete_sha256: result.complete_sha256 });
    await completeMigrationBatch(client, name, binding.membership_revision, new Date(frozenAt));
    return { accepted_at: now };
  });
  await drainDeferredAccountDeletions(db);
  return acceptance;
}

async function requireCurrentCohortArchive(client: DatabaseQueryable, name: string, environment: string | undefined): Promise<void> {
  const { binding, frozenAt } = await readArchiveBinding(client, name);
  const accepted = (await client.query<{ verified_result: unknown; accepted_at: Date }>(
    `SELECT verified_result, accepted_at FROM next_migration_archive_acceptances
     WHERE cohort = $1 AND membership_revision = $2::bigint`, [name, binding.membership_revision]
  )).rows[0];
  if (!accepted) throw new RolloutRefused("backup_missing", "A verified current batch archive is required.");
  const result = parseVerifiedBatchArchive(accepted.verified_result);
  if (Date.parse(result.archive_created_at) < Date.parse(frozenAt)) {
    throw new RolloutRefused("backup_missing", "Archive capture must follow the current topology freeze.");
  }
  requireFreshBatchArchive(result, binding,
    new Date(accepted.accepted_at).toISOString(), await archiveClock(client), environment ?? "");
}

export async function rolloutState(db: DatabaseQueryable): Promise<RolloutState> {
  const row = (await db.query<{ paused: boolean; reason: string; changed_by: string; changed_at: Date }>(
    "SELECT paused, reason, changed_by, changed_at FROM next_migration_rollout WHERE singleton"
  )).rows[0];
  if (!row) throw new Error("Migration rollout state is missing.");
  return { paused: row.paused, reason: row.reason, changed_by: row.changed_by, changed_at: new Date(row.changed_at).toISOString() };
}

export async function accountMigrationView(db: DatabaseQueryable, account: string): Promise<AccountMigrationView | null> {
  const user = (await db.query<{ backend: unknown; cohort: string | null; released: boolean | null; started: boolean | null; terminal_excluded: boolean }>(
    `SELECT u.account_backend AS backend, m.cohort, c.released_at IS NOT NULL AS released,
            m.started_at IS NOT NULL AS started, m.terminal_excluded_at IS NOT NULL AS terminal_excluded
     FROM users u
     LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
     LEFT JOIN next_migration_cohorts c ON c.name = m.cohort
     WHERE u.id = $1`, [account]
  )).rows[0];
  if (!user) return null;
  if (user.backend !== "legacy" && user.backend !== "next") throw new Error("Account backend marker is invalid.");
  const collections = (await db.query<{ id: string; authority_state: string; cut_over: boolean }>(
    `SELECT h.id::text AS id, h.authority_state, n.collection_id IS NOT NULL AS cut_over
     FROM hosted_collections h
     LEFT JOIN next_migration_collections n ON n.collection_id = h.id
     WHERE h.user_id = $1 AND h.authority_state <> 'transferred' ORDER BY h.id`, [account]
  )).rows;
  const { paused } = await rolloutState(db);
  return {
    account_id: account,
    backend: user.backend,
    cohort: user.cohort,
    released: Boolean(user.released),
    started: Boolean(user.started),
    terminal_excluded: user.terminal_excluded,
    paused,
    hosted_collections: collections.map((c) => c.id),
    unsettled_collections: collections.filter((c) => c.authority_state !== "active").map((c) => c.id),
    cut_over_collections: collections.filter((c) => c.cut_over).map((c) => c.id)
  };
}

/** Released, legacy, not yet started accounts, oldest first. Empty while paused. */
export async function migrationCandidates(db: DatabaseQueryable, limit: number): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT m.account_id::text AS id
     FROM next_migration_rollout r, next_migration_cohort_members m
     JOIN next_migration_cohorts c ON c.name = m.cohort AND c.released_at IS NOT NULL
     JOIN users u ON u.id = m.account_id AND u.account_backend = 'legacy'
     WHERE r.singleton AND NOT r.paused AND m.started_at IS NULL AND m.terminal_excluded_at IS NULL
     ORDER BY m.added_at, m.account_id
     LIMIT $1`, [limit]
  );
  return rows.rows.map((r) => r.id);
}

/** Started, not yet flipped accounts, whatever the pause: they must finish. */
export async function migrationsInProgress(db: DatabaseQueryable, limit: number): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT m.account_id::text AS id
     FROM next_migration_cohort_members m
     JOIN users u ON u.id = m.account_id AND u.account_backend = 'legacy'
     WHERE m.started_at IS NOT NULL AND m.terminal_excluded_at IS NULL
     ORDER BY m.started_at, m.account_id
     LIMIT $1`, [limit]
  );
  return rows.rows.map((r) => r.id);
}

async function inTransaction<T>(db: DatabasePool, run: (client: DatabaseQueryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/**
 * The atomic start claim: released, legacy and not paused (the pause is read
 * under the same lock). Idempotent once started; a started account ignores pause.
 * Internal migration preserves suspension; ordinary account access stays denied.
 */
export async function startAccountMigration(db: DatabasePool, account: string, environment?: string): Promise<{ account_id: string; started_at: string }> {
  return inTransaction(db, async (client) => {
    const user = (await client.query<{ backend: string }>(
      "SELECT account_backend AS backend FROM users WHERE id = $1 FOR UPDATE", [account]
    )).rows[0];
    if (!user) throw new RolloutRefused("account_not_found", "Account not found.", 404);
    // Lock/re-read the member BEFORE its parent, matching membership mutation
    // order. Never claim from the snapshot of an unlocked outer-joined row.
    const row = (await client.query<{ cohort: string; started_at: Date | null; terminal_excluded_at: Date | null }>(
      "SELECT cohort, started_at,terminal_excluded_at FROM next_migration_cohort_members WHERE account_id = $1 FOR UPDATE", [account]
    )).rows[0];
    if (!row) throw new RolloutRefused("account_not_released", "The account is not in a released migration cohort.");
    if (row.terminal_excluded_at !== null) throw new RolloutRefused("account_deletion_accepted", "The account's deletion was accepted; it will not migrate.");
    const batch = (await client.query<{ released: boolean }>(
      "SELECT released_at IS NOT NULL AS released FROM next_migration_cohorts WHERE name = $1 FOR UPDATE", [row.cohort]
    )).rows[0];
    if (!batch?.released) throw new RolloutRefused("account_not_released", "The account is not in a released migration cohort.");
    if (!row.started_at) {
      if (user.backend !== "legacy") throw new RolloutRefused("account_already_next", "The account already uses the next backend.");
      const rollout = (await client.query<{ paused: boolean }>("SELECT paused FROM next_migration_rollout WHERE singleton FOR SHARE")).rows[0];
      if (!rollout || rollout.paused) throw new RolloutRefused("migration_paused", "The migration rollout is paused.");
    }
    // H0 currentness/freshness precedes every claim, including idempotent retries.
    // The batch lock prevents membership/coverage changes committing until claim.
    await requireCurrentCohortArchive(client, row.cohort, environment);
    if (row.started_at) return { account_id: account, started_at: new Date(row.started_at).toISOString() };
    const started = (await client.query<{ started_at: Date }>(
      "UPDATE next_migration_cohort_members SET started_at = now() WHERE account_id = $1 RETURNING started_at", [account]
    )).rows[0]!;
    await audit(client, account, "next_migration.start", account, {});
    return { account_id: account, started_at: new Date(started.started_at).toISOString() };
  });
}

/**
 * Record one hosted collection's completed cutover (H10: routed at barrier F with
 * the final live digest) and route it to the next runtime. Requires a started
 * account and the control plane's cloud copy with the preserved ID, owned by the
 * account. Idempotent for the same values.
 */
export interface CutoverFacts { s_final: number; cutover_seq: number; barrier_f: number; final_digest: string }

export async function recordCollectionCutover(
  db: DatabasePool, collection: string, facts: CutoverFacts
): Promise<{ collection_id: string; account_id: string }> {
  const { s_final: sFinal, cutover_seq: cutoverSeq, barrier_f: barrierF, final_digest: finalDigest } = facts;
  if (![sFinal, cutoverSeq, barrierF].every(Number.isSafeInteger) || sFinal < 0 || cutoverSeq <= 0
      || barrierF < cutoverSeq || !HEX64.test(finalDigest)) {
    throw new RolloutRefused("invalid_request", "s_final, cutover_seq <= barrier_f and a hex final_digest are required.", 400);
  }
  return inTransaction(db, async (client) => {
    const owner = (await client.query<{ account: string }>(
      "SELECT user_id::text AS account FROM hosted_collections WHERE id = $1 AND authority_state = 'active'", [collection]
    )).rows[0];
    if (!owner) throw new RolloutRefused("collection_not_found", "No settled hosted collection with that id.", 404);
    const account = owner.account;
    const member = (await client.query<{ started: boolean; terminal_excluded_at: Date | null }>(
      `SELECT m.started_at IS NOT NULL AS started,m.terminal_excluded_at FROM users u
       LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
       WHERE u.id = $1 FOR UPDATE OF u`, [account]
    )).rows[0];
    if (member?.terminal_excluded_at != null) throw new RolloutRefused("account_deletion_accepted", "The account's deletion was accepted; it will not migrate.");
    if (!member?.started) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
    const next = (await client.query<{ ok: boolean }>(
      `SELECT owner_user_id = $2 AND sync = 'cloud_copy' AND left_sync_at IS NULL AS ok
       FROM next_collections WHERE collection_id = $1 FOR UPDATE`, [collection, account]
    )).rows[0];
    if (!next?.ok) throw new RolloutRefused("next_collection_missing", "No cloud copy with the preserved id owned by the account.");
    const existing = (await client.query<{ s_final: string; cutover_seq: string; barrier_f: string; final_digest: string }>(
      "SELECT s_final::text, cutover_seq::text, barrier_f::text, final_digest FROM next_migration_collections WHERE collection_id = $1", [collection]
    )).rows[0];
    if (existing) {
      if (existing.barrier_f !== String(barrierF) || existing.final_digest !== finalDigest
          || existing.s_final !== String(sFinal) || existing.cutover_seq !== String(cutoverSeq)) {
        throw new RolloutRefused("cutover_conflict", "A different cutover is already recorded.");
      }
      return { collection_id: collection, account_id: account };
    }
    await client.query(
      `INSERT INTO next_migration_collections (collection_id, account_id, s_final, cutover_seq, barrier_f, final_digest)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [collection, account, sFinal, cutoverSeq, barrierF, finalDigest]
    );
    await client.query("UPDATE next_collections SET runtime = 'next' WHERE collection_id = $1", [collection]);
    await audit(client, account, "next_migration.cutover", collection, facts);
    return { collection_id: collection, account_id: account };
  });
}

/** The flip evidence digest: SHA-256 over the sorted `collection:barrier_f:final_digest` lines. */
export function flipEvidenceDigest(records: readonly { collection_id: string; barrier_f: string | number; final_digest: string }[]): string {
  const lines = records.map((r) => `${r.collection_id.toLowerCase()}:${r.barrier_f}:${r.final_digest}\n`).sort();
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/**
 * Switch a started account to the next backend once every hosted collection has
 * a recorded cutover. `collections` must name exactly those collections and
 * `evidence_digest` must equal [`flipEvidenceDigest`] over their records.
 * Idempotent for the same evidence. Pause does not apply (the account started).
 */
export async function flipAccountBackend(
  db: DatabasePool, account: string, collections: readonly string[], evidenceDigest: string
): Promise<{ account_id: string; backend: "next"; flipped_at: string }> {
  const named = [...new Set(collections.map((c) => c.toLowerCase()))].sort();
  if (named.length !== collections.length) throw new RolloutRefused("collections_duplicated", "A collection is named twice.");
  if (!HEX64.test(evidenceDigest)) throw new RolloutRefused("invalid_request", "A hex evidence_digest is required.", 400);
  const result = await inTransaction(db, async (client) => {
    const user = (await client.query<{ backend: string; started: boolean | null; terminal_excluded_at: Date | null }>(
      `SELECT u.account_backend AS backend, m.started_at IS NOT NULL AS started,m.terminal_excluded_at
       FROM users u LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
       WHERE u.id = $1 FOR UPDATE OF u`, [account]
    )).rows[0];
    if (!user) throw new RolloutRefused("account_not_found", "Account not found.", 404);
    if (user.terminal_excluded_at !== null) throw new RolloutRefused("account_deletion_accepted", "The account's deletion was accepted; it will not migrate.");
    if (user.backend === "next") {
      const flip = (await client.query<{ collections: string[]; evidence_digest: string; flipped_at: Date }>(
        "SELECT collections::text[] AS collections, evidence_digest, flipped_at FROM next_migration_account_flips WHERE account_id = $1",
        [account]
      )).rows[0];
      if (flip && flip.evidence_digest === evidenceDigest && [...flip.collections].sort().join() === named.join()) {
        return { account_id: account, backend: "next" as const, flipped_at: new Date(flip.flipped_at).toISOString() };
      }
      throw new RolloutRefused("account_already_next", "The account already uses the next backend with other evidence.");
    }
    if (!user.started) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
    const member = (await client.query<{ cohort: string }>(
      "SELECT cohort FROM next_migration_cohort_members WHERE account_id=$1 FOR SHARE", [account]
    )).rows[0];
    if (!member) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
    const batch = (await client.query<{ frozen_at: Date | null; revision: string }>(
      "SELECT frozen_at,membership_revision::text AS revision FROM next_migration_cohorts WHERE name=$1 FOR UPDATE", [member.cohort]
    )).rows[0];
    if (!batch) throw new Error("Migration membership has no cohort.");
    // Lock the hosted collections: none may change authority during the flip, and
    // creation of new ones is refused for a next account (the users row lock orders it).
    const held = (await client.query<{ id: string; authority_state: string; barrier_f: string | null; final_digest: string | null; runtime: string | null }>(
      `SELECT h.id::text AS id, h.authority_state, n.barrier_f::text AS barrier_f, n.final_digest, x.runtime
       FROM hosted_collections h
       LEFT JOIN next_migration_collections n ON n.collection_id = h.id AND n.account_id = h.user_id
       LEFT JOIN next_collections x ON x.collection_id = h.id AND x.owner_user_id = h.user_id
       WHERE h.user_id = $1 AND h.authority_state <> 'transferred' ORDER BY h.id FOR UPDATE OF h`, [account]
    )).rows;
    if (held.some((c) => c.authority_state !== "active")) {
      throw new RolloutRefused("collections_unsettled", "A hosted collection is mid import or transfer.");
    }
    if (held.map((c) => c.id).join() !== named.join()) {
      throw new RolloutRefused("collections_mismatch", "The migrated collections are not exactly the account's hosted collections.");
    }
    if (held.some((c) => c.barrier_f === null || c.final_digest === null || c.runtime !== "next")) {
      throw new RolloutRefused("collections_not_cut_over", "A hosted collection has no recorded cutover.");
    }
    const expected = flipEvidenceDigest(held.map((c) => ({ collection_id: c.id, barrier_f: c.barrier_f!, final_digest: c.final_digest! })));
    if (expected !== evidenceDigest) throw new RolloutRefused("evidence_mismatch", "The evidence digest does not match the recorded cutovers.");
    await client.query("UPDATE users SET account_backend = 'next' WHERE id = $1", [account]);
    const flipped = (await client.query<{ flipped_at: Date }>(
      `INSERT INTO next_migration_account_flips (account_id, collections, evidence_digest)
       VALUES ($1, $2::uuid[], $3) RETURNING flipped_at`, [account, named, evidenceDigest]
    )).rows[0]!;
    await audit(client, account, "next_migration.flip", account, { collections: named, evidence_digest: evidenceDigest });
    // Every member must have a validated final flip OR accepted terminal
    // exclusion. An excluded account never needs a witness/cutover/flip.
    if (batch.frozen_at !== null) await completeMigrationBatch(client, member.cohort, batch.revision, batch.frozen_at);
    return { account_id: account, backend: "next" as const, flipped_at: new Date(flipped.flipped_at).toISOString() };
  });
  await drainDeferredAccountDeletions(db);
  return result;
}

/**
 * The daemon's automatic-takeover gate. True only once the account
 * flipped: its hosted collections are cut over and its apps re-consent on next.
 * A daemon treats an unreachable or unparseable answer as false (fail closed); a
 * manual install alone never migrates anything.
 */
export async function localTakeoverAllowed(db: DatabaseQueryable, account: string): Promise<{ local_takeover: boolean; account_backend: "legacy" | "next" | null }> {
  const backend = (await db.query<{ account_backend: string }>(
    "SELECT account_backend FROM users WHERE id = $1 AND suspended_at IS NULL", [account]
  )).rows[0]?.account_backend;
  const known = backend === "legacy" || backend === "next" ? backend : null;
  return { local_takeover: known === "next", account_backend: known };
}

/**
 * Stored cutover metadata for an already-authorized current native member.
 * These ledger facts are not verified installation, byte-preservation proof,
 * policy/key possession or fresh admission. Authorization belongs to the caller.
 */
export async function collectionMigrationRecord(db: DatabaseQueryable, collection: string, account: string) {
  const row = (await db.query<{ s_final: string; cutover_seq: string; barrier_f: string; final_digest: string; cutover_at: Date }>(
    `SELECT n.s_final::text, n.cutover_seq::text, n.barrier_f::text, n.final_digest, n.cutover_at
     FROM next_migration_collections n JOIN hosted_collections h
       ON h.id=n.collection_id AND h.user_id=n.account_id AND h.authority_state<>'transferred'
     WHERE n.collection_id=$1 AND n.account_id=$2 FOR SHARE OF n,h`, [collection, account]
  )).rows[0];
  if (!row) return null;
  const record = {
    collection_id: collection, legacy_collection_id: collection, ids_preserved: true,
    s_final: row.s_final, cutover_seq: row.cutover_seq, barrier_f: row.barrier_f,
    final_digest: row.final_digest, cutover_at: new Date(row.cutover_at).toISOString()
  };
  // One canonical serializer for the strict eight-field native reader. Never
  // round bigint sequences through Number, or publish malformed stored metadata.
  const u64 = 18_446_744_073_709_551_615n;
  const valid = z.object({
    collection_id: z.string().regex(UUID_CANONICAL), legacy_collection_id: z.string().regex(UUID_CANONICAL),
    ids_preserved: z.literal(true), s_final: decimal(u64), cutover_seq: decimal(u64, true), barrier_f: decimal(u64, true),
    final_digest: z.string().regex(HEX64), cutover_at: millisecondTime
  }).strict().refine(value => value.collection_id !== "00000000-0000-0000-0000-000000000000"
    && BigInt(value.cutover_seq) <= BigInt(value.barrier_f)).safeParse(record);
  if (!valid.success) throw new Error("Stored migration record is invalid.");
  return valid.data;
}

/** Whether an account's migration started (or finished): its hosted collections must never be quarantined as missing. */
// ---- operator changes (CLI): each one statement plus an audit row with its actor ----

function actorOf(actor: string): string {
  const a = actor.trim();
  if (!a || a.length > 200) throw new Error("An operator actor of 1-200 characters is required.");
  return a;
}

export async function setPaused(db: DatabaseQueryable, paused: boolean, reason: string, actor: string): Promise<RolloutState> {
  const by = actorOf(actor);
  if (!reason.trim() || reason.length > 500) throw new Error("A reason of 1-500 characters is required.");
  await db.query("UPDATE next_migration_rollout SET paused = $1, reason = $2, changed_by = $3, changed_at = now() WHERE singleton", [paused, reason, by]);
  await audit(db, null, paused ? "next_migration.pause" : "next_migration.resume", null, { reason, actor: by });
  return rolloutState(db);
}
export async function createCohort(db: DatabaseQueryable, name: string, actor: string): Promise<void> {
  const by = actorOf(actor);
  if (!COHORT_NAME.test(name)) throw new Error("A cohort name is lowercase letters, digits and dashes (1-63).");
  await db.query("INSERT INTO next_migration_cohorts (name) VALUES ($1)", [name]);
  await audit(db, null, "next_migration.cohort_create", null, { cohort: name, actor: by });
}
export async function releaseCohort(db: DatabaseQueryable, name: string, actor: string): Promise<boolean> {
  const by = actorOf(actor);
  const r = await db.query("UPDATE next_migration_cohorts SET released_at = now() WHERE name = $1 AND released_at IS NULL", [name]);
  const released = (r.rowCount ?? 0) === 1;
  if (released) await audit(db, null, "next_migration.cohort_release", null, { cohort: name, actor: by });
  return released;
}
/** Add legacy accounts to a cohort; one already in a cohort, or already next, is skipped. Returns those added. */
export async function addToCohort(db: DatabasePool, name: string, accounts: readonly string[], actor: string): Promise<string[]> {
  const by = actorOf(actor);
  return inTransaction(db, async (client) => {
    // Mutation guards share-lock the user even if it has no membership yet.
    // Assignment takes that same row first, in stable order, before its parent.
    await client.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [accounts]);
    const batch = (await client.query<{ frozen_at: Date | null }>(
      "SELECT frozen_at FROM next_migration_cohorts WHERE name = $1 FOR UPDATE", [name]
    )).rows[0];
    if (!batch) throw new RolloutRefused("cohort_not_found", "Migration cohort not found.", 404);
    if (batch.frozen_at !== null) throw new RolloutRefused("migration_frozen", "Migration topology is frozen.");
    const r = await client.query<{ account_id: string }>(
      `INSERT INTO next_migration_cohort_members (account_id, cohort)
       SELECT u.id, $1 FROM users u WHERE u.id = ANY($2::uuid[]) AND u.account_backend = 'legacy'
       ON CONFLICT (account_id) DO NOTHING RETURNING account_id::text`, [name, accounts]
    );
    const added = r.rows.map((row) => row.account_id);
    await audit(client, null, "next_migration.cohort_add", null, { cohort: name, added: added.length, skipped: accounts.length - added.length, actor: by });
    return added;
  });
}

/** Freeze once; unfreeze is audited and forbidden after acceptance of the current revision. */
export async function setCohortFrozen(db: DatabasePool, name: string, frozen: boolean, reason: string, actor: string): Promise<{ frozen_at: string | null }> {
  const by = actorOf(actor);
  if (!reason.trim() || reason.length > 500) throw new Error("A reason of 1-500 characters is required.");
  const result = await inTransaction(db, async (client) => {
    const batch = (await client.query<{ frozen_at: Date | null; revision: string }>(
      "SELECT frozen_at, membership_revision::text AS revision FROM next_migration_cohorts WHERE name = $1 FOR UPDATE", [name]
    )).rows[0];
    if (!batch) throw new RolloutRefused("cohort_not_found", "Migration cohort not found.", 404);
    if (!frozen && (await client.query(
      "SELECT 1 FROM next_migration_archive_acceptances WHERE cohort = $1 AND membership_revision = $2::bigint", [name, batch.revision]
    )).rows.length) throw new RolloutRefused("migration_frozen", "Migration topology is frozen.");
    if (frozen === (batch.frozen_at !== null)) return { frozen_at: batch.frozen_at === null ? null : new Date(batch.frozen_at).toISOString() };
    // Never capture a new window between committed readiness and automatic
    // erasure. The existing freeze's final-flip readiness is unaffected.
    if (frozen && (await client.query(
      "SELECT 1 FROM next_migration_deferred_account_deletions WHERE cohort=$1 AND ready_at IS NOT NULL LIMIT 1", [name]
    )).rows.length) throw new RolloutRefused("busy", "Busy; retry.");
    const row = (await client.query<{ frozen_at: Date | null }>(
      "UPDATE next_migration_cohorts SET frozen_at = CASE WHEN $2 THEN date_trunc('milliseconds', clock_timestamp()) ELSE NULL END,completed_at=NULL,completed_revision=NULL WHERE name = $1 RETURNING frozen_at", [name, frozen]
    )).rows[0]!;
    await audit(client, null, frozen ? "next_migration.freeze" : "next_migration.unfreeze", null,
      { cohort: name, membership_revision: batch.revision, actor: by, reason });
    if (!frozen && batch.frozen_at !== null) await releaseDeferredDeletions(client, name, batch.revision, batch.frozen_at);
    return { frozen_at: row.frozen_at === null ? null : new Date(row.frozen_at).toISOString() };
  });
  if (!frozen) await drainDeferredAccountDeletions(db);
  return result;
}

/** Routes for the hosted migrator: the dedicated migration token only. */
export function registerMigrationRolloutRoutes(app: FastifyInstance, options: { db: DatabasePool; token: string; environment?: string }): void {
  const migrator = (request: FastifyRequest) => {
    const presented = bearerToken(request);
    return Boolean(presented) && safeEqual(presented!, options.token);
  };
  const deny = (reply: { code(n: number): { send(b: unknown): unknown } }) =>
    reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
  const refused = (reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown) => {
    if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
    if (["55P03", "40P01", "40001"].includes(String((error as { code?: string })?.code))) return reply.code(503).send(apiError("busy", "Busy; retry."));
    throw error;
  };
  const limit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
  const idParam = z.object({ id: z.uuid() });
  const cohortParam = z.object({ name: z.string().regex(COHORT_NAME) }).strict();
  for (const frozen of [true, false]) {
    app.post(`/internal/v1/next/migration/cohorts/:name/${frozen ? "freeze" : "unfreeze"}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!migrator(request)) return deny(reply);
      const p = cohortParam.safeParse(request.params);
      const b = z.object({ actor: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(500) }).strict().safeParse(request.body);
      if (!p.success || !b.success) return reply.code(400).send(apiError("invalid_request", "Canonical batch, actor and reason are required."));
      try { return await setCohortFrozen(options.db, p.data.name, frozen, b.data.reason, b.data.actor); } catch (e) { return refused(reply, e); }
    });
  }
  app.get("/internal/v1/next/migration/cohorts/:name/archive-binding", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!migrator(request)) return deny(reply);
    const p = cohortParam.safeParse(request.params);
    if (!p.success) return reply.code(400).send(apiError("invalid_request", "A canonical batch name is required."));
    try { return await cohortArchiveBinding(options.db, p.data.name); } catch (e) { return refused(reply, e); }
  });
  app.post("/internal/v1/next/migration/cohorts/:name/backup-accept", { bodyLimit: 4096 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!migrator(request)) return deny(reply);
    const p = cohortParam.safeParse(request.params);
    if (!p.success) return reply.code(400).send(apiError("invalid_request", "A canonical batch name is required."));
    try { return await acceptCohortArchive(options.db, p.data.name, request.body, options.environment); } catch (e) { return refused(reply, e); }
  });
  app.get("/internal/v1/next/migration/rollout", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    reply.header("cache-control", "no-store");
    return rolloutState(options.db);
  });
  app.get("/internal/v1/next/migration/candidates", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    const q = limit.safeParse(request.query);
    if (!q.success) return reply.code(400).send(apiError("invalid_request", "limit must be 1-100."));
    reply.header("cache-control", "no-store");
    return { accounts: await migrationCandidates(options.db, q.data.limit) };
  });
  app.get("/internal/v1/next/migration/in-progress", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    const q = limit.safeParse(request.query);
    if (!q.success) return reply.code(400).send(apiError("invalid_request", "limit must be 1-100."));
    reply.header("cache-control", "no-store");
    return { accounts: await migrationsInProgress(options.db, q.data.limit) };
  });
  app.get("/internal/v1/next/migration/accounts/:id", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(400).send(apiError("invalid_request", "An account id is required."));
    reply.header("cache-control", "no-store");
    const view = await accountMigrationView(options.db, p.data.id.toLowerCase());
    if (!view) return reply.code(404).send(apiError("account_not_found", "Account not found."));
    return view;
  });
  app.post("/internal/v1/next/migration/accounts/:id/start", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    const p = idParam.safeParse(request.params);
    if (!p.success) return reply.code(400).send(apiError("invalid_request", "An account id is required."));
    try { return await startAccountMigration(options.db, p.data.id.toLowerCase(), options.environment); } catch (e) { return refused(reply, e); }
  });
  app.post("/internal/v1/next/migration/collections/:id/cutover", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    const p = idParam.safeParse(request.params);
    const body = z.object({
      s_final: z.number().int().nonnegative(), cutover_seq: z.number().int().positive(),
      barrier_f: z.number().int().positive(), final_digest: z.string()
    }).strict().safeParse(request.body);
    if (!p.success || !body.success) return reply.code(400).send(apiError("invalid_request", "s_final, cutover_seq, barrier_f and final_digest are required."));
    try {
      return await recordCollectionCutover(options.db, p.data.id.toLowerCase(), body.data);
    } catch (e) { return refused(reply, e); }
  });
  app.post("/internal/v1/next/migration/accounts/:id/flip", async (request, reply) => {
    if (!migrator(request)) return deny(reply);
    const p = idParam.safeParse(request.params);
    const body = z.object({ collections: z.array(z.uuid()).max(1000), evidence_digest: z.string() }).strict().safeParse(request.body);
    if (!p.success || !body.success) return reply.code(400).send(apiError("invalid_request", "collections and evidence_digest are required."));
    try {
      return await flipAccountBackend(options.db, p.data.id.toLowerCase(), body.data.collections, body.data.evidence_digest);
    } catch (e) { return refused(reply, e); }
  });
}
