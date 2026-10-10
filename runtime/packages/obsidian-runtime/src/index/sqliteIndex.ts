/**
 * `IndexStorage` on the official sqlite-wasm with the `opfs-sahpool` VFS
 * (`crates/store-file/src/index.rs`).
 *
 * - **Runs in a dedicated Worker**, the same Worker as `runtime.wasm`.
 *   `opfs-sahpool` is synchronous only there, and `IndexStorage` calls are
 *   synchronous WASM→JS imports. No SharedArrayBuffer is needed, and Android
 *   WebView 133 has none.
 * - **Pragmas:** `locking_mode=EXCLUSIVE`, `journal_mode=WAL`, `synchronous=NORMAL`.
 *   These configure the disposable index, not a non-derived durability guarantee.
 * - **Names are per collection** (shared-origin isolation): every plugin and every vault window
 *   in one Obsidian profile shares the origin. The VFS is `mdbase-<collection>`,
 *   the OPFS directory `.mdbase-index-<collection>`. A second opener of the same
 *   pool fails fast with `NoModificationAllowedError`, which maps to `Busy`.
 * - **Disposable.** The store keeps only derived data here
 *   (`IndexDurability::Disposable`). The backend reports:
 *   - `Corrupt` for `SQLITE_CORRUPT`/`NOTADB`;
 *   - `Full` for `SQLITE_FULL` and any `QuotaExceededError`. WebView 133
 *     may report implausible OPFS usage after force-stops, so "full" here
 *     means rebuild or compact, never "disk full";
 *   - `Unclean` at open after a shutdown without {@link SqliteIndex.close}, and
 *     the store runs `PRAGMA quick_check`.
 * - **Batches** cross the boundary once ([`Batch`]): one prepared-statement cache
 *   keyed by SQL text, flattened row values.
 */

/** `SqlValue`. Integers are `bigint` (SQLite's 64-bit range). */
export type SqlValue =
  | { readonly kind: "Null" }
  | { readonly kind: "Integer"; readonly value: bigint }
  | { readonly kind: "Real"; readonly value: number }
  | { readonly kind: "Text"; readonly value: string }
  | { readonly kind: "Blob"; readonly value: Uint8Array };

/** `Stmt`. */
export interface Stmt {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** `Batch`. */
export interface Batch {
  readonly mode: "Transaction" | "Autocommit";
  readonly stmts: readonly Stmt[];
}

/** `StmtResult`. */
export interface StmtResult {
  readonly columns: number;
  readonly values: SqlValue[];
  readonly changes: bigint;
  readonly lastInsertRowid: bigint;
}

/** Optional app binary transport result envelope; enforced during row iteration. */
export interface IndexResultLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxValues: number;
  readonly maxColumns: number;
}

/** `IndexErrorKind`. */
export type IndexErrorKind = "Corrupt" | "Full" | "Busy" | "Sql" | "Other";

/** `IndexError`. */
export class IndexError extends Error {
  constructor(
    readonly kind: IndexErrorKind,
    readonly detail: string,
    readonly stmt: number | null = null,
  ) {
    super(`${kind}${stmt === null ? "" : `@${stmt}`}(${detail})`);
    this.name = "IndexError";
  }
}

/** `IndexInfo`. */
export interface IndexInfo {
  readonly durability: "Durable" | "Disposable";
  readonly opened: "Fresh" | "Existing" | "Unclean";
  readonly sqliteVersion: number;
  /** `navigator.storage.estimate()` reported implausible usage (quota sanity check). */
  readonly quotaSuspect: boolean;
}

// ---- the subset of sqlite-wasm used -------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sqlite3 = any;
type DB = any;
type PreparedStmt = any;

const SQLITE_INTEGER = 1;
const SQLITE_FLOAT = 2;
const SQLITE_TEXT = 3;
const SQLITE_BLOB = 4;
const SQLITE_NULL = 5;

