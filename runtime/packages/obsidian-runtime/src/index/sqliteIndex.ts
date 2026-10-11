/** Obsidian's original collection-only disposable OPFS pool and explicit rebuild.
 * SQLite batches/codecs/clean flags share SDK's one canonical engine. App storage
 * remains separately account/installation/collection scoped and refuses reset. */
import { SqliteIndex, classifyError } from "@mdbase-dev/sdk/app-storage";
export { SqliteIndex, IndexError, classifyError } from "@mdbase-dev/sdk/app-storage";
export type { SqlValue, Stmt, Batch, StmtResult, IndexResultLimits, IndexInfo, IndexErrorKind } from "@mdbase-dev/sdk/app-storage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sqlite3 = any;
type DB = any;

/** Names scoped by collection (shared-origin isolation). */
export function poolNames(collectionId: string): { vfs: string; directory: string } {
  if (!/^[0-9a-f-]{36}$/i.test(collectionId)) throw new Error(`not a collection id: ${collectionId}`);
  const id = collectionId.toLowerCase();
  return { vfs: `mdbase-${id}`, directory: `.mdbase-index-${id}` };
}

/** True if `estimate()` reports implausible usage: near 2^32 for a small origin. */
export async function quotaLooksWrong(): Promise<boolean> {
  try {
    const est = await (globalThis.navigator as Navigator | undefined)?.storage?.estimate?.();
    if (!est || est.usage === undefined) return false;
    return est.usage > 4_000_000_000 && est.usage < 4_294_967_296 && (est.quota ?? Infinity) < 8_000_000_000;
  } catch {
    return false;
  }
}

/**
 * Open the index for `collectionId` on `opfs-sahpool`. Call in a dedicated
 * Worker. `wipe` drops the database first (rebuild after corruption or a quota
 * error).
 */
export async function openSahpoolIndex(sqlite3: Sqlite3, collectionId: string, opts: { wipe?: boolean } = {}): Promise<{ index: SqliteIndex; pool: any }> {
  const names = poolNames(collectionId);
  let pool: any;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: names.vfs, directory: names.directory, initialCapacity: 6 });
  } catch (e) {
    throw classifyError(e);
  }
  // A pool paused by an earlier close in this Worker must be resumed.
  if (pool.isPaused?.()) await pool.unpauseVfs();
  if (opts.wipe) await pool.wipeFiles();
  const quotaSuspect = await quotaLooksWrong();
  let db: DB;
  try {
    db = new pool.OpfsSAHPoolDb("/index.db");
  } catch (e) {
    throw classifyError(e);
  }
  return { index: SqliteIndex.open(sqlite3, db, { quotaSuspect }), pool };
}
