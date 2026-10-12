// Strict paged import of one fenced hosted collection's original timers, and the
// account-flip check that the imported set still equals the legacy source.
//
// Import completion is derived from rows, not a flag: the importer verifies the
// target rows equal every source page under one unchanged provider watermark,
// then records a content-free manifest (count, identity digest, watermark, run)
// as an audit row in the same transaction. The flip re-reads the provider
// watermark, requires the same run, and recomputes the target identity.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../../canonical-json.js";
import type { DatabasePool, DatabaseQueryable } from "../../../database-types.js";
import { HostedProviderResponseError, HostedProviderUnavailableError, type HostedProviderClient } from "../../../hosted-provider.js";
import type { LegacyMigrationSource } from "../../../hosted-provider-legacy-migration.js";
import { audit } from "../../../platform/audit-events.js";
import type { TimerGrantResolver } from "./grants.js";
import { readHostedLegacyTimers, type HostedLegacyTimer, type HostedLegacyTimerCursor } from "./hosted-copy.js";
import { validateTimerImport } from "./import-original.js";
import { enforceTimerQuota, importTimer, lockNamespace } from "./store.js";

export type TimerSourceProvider = Pick<HostedProviderClient, "legacyMigrationSource">;
export const TIMER_IMPORT_EVENT = "next_migration.timers_imported";
/** One per imported page, in that page's transaction: which provider run imported
 * which rows (by origin record digest), including pages of an unfinished import. */
export const TIMER_PAGE_EVENT = "next_migration.timers_page_imported";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const manifestSchema = z.object({
  collection_id: z.string().regex(UUID), migration_id: z.string().regex(UUID),
  started_at: z.string(), head: z.string().regex(/^\d+$/u),
  notification_watermark: z.string().max(97), timers: z.number().int().nonnegative(),
  identity_sha256: z.string().regex(/^[0-9a-f]{64}$/u)
});
export type TimerImportManifest = z.infer<typeof manifestSchema>;

/** Refused import: an operator stop, never a partial or skipped import. */
export class TimerImportRefused extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

