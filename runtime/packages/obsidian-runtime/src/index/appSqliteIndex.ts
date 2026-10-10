/** First-party SQL-record app storage on the shared SQLite batch adapter.
 * FULL/flush settings are a candidate profile, NOT physical-durability evidence.
 * info.durability remains Disposable: the app's typed tentative-store composition
 * must preserve pending work, and only log-confirmed receipts mean saved. */
import { classifyError, IndexError, SqliteIndex, type Batch, type IndexInfo, type IndexResultLimits, type StmtResult } from "./sqliteIndex.js";
export { APP_INDEX_LIMITS, AppBinaryIndexHost, appSqlHost } from "./appIndexHost.js";
export type { AppSqlWasmExports } from "./appIndexHost.js";

export interface AppStorageScope {
  account: string;
  installation: string;
  collection: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Different account/install namespaces cannot reopen another scope's state. */
export function appPoolNames(scope: AppStorageScope): { vfs: string; directory: string } {
  const ids = [scope.account, scope.installation, scope.collection];
  if (ids.some((id) => !UUID.test(id))) throw new IndexError("Other", "invalid app storage scope");
  const name = `mdbase-app-${ids.map((id) => id.toLowerCase()).join("-")}`;
  return { vfs: name, directory: `.${name}` };
}

/** Reuses SqliteIndex's prepared statements/codecs. Any operation error fences the
 * whole handle, including COMMIT uncertainty. No automatic retry/wipe/reset. */
export class AppSqliteIndex {
  private fenced = false;
  private closed = false;
  constructor(private readonly inner: SqliteIndex) {}

  get info(): IndexInfo { return this.inner.info; }
  get needsRecovery(): boolean { return this.fenced; }

  /** Fence after an ABI failure as well as a SQLite error; close cannot mark clean. */
  fence(): void { this.fenced = true; }

  run(batch: Batch, limits?: IndexResultLimits): StmtResult[] {
    if (this.closed || this.fenced) throw new IndexError("Other", "app database fenced or closed; reopen and reconcile");
    try {
      return limits ? this.inner.run(batch, limits) : this.inner.run(batch);
    } catch (error) {
      this.fenced = true;
      const classified = classifyError(error);
      throw new IndexError(classified.kind, "app SQLite operation failed; reopen and reconcile", classified.stmt);
    }
  }

  /** The Rust IndexStorage reset hook must never erase app pending/recovery data. */
  reset(): never {
    throw new IndexError("Other", "app database reset requires explicit recovery; automatic wipe refused");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inner.close({ markClean: !this.fenced });
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Worker only, called while the account/install/collection owner lock is held.
 * SQLite/runtime.wasm must share this Worker. A missing/unsupported VFS is an error;
 * no in-memory fallback and no application-store wipe option. */
export async function openAppSahpoolIndex(sqlite3: any, scope: AppStorageScope): Promise<{ index: AppSqliteIndex; pool: any }> {
  const names = appPoolNames(scope);
  let pool: any;
  let db: any;
  let index: AppSqliteIndex | undefined;
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: names.vfs, directory: names.directory, initialCapacity: 6 });
    if (pool.isPaused?.()) await pool.unpauseVfs();
    db = new pool.OpfsSAHPoolDb("/app.db");
    const inner = SqliteIndex.open(sqlite3, db, { synchronous: "FULL", verifyPragmas: true });
    index = new AppSqliteIndex(inner);
    if (inner.info.opened === "Unclean") {
      const check = index.run({ mode: "Autocommit", stmts: [{ sql: "PRAGMA quick_check", params: [] }] });
      const values = check[0]?.values;
      if (check.length !== 1 || values?.length !== 1 || values[0]?.kind !== "Text" || values[0].value !== "ok") {
        // Do not mark an integrity-failed handle clean.
        index = undefined;
        inner.close({ markClean: false });
        db = undefined;
        throw new IndexError("Corrupt", "app database integrity check failed; recovery required");
      }
    }
    return { index, pool };
  } catch (error) {
    let cleanupFailed = false;
    try {
      if (index) index.close();
      else db?.close();
    } catch { cleanupFailed = true; }
    try { pool?.pauseVfs?.(); } catch { cleanupFailed = true; }
    const classified = classifyError(error);
    throw new IndexError(cleanupFailed ? "Other" : classified.kind, "app SQLite open failed; recovery required", classified.stmt);
  }
}
