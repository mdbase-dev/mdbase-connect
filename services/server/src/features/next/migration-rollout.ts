// Staged migration of hosted collections to mdbase-next (decision 3, 2026-10-08).
// Operators release cohorts; there is no user opt-in. One global pause stops new
// accounts from starting. It never strands an account mid-cutover: an account
// whose hosted collections are migrating keeps going, and its flip is allowed
// while paused. The flip is the only setter of `users.account_backend = 'next'`
// (docs/account-backend.md). It succeeds only when the caller names exactly the
// account's current hosted collections, all settled, and records that evidence.
// Old agents of a flipped account are told to update; their local folders move
// on the new daemon's takeover.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { apiError } from "../../platform/http-errors.js";
import { serviceKind } from "./hosted-routes.js";

export interface RolloutState { paused: boolean; reason: string; changed_at: string }

export interface AccountMigrationView {
  account_id: string;
  backend: "legacy" | "next";
  cohort: string | null;
  released: boolean;
  paused: boolean;
  /** Hosted collections the account holds now, by id, in id order. */
  hosted_collections: string[];
  /** Hosted collections mid authority transfer/import: the account cannot flip yet. */
  unsettled_collections: string[];
  /** Released, not paused, still legacy: a new migration may start. */
  may_start: boolean;
}

export async function rolloutState(db: DatabaseQueryable): Promise<RolloutState> {
  const row = (await db.query<{ paused: boolean; reason: string; changed_at: Date }>(
    "SELECT paused, reason, changed_at FROM next_migration_rollout WHERE singleton"
  )).rows[0];
  if (!row) throw new Error("Migration rollout state is missing.");
  return { paused: row.paused, reason: row.reason, changed_at: row.changed_at.toISOString() };
}

export async function accountMigrationView(db: DatabaseQueryable, account: string): Promise<AccountMigrationView | null> {
  const user = (await db.query<{ backend: unknown; cohort: string | null; released: boolean | null }>(
    `SELECT u.account_backend AS backend, m.cohort, c.released_at IS NOT NULL AS released
     FROM users u
     LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
     LEFT JOIN next_migration_cohorts c ON c.name = m.cohort
     WHERE u.id = $1`, [account]
  )).rows[0];
  if (!user) return null;
  if (user.backend !== "legacy" && user.backend !== "next") throw new Error("Account backend marker is invalid.");
  const collections = (await db.query<{ id: string; authority_state: string }>(
    `SELECT id::text AS id, authority_state FROM hosted_collections
     WHERE user_id = $1 AND authority_state <> 'transferred' ORDER BY id`, [account]
  )).rows;
  const { paused } = await rolloutState(db);
  const released = Boolean(user.released);
  return {
    account_id: account,
    backend: user.backend,
    cohort: user.cohort,
    released,
    paused,
    hosted_collections: collections.map((c) => c.id),
    unsettled_collections: collections.filter((c) => c.authority_state !== "active").map((c) => c.id),
    may_start: released && !paused && user.backend === "legacy"
  };
}