/** Order-independent digest over (runtime id, generation, status, record digest). */
function identityDigest(entries: readonly (readonly [string, string, string, string])[]): string {
  const lines = entries.map(entry => canonicalJson(entry)).sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** RFC3339 UTC to microseconds, so the provider's JSON and SQL forms compare. */
function microseconds(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/u.exec(value);
  if (!match) throw new TimerImportRefused("migration_source_invalid", "The legacy source run time is not UTC.");
  return `${match[1]}.${(match[2] ?? "").slice(0, 6).padEnd(6, "0")}Z`;
}

/** Read the provider's drain and watermark; the source must be fenced and drained. */
export async function readFencedTimerSource(provider: TimerSourceProvider | undefined, collection: string): Promise<LegacyMigrationSource> {
  if (!provider) throw new TimerImportRefused("migration_source_unavailable", "The legacy provider is unavailable.", 503);
  let source: LegacyMigrationSource;
  try {
    source = await provider.legacyMigrationSource(collection, { deadline: Date.now() + 25_000 });
  } catch (error) {
    if (error instanceof HostedProviderResponseError || error instanceof HostedProviderUnavailableError || error instanceof z.ZodError) {
      throw new TimerImportRefused("migration_source_unavailable", "No verified legacy provider outcome; retry.", 503);
    }
    throw error;
  }
  const drain = source.drain;
  if (drain.collection_id !== collection || !drain.migration_id || !drain.started_at || drain.in_flight !== 0
      || (drain.state !== "migrating" && drain.state !== "migrated")) {
    throw new TimerImportRefused("migration_source_not_drained", "The legacy source is not fenced and drained.");
  }
  return source;
}

function sameRun(source: LegacyMigrationSource, run: { migration_id: string; started_at: string }): boolean {
  return source.drain.migration_id === run.migration_id && microseconds(source.drain.started_at!) === microseconds(run.started_at);
}

/** The imported target set of one collection, from actual timer rows. */
async function targetIdentity(db: DatabaseQueryable, collection: string): Promise<{ timers: number; identity_sha256: string }> {
  const rows = (await db.query<{ runtime_id: string | null; generation: string; status: string; record_sha256: string | null }>(
    `SELECT t.legacy_import_origin->>'runtime_id' AS runtime_id, t.generation::text AS generation, t.status,
       t.legacy_import_origin->>'record_sha256' AS record_sha256
     FROM next_timers t JOIN grants g ON g.id = t.grant_id
     WHERE g.hosted_collection_id = $1 AND t.legacy_import_origin->>'namespace' = $2`,
    [collection, `connect-hosted:${collection}:notifications`]
  )).rows;
  return {
    timers: rows.length,
    identity_sha256: identityDigest(rows.map(row => [row.runtime_id ?? "", row.generation, row.status, row.record_sha256 ?? ""] as const))
  };
}

/** One page in one transaction: every timer imports exactly, or nothing does. */
async function importPage(db: DatabasePool, resolver: TimerGrantResolver, collection: string, owner: string,
  run: { migration_id: string; started_at: string }, timers: readonly HostedLegacyTimer[]): Promise<void> {
  if (!timers.length) return;
  const connection = await db.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SET LOCAL statement_timeout = '5s'");
    const touched = new Map<string, Set<string>>();
    // Grant locks precede namespace locks in a deterministic order.
    for (const timer of [...timers].sort((a, b) => a.grant_id.localeCompare(b.grant_id)
      || a.namespace.localeCompare(b.namespace) || a.id.localeCompare(b.id))) {
      await lockNamespace(connection, timer.grant_id, timer.namespace);
      // Revoked or inactive grants still import: the target keeps the original
      // set and the worker applies current grant state after completion.
      const grant = await resolver.resolve(connection, timer.grant_id);
      if (!grant || grant.grantId !== timer.grant_id || grant.state !== "cloud_copy" || !grant.collectionIds.includes(collection)) {
        throw new TimerImportRefused("timer_grant_unbound", "An original timer's grant is not bound to this collection.");
      }
      await importTimer(connection, grant, timer);
      const namespaces = touched.get(timer.grant_id) ?? new Set<string>();
      namespaces.add(timer.namespace);
      touched.set(timer.grant_id, namespaces);
    }
    for (const [grant, namespaces] of touched) for (const namespace of namespaces) await enforceTimerQuota(connection, grant, namespace);
    await audit(connection, owner, TIMER_PAGE_EVENT, collection, {
      collection_id: collection, migration_id: run.migration_id, started_at: microseconds(run.started_at),
      records: timers.map(timer => validateTimerImport(timer).origin.record_sha256).sort()
    });
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

/** Owner of a hosted collection whose account migration started and has not flipped. */
async function migratingOwner(db: DatabaseQueryable, collection: string): Promise<string> {
  const row = (await db.query<{ owner: string; backend: string; started: boolean; excluded: boolean }>(
    `SELECT h.user_id::text AS owner, u.account_backend AS backend, m.started_at IS NOT NULL AS started,
       m.terminal_excluded_at IS NOT NULL AS excluded
     FROM hosted_collections h JOIN users u ON u.id = h.user_id
     LEFT JOIN next_migration_cohort_members m ON m.account_id = h.user_id
     WHERE h.id = $1 AND h.authority_state = 'active'`, [collection]
  )).rows[0];
  if (!row) throw new TimerImportRefused("collection_not_found", "No settled hosted collection with that id.", 404);
  if (row.excluded) throw new TimerImportRefused("account_deletion_accepted", "The account's deletion was accepted; it will not migrate.");
  if (!row.started) throw new TimerImportRefused("account_not_started", "The account's migration has not started.");
  if (row.backend !== "legacy") throw new TimerImportRefused("account_already_next", "The account already uses the next backend.");
  return row.owner;
}

/**
 * Import every original timer of one fenced, drained hosted collection.
 *
 * 1. Read the provider watermark W and run; the source must be fenced and drained.
 * 2. Read every source page in one read-only snapshot, each bound to that run,
 *    and import each page atomically (strict: any refusal stops the import).
 * 3. Re-read the watermark; it must still be W on the same run.
 * 4. Require the target rows to equal the source exactly, then record the manifest.
 *
 * Idempotent: a repeat imports nothing new and records the same manifest.
 */
export async function importHostedCollectionTimers(options: {
  db: DatabasePool; source: DatabasePool; provider: TimerSourceProvider | undefined;
  resolver: TimerGrantResolver; collection: string; actor: string;
}): Promise<TimerImportManifest> {
  const collection = options.collection.toLowerCase();
  if (!UUID.test(collection)) throw new TimerImportRefused("invalid_request", "A canonical collection id is required.", 400);
  const before = await readFencedTimerSource(options.provider, collection);
  const owner = await migratingOwner(options.db, collection);
  const entries: [string, string, string, string][] = [];
  let fence: { migration_id: string; started_at: string; head: string } | null = null;
  const snapshot = await options.source.connect();
  try {
    await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let cursor: HostedLegacyTimerCursor | null = null;
    do {
      const page: Awaited<ReturnType<typeof readHostedLegacyTimers>> = await readHostedLegacyTimers(snapshot, collection, cursor);
      if (!sameRun(before, page.fence)) throw new TimerImportRefused("timer_source_changed", "The legacy source run changed during the timer import.");
      fence = page.fence;
      await importPage(options.db, options.resolver, collection, owner, page.fence, page.timers);
      for (const timer of page.timers) {
        entries.push([timer.runtime_id, timer.generation, timer.status, validateTimerImport(timer).origin.record_sha256]);
      }
      cursor = page.nextCursor;
    } while (cursor);
    await snapshot.query("COMMIT");
  } catch (error) {
    await snapshot.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("Legacy timer snapshot refused")) {
      throw new TimerImportRefused("timer_source_refused", error.message);
    }
    throw error;
  } finally {
    snapshot.release();
  }
  const after = await readFencedTimerSource(options.provider, collection);
  if (after.notificationWatermark !== before.notificationWatermark || !sameRun(after, fence!)) {
    throw new TimerImportRefused("timer_source_changed", "The legacy timers changed during the import; retry.");
  }
  const manifest: TimerImportManifest = {
    collection_id: collection, migration_id: fence!.migration_id, started_at: microseconds(fence!.started_at),
    head: fence!.head, notification_watermark: before.notificationWatermark,
    timers: entries.length, identity_sha256: identityDigest(entries)
  };
  const connection = await options.db.connect();
  try {
    await connection.query("BEGIN");
    const target = await targetIdentity(connection, collection);
    if (target.timers !== manifest.timers || target.identity_sha256 !== manifest.identity_sha256) {
      throw new TimerImportRefused("timer_import_mismatch", "The imported timers do not equal the legacy source.");
    }
    await audit(connection, owner, TIMER_IMPORT_EVENT, collection, { ...manifest, actor: options.actor });
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
  return manifest;
}

/**
 * Account-flip timer check for one collection, inside the flip transaction.
 * `source` is a fresh provider read taken immediately before that transaction.
 * Returns a refusal code, or null when the latest import manifest is on the
 * same run, under the same watermark, and the target rows still equal it.
 */
export async function timerFlipRefusal(
  db: DatabaseQueryable, account: string, collection: string, source: LegacyMigrationSource
): Promise<"timers_not_imported" | "timers_source_changed" | "timers_identity_mismatch" | null> {
  const recorded = (await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM audit_events WHERE user_id = $1 AND event_type = $2 AND subject_id = $3
     ORDER BY created_at DESC, id DESC LIMIT 1`, [account, TIMER_IMPORT_EVENT, collection]
  )).rows[0];
  const manifest = manifestSchema.safeParse(recorded?.metadata);
  if (!manifest.success || manifest.data.collection_id !== collection) return "timers_not_imported";
  if (!sameRun(source, manifest.data) || source.notificationWatermark !== manifest.data.notification_watermark) {
    return "timers_source_changed";
  }
  const target = await targetIdentity(db, collection);
  return target.timers === manifest.data.timers && target.identity_sha256 === manifest.data.identity_sha256
    ? null : "timers_identity_mismatch";
}