/** Map an exception from sqlite-wasm (or OPFS) to an `IndexError`. */
export function classifyError(e: unknown, stmt: number | null = null): IndexError {
  if (e instanceof IndexError) return e;
  const name = (e as { name?: string })?.name ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  const rc = (e as { resultCode?: number })?.resultCode;
  const primary = typeof rc === "number" ? rc & 0xff : null;
  if (name === "QuotaExceededError" || /quota/i.test(msg) || primary === 13) return new IndexError("Full", msg, stmt);
  if (primary === 11 || primary === 26 || /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(msg)) return new IndexError("Corrupt", msg, stmt);
  if (name === "NoModificationAllowedError" || primary === 5 || primary === 6 || /SQLITE_BUSY|SQLITE_LOCKED|NoModificationAllowed/i.test(msg)) return new IndexError("Busy", msg, stmt);
  if (primary === 1 || primary === 19 || primary === 20 || primary === 25 || /SQLITE_ERROR|SQLITE_CONSTRAINT|syntax/i.test(msg)) return new IndexError("Sql", msg, stmt);
  return new IndexError("Other", msg, stmt);
}

/** Never turn an already-rounded JS number into a purported exact SQLite integer. */
function exactInteger(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new IndexError("Other", "SQLite integer is not losslessly represented");
}

/** Host bookkeeping, outside the store's schema: the clean-shutdown flag. */
const HOST_TABLE = "CREATE TABLE IF NOT EXISTS _mdbn_host(k TEXT PRIMARY KEY, v) WITHOUT ROWID";

/** One open index database. Synchronous, as `IndexStorage` is. */
export class SqliteIndex {
  private readonly cache = new Map<string, PreparedStmt>();
  private closed = false;

  constructor(
    private readonly sqlite3: Sqlite3,
    private readonly db: DB,
    readonly info: IndexInfo,
  ) {}

  /**
   * Open `db` (already constructed on the right VFS): apply the pragmas, read and
   * set the clean-shutdown flag.
   */
  static open(sqlite3: Sqlite3, db: DB, opts: { pragmas?: boolean; quotaSuspect?: boolean; synchronous?: "NORMAL" | "FULL"; verifyPragmas?: boolean } = {}): SqliteIndex {
    try {
      const synchronous = opts.synchronous ?? "NORMAL";
      if (synchronous !== "NORMAL" && synchronous !== "FULL") throw new IndexError("Other", "unsupported synchronous profile");
      if (opts.pragmas !== false) {
        db.exec("PRAGMA locking_mode=EXCLUSIVE");
        db.exec("PRAGMA journal_mode=WAL");
        db.exec(`PRAGMA synchronous=${synchronous}`);
      }
      if (opts.verifyPragmas && (
        String(db.selectValue("PRAGMA locking_mode")).toLowerCase() !== "exclusive" ||
        String(db.selectValue("PRAGMA journal_mode")).toLowerCase() !== "wal" ||
        db.selectValue("PRAGMA synchronous") !== (synchronous === "FULL" ? 2 : 1)
      )) throw new IndexError("Other", "SQLite did not apply the requested storage profile");
      const hadHost = db.selectValue("SELECT count(*) FROM sqlite_master WHERE name='_mdbn_host'") > 0;
      const tables = db.selectValue("SELECT count(*) FROM sqlite_master") as number;
      db.exec(HOST_TABLE);
      let opened: IndexInfo["opened"] = "Fresh";
      if (hadHost) {
        const clean = db.selectValue("SELECT v FROM _mdbn_host WHERE k='clean'");
        opened = clean === 1 ? "Existing" : "Unclean";
      } else if (tables > 0) {
        opened = "Unclean"; // tables but no flag: treat as untrusted
      }
      db.exec("INSERT OR REPLACE INTO _mdbn_host(k, v) VALUES ('clean', 0)");
      return new SqliteIndex(sqlite3, db, {
        durability: "Disposable",
        opened,
        sqliteVersion: sqlite3.capi.sqlite3_libversion_number(),
        quotaSuspect: opts.quotaSuspect ?? false,
      });
    } catch (e) {
      throw classifyError(e);
    }
  }

