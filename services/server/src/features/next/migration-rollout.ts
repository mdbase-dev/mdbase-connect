// Staged migration of hosted collections to mdbase-next (decision 3, 2026-10-08).
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
// - A deleted account is terminal (Callum, 2026-10-08): its rows cascade away and
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

export interface RolloutState { paused: boolean; reason: string; changed_by: string; changed_at: string }

export interface AccountMigrationView {
  account_id: string;
  backend: "legacy" | "next";
  cohort: string | null;
  released: boolean;
  started: boolean;
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

const COHORT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export async function rolloutState(db: DatabaseQueryable): Promise<RolloutState> {
  const row = (await db.query<{ paused: boolean; reason: string; changed_by: string; changed_at: Date }>(
    "SELECT paused, reason, changed_by, changed_at FROM next_migration_rollout WHERE singleton"
  )).rows[0];
  if (!row) throw new Error("Migration rollout state is missing.");
  return { paused: row.paused, reason: row.reason, changed_by: row.changed_by, changed_at: new Date(row.changed_at).toISOString() };
}

export async function accountMigrationView(db: DatabaseQueryable, account: string): Promise<AccountMigrationView | null> {
  const user = (await db.query<{ backend: unknown; cohort: string | null; released: boolean | null; started: boolean | null }>(
    `SELECT u.account_backend AS backend, m.cohort, c.released_at IS NOT NULL AS released,
            m.started_at IS NOT NULL AS started
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
     WHERE r.singleton AND NOT r.paused AND m.started_at IS NULL
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
     WHERE m.started_at IS NOT NULL
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
 */
export async function startAccountMigration(db: DatabasePool, account: string): Promise<{ account_id: string; started_at: string }> {
  return inTransaction(db, async (client) => {
    const row = (await client.query<{ backend: string; released: boolean | null; started_at: Date | null; member: boolean }>(
      `SELECT u.account_backend AS backend, c.released_at IS NOT NULL AS released, m.started_at,
              m.account_id IS NOT NULL AS member
       FROM users u
       LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
       LEFT JOIN next_migration_cohorts c ON c.name = m.cohort
       WHERE u.id = $1 FOR UPDATE OF u`, [account]
    )).rows[0];
    if (!row) throw new RolloutRefused("account_not_found", "Account not found.", 404);
    if (row.started_at) return { account_id: account, started_at: new Date(row.started_at).toISOString() };
    if (row.backend !== "legacy") throw new RolloutRefused("account_already_next", "The account already uses the next backend.");
    if (!row.member || !row.released) throw new RolloutRefused("account_not_released", "The account is not in a released migration cohort.");
    const rollout = (await client.query<{ paused: boolean }>("SELECT paused FROM next_migration_rollout WHERE singleton FOR SHARE")).rows[0];
    if (!rollout || rollout.paused) throw new RolloutRefused("migration_paused", "The migration rollout is paused.");
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
    const member = (await client.query<{ started: boolean }>(
      `SELECT m.started_at IS NOT NULL AS started FROM users u
       LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
       WHERE u.id = $1 FOR UPDATE OF u`, [account]
    )).rows[0];
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
  return inTransaction(db, async (client) => {
    const user = (await client.query<{ backend: string; started: boolean | null }>(
      `SELECT u.account_backend AS backend, m.started_at IS NOT NULL AS started
       FROM users u LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
       WHERE u.id = $1 FOR UPDATE OF u`, [account]
    )).rows[0];
    if (!user) throw new RolloutRefused("account_not_found", "Account not found.", 404);
    if (user.backend === "next") {
      const flip = (await client.query<{ collections: string[]; evidence_digest: string; flipped_at: Date }>(
        "SELECT collections::text[] AS collections, evidence_digest, flipped_at FROM next_migration_account_flips WHERE account_id = $1",
        [account]
      )).rows[0];
      if (flip && flip.evidence_digest === evidenceDigest && [...flip.collections].sort().join() === named.join()) {
        return { account_id: account, backend: "next", flipped_at: new Date(flip.flipped_at).toISOString() };
      }
      throw new RolloutRefused("account_already_next", "The account already uses the next backend with other evidence.");
    }
    if (!user.started) throw new RolloutRefused("account_not_started", "The account's migration has not started.");
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
    return { account_id: account, backend: "next", flipped_at: new Date(flipped.flipped_at).toISOString() };
  });
}

/**
 * The daemon's automatic-takeover gate (decision 3). True only once the account
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
 * The mirror-join facts of one migrated collection for its owner's daemon: the
 * preserved collection ID, legacy S_final, the new log's cutover position (join
 * sync point C), barrier F and the live digest at F. Record and file IDs are the
 * legacy IDs; contents are byte-identical (revision / whole plaintext SHA-256).
 */
export async function collectionMigrationRecord(db: DatabaseQueryable, collection: string, account: string) {
  const row = (await db.query<{ s_final: string; cutover_seq: string; barrier_f: string; final_digest: string; cutover_at: Date }>(
    `SELECT s_final::text, cutover_seq::text, barrier_f::text, final_digest, cutover_at
     FROM next_migration_collections WHERE collection_id = $1 AND account_id = $2`, [collection, account]
  )).rows[0];
  if (!row) return null;
  return {
    collection_id: collection, legacy_collection_id: collection, ids_preserved: true,
    s_final: Number(row.s_final), cutover_seq: Number(row.cutover_seq), barrier_f: Number(row.barrier_f),
    final_digest: row.final_digest, cutover_at: new Date(row.cutover_at).toISOString()
  };
}

/** Whether an account's migration started (or finished): its hosted collections must never be quarantined as missing. */
export async function accountMigrating(db: DatabaseQueryable, account: string): Promise<boolean> {
  const row = (await db.query<{ migrating: boolean }>(
    `SELECT u.account_backend = 'next' OR m.started_at IS NOT NULL AS migrating
     FROM users u LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id WHERE u.id = $1`, [account]
  )).rows[0];
  return Boolean(row?.migrating);
}

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
export async function addToCohort(db: DatabaseQueryable, name: string, accounts: readonly string[], actor: string): Promise<string[]> {
  const by = actorOf(actor);
  const r = await db.query<{ account_id: string }>(
    `INSERT INTO next_migration_cohort_members (account_id, cohort)
     SELECT u.id, $1 FROM users u WHERE u.id = ANY($2::uuid[]) AND u.account_backend = 'legacy'
     ON CONFLICT (account_id) DO NOTHING RETURNING account_id::text`, [name, accounts]
  );
  const added = r.rows.map((row) => row.account_id);
  await audit(db, null, "next_migration.cohort_add", null, { cohort: name, added: added.length, skipped: accounts.length - added.length, actor: by });
  return added;
}

/** Routes for the hosted migrator: the dedicated migration token only. */
export function registerMigrationRolloutRoutes(app: FastifyInstance, options: { db: DatabasePool; token: string }): void {
  const migrator = (request: FastifyRequest) => {
    const presented = bearerToken(request);
    return Boolean(presented) && safeEqual(presented!, options.token);
  };
  const deny = (reply: { code(n: number): { send(b: unknown): unknown } }) =>
    reply.code(401).send(apiError("invalid_internal_token", "The migration token is required."));
  const refused = (reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown) => {
    if (error instanceof RolloutRefused) return reply.code(error.status).send(apiError(error.code, error.message));
    if (String((error as { code?: string })?.code) === "55P03") return reply.code(503).send(apiError("busy", "Busy; retry."));
    throw error;
  };
  const limit = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
  const idParam = z.object({ id: z.uuid() });
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
    try { return await startAccountMigration(options.db, p.data.id.toLowerCase()); } catch (e) { return refused(reply, e); }
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