/** Accounts a migrator may start now: released cohorts, still legacy, oldest first. Empty while paused. */
export async function migrationCandidates(db: DatabaseQueryable, limit: number): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT m.account_id::text AS id
     FROM next_migration_rollout r, next_migration_cohort_members m
     JOIN next_migration_cohorts c ON c.name = m.cohort AND c.released_at IS NOT NULL
     JOIN users u ON u.id = m.account_id AND u.account_backend = 'legacy'
     WHERE r.singleton AND NOT r.paused
     ORDER BY m.added_at, m.account_id
     LIMIT $1`, [limit]
  );
  return rows.rows.map((r) => r.id);
}

export class FlipRefused extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Switch an account to the next backend after every hosted collection migrated.
 * Idempotent for the same evidence. Pause does not apply: the account is already
 * mid-cutover when this is called.
 */
export async function flipAccountBackend(
  db: DatabasePool, account: string, collections: readonly string[], evidenceDigest: string
): Promise<{ account_id: string; backend: "next"; flipped_at: string }> {
  const named = [...new Set(collections.map((c) => c.toLowerCase()))].sort();
  if (named.length !== collections.length) throw new FlipRefused("collections_duplicated", "A collection is named twice.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const user = (await client.query<{ backend: string; released: boolean | null }>(
      `SELECT u.account_backend AS backend, c.released_at IS NOT NULL AS released
       FROM users u
       LEFT JOIN next_migration_cohort_members m ON m.account_id = u.id
       LEFT JOIN next_migration_cohorts c ON c.name = m.cohort
       WHERE u.id = $1 FOR UPDATE OF u`, [account]
    )).rows[0];
    if (!user) throw new FlipRefused("account_not_found", "Account not found.");
    if (user.backend === "next") {
      const flip = (await client.query<{ collections: string[]; evidence_digest: string; flipped_at: Date }>(
        "SELECT collections::text[] AS collections, evidence_digest, flipped_at FROM next_migration_account_flips WHERE account_id = $1",
        [account]
      )).rows[0];
      await client.query("ROLLBACK");
      if (flip && flip.evidence_digest === evidenceDigest && [...flip.collections].sort().join() === named.join()) {
        return { account_id: account, backend: "next", flipped_at: flip.flipped_at.toISOString() };
      }
      throw new FlipRefused("account_already_next", "The account already uses the next backend with other evidence.");
    }
    if (!user.released) throw new FlipRefused("account_not_released", "The account is not in a released migration cohort.");
    // Lock the account's hosted collections so none appears or changes authority
    // between this check and the flip.
    const held = (await client.query<{ id: string; authority_state: string }>(
      `SELECT id::text AS id, authority_state FROM hosted_collections
       WHERE user_id = $1 AND authority_state <> 'transferred' ORDER BY id FOR UPDATE`, [account]
    )).rows;
    if (held.some((c) => c.authority_state !== "active")) {
      throw new FlipRefused("collections_unsettled", "A hosted collection is mid import or transfer.");
    }
    if (held.map((c) => c.id).join() !== named.join()) {
      throw new FlipRefused("collections_mismatch", "The migrated collections are not exactly the account's hosted collections.");
    }
    await client.query("UPDATE users SET account_backend = 'next' WHERE id = $1", [account]);
    const flipped = (await client.query<{ flipped_at: Date }>(
      `INSERT INTO next_migration_account_flips (account_id, collections, evidence_digest)
       VALUES ($1, $2::uuid[], $3) RETURNING flipped_at`, [account, named, evidenceDigest]
    )).rows[0]!;
    await client.query("COMMIT");
    return { account_id: account, backend: "next", flipped_at: flipped.flipped_at.toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Operator changes (CLI): pause, resume, cohorts. Each is one statement. */
export async function setPaused(db: DatabaseQueryable, paused: boolean, reason: string): Promise<RolloutState> {
  if (!reason.trim() || reason.length > 500) throw new Error("A reason of 1-500 characters is required.");
  await db.query("UPDATE next_migration_rollout SET paused = $1, reason = $2, changed_at = now() WHERE singleton", [paused, reason]);
  return rolloutState(db);
}
export async function createCohort(db: DatabaseQueryable, name: string): Promise<void> {
  await db.query("INSERT INTO next_migration_cohorts (name) VALUES ($1)", [name]);
}
export async function releaseCohort(db: DatabaseQueryable, name: string): Promise<boolean> {
  const r = await db.query("UPDATE next_migration_cohorts SET released_at = now() WHERE name = $1 AND released_at IS NULL", [name]);
  return (r.rowCount ?? 0) === 1;
}
/** Add legacy accounts to a cohort; an account already in a cohort or already next is skipped. Returns those added. */
export async function addToCohort(db: DatabaseQueryable, name: string, accounts: readonly string[]): Promise<string[]> {
  const r = await db.query<{ account_id: string }>(
    `INSERT INTO next_migration_cohort_members (account_id, cohort)
     SELECT u.id, $1 FROM users u WHERE u.id = ANY($2::uuid[]) AND u.account_backend = 'legacy'
     ON CONFLICT (account_id) DO NOTHING RETURNING account_id::text`, [name, accounts]
  );
  return r.rows.map((row) => row.account_id);
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** Routes for the hosted migrator: the hosted deployment's service token only. */
export function registerMigrationRolloutRoutes(app: FastifyInstance, options: { db: DatabasePool; tokens: { hosted?: string; escrow?: string } }): void {
  const hosted = (request: FastifyRequest) => serviceKind(request, options.tokens) === "hosted";
  const unauthorized = { error: "invalid_internal_token", message: "The hosted service token is required." };
  app.get("/internal/v1/next/migration/rollout", async (request, reply) => {
    if (!hosted(request)) return reply.code(401).send(apiError(unauthorized.error, unauthorized.message));
    reply.header("cache-control", "no-store");
    return rolloutState(options.db);
  });
  app.get("/internal/v1/next/migration/candidates", async (request, reply) => {
    if (!hosted(request)) return reply.code(401).send(apiError(unauthorized.error, unauthorized.message));
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send(apiError("invalid_request", "limit must be 1-100."));
    reply.header("cache-control", "no-store");
    return { accounts: await migrationCandidates(options.db, query.data.limit) };
  });
  app.get("/internal/v1/next/migration/accounts/:id", async (request, reply) => {
    if (!hosted(request)) return reply.code(401).send(apiError(unauthorized.error, unauthorized.message));
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(apiError("invalid_request", "An account id is required."));
    const id = params.data.id;
    reply.header("cache-control", "no-store");
    const view = await accountMigrationView(options.db, id.toLowerCase());
    if (!view) return reply.code(404).send(apiError("account_not_found", "Account not found."));
    return view;
  });
  app.post("/internal/v1/next/migration/accounts/:id/flip", async (request, reply) => {
    if (!hosted(request)) return reply.code(401).send(apiError(unauthorized.error, unauthorized.message));
    const params = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send(apiError("invalid_request", "An account id is required."));
    const id = params.data.id;
    const body = z.object({ collections: z.array(z.uuid()).max(1000), evidence_digest: hex64 }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send(apiError("invalid_request", "collections and a hex evidence_digest are required."));
    try {
      return await flipAccountBackend(options.db, id.toLowerCase(), body.data.collections, body.data.evidence_digest);
    } catch (error) {
      if (error instanceof FlipRefused) return reply.code(error.code === "account_not_found" ? 404 : 409).send(apiError(error.code, error.message));
      if (["55P03"].includes(String((error as { code?: string })?.code))) return reply.code(503).send(apiError("busy", "The account is busy; retry."));
      throw error;
    }
  });
}