  private prepare(sql: string): PreparedStmt {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  private bind(st: PreparedStmt, params: readonly SqlValue[]): void {
    st.clearBindings();
    params.forEach((p, i) => {
      const idx = i + 1;
      switch (p.kind) {
        case "Null":
          st.bind(idx, null);
          break;
        case "Integer":
          st.bind(idx, p.value);
          break;
        case "Real":
          st.bind(idx, p.value);
          break;
        case "Text":
          st.bind(idx, p.value);
          break;
        case "Blob":
          st.bindAsBlob(idx, p.value);
          break;
      }
    });
  }

  private column(st: PreparedStmt, i: number): SqlValue {
    const capi = this.sqlite3.capi;
    switch (capi.sqlite3_column_type(st.pointer, i)) {
      case SQLITE_NULL:
        return { kind: "Null" };
      case SQLITE_INTEGER: {
        const v = capi.sqlite3_column_int64(st.pointer, i);
        return { kind: "Integer", value: exactInteger(v) };
      }
      case SQLITE_FLOAT:
        return { kind: "Real", value: capi.sqlite3_column_double(st.pointer, i) };
      case SQLITE_TEXT:
        return { kind: "Text", value: st.getString(i) };
      case SQLITE_BLOB:
        return { kind: "Blob", value: st.getBlob(i) ?? new Uint8Array(0) };
      default:
        return { kind: "Null" };
    }
  }

  /** `IndexStorage::run`. */
  run(batch: Batch, limits?: IndexResultLimits): StmtResult[] {
    if (this.closed) throw new IndexError("Other", "index closed");
    const capi = this.sqlite3.capi;
    const tx = batch.mode === "Transaction";
    const out: StmtResult[] = [];
    let rows = 0, valueCount = 0, bytes = 13;
    const addBytes = (n: number): void => {
      if (!limits) return;
      if (!Number.isSafeInteger(n) || n < 0 || n > limits.maxBytes - bytes) throw new IndexError("Full", "index reply byte budget exceeded");
      bytes += n;
    };
    if (limits && ([limits.maxBytes, limits.maxRows, limits.maxValues, limits.maxColumns].some((n) => !Number.isSafeInteger(n) || n < 0) || limits.maxBytes < bytes)) {
      throw new IndexError("Full", "invalid index reply budget");
    }
    if (tx) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch (e) {
        throw classifyError(e);
      }
    }
    for (let i = 0; i < batch.stmts.length; i++) {
      const s = batch.stmts[i]!;
      try {
        const st = this.prepare(s.sql);
        try {
          this.bind(st, s.params);
          const columns = st.columnCount as number;
          if (limits && (!Number.isSafeInteger(columns) || columns < 0 || columns > limits.maxColumns)) {
            throw new IndexError("Full", "index reply column budget exceeded");
          }
          addBytes(24);
          const values: SqlValue[] = [];
          while (st.step()) {
            if (limits && ++rows > limits.maxRows) throw new IndexError("Full", "index reply row budget exceeded");
            for (let c = 0; c < columns; c++) {
              if (limits) {
                if (++valueCount > limits.maxValues) throw new IndexError("Full", "index reply value budget exceeded");
                const tag = capi.sqlite3_column_type(st.pointer, c);
                if (tag === SQLITE_TEXT || tag === SQLITE_BLOB) {
                  // Check native byte length BEFORE copying a large string/blob into JS.
                  addBytes(5);
                  addBytes(capi.sqlite3_column_bytes(st.pointer, c));
                } else if (tag === SQLITE_INTEGER || tag === SQLITE_FLOAT) addBytes(9);
                else if (tag === SQLITE_NULL) addBytes(1);
                else throw new IndexError("Other", "unknown SQLite value type");
              }
              values.push(this.column(st, c));
            }
          }
          out.push({
            columns,
            values,
            changes: exactInteger(capi.sqlite3_changes(this.db.pointer)),
            lastInsertRowid: exactInteger(capi.sqlite3_last_insert_rowid(this.db.pointer)),
          });
        } finally {
          st.reset();
        }
      } catch (e) {
        if (tx) {
          try {
            this.db.exec("ROLLBACK");
          } catch {
            /* already rolled back */
          }
        }
        throw classifyError(e, i);
      }
    }
    if (tx) {
      try {
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw classifyError(e);
      }
    }
    return out;
  }

  /** Finalize statements and close. A fenced/uncertain handle must not be marked clean. */
  close(opts: { markClean?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    for (const st of this.cache.values()) {
      try {
        st.finalize();
      } catch {
        /* ignore */
      }
    }
    this.cache.clear();
    if (opts.markClean !== false) {
      try {
        this.db.exec("INSERT OR REPLACE INTO _mdbn_host(k, v) VALUES ('clean', 1)");
      } catch {
        /* best effort: next open reports Unclean */
      }
    }
    this.db.close();
  }
}

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
