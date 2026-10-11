/** Concrete SAME-Worker SQL intake for AppWebCloudCopyHost.openCollectionSql.
 * The BUILD supplies its pinned initializer/bytes, never a discovered runtime.
 * SQL/VFS close belongs to the native host, after native shutdown. */
import { AppSqliteIndex, appPoolNames, openAppSahpoolIndex } from "./app-sqlite-index.js";
import { AppBinaryIndexHost, appSqlHost } from "./app-binary-index.js";
import type { AppReplicaScope } from "../app-host/owner.js";
import type { AppSqlLifetime } from "../app-host/wasm-runtime.js";

export interface AppCollectionSqlOptions {
  readonly wasmSha256: string;
  readonly maxWasmBytes: number;
  loadWasm(options: {signal: AbortSignal}): Promise<Uint8Array>;
  /** Bundled official sqlite-wasm initializer; only verified bytes and silent
   * logging are supplied. This is trusted Worker code, not an app-message port. */
  initialize(options: {wasmBinary: Uint8Array; print(): void; printErr(): void}): Promise<unknown>;
}
export interface AppOpenedCollectionSql {
  readonly sql: AppSqlLifetime;
  readonly opened: "fresh" | "existing" | "unclean";
  readonly sqliteVersion: number;
  close(): Promise<void>;
}
export class AppCollectionSqlError extends Error {
  constructor(readonly reason: "binding" | "unsupported" | "fenced" | "unavailable") {
    super(`app collection SQL: ${reason}`); this.name = "AppCollectionSqlError";
  }
}
const fail = (reason: AppCollectionSqlError["reason"]) => new AppCollectionSqlError(reason);

export function createAppCollectionSql(source: AppCollectionSqlOptions): (input: {
  scope: Readonly<AppReplicaScope>; signal: AbortSignal;
}) => Promise<AppOpenedCollectionSql> {
  const options = Object.freeze({...source});
  if (!/^[0-9a-f]{64}$/.test(options.wasmSha256) || !Number.isSafeInteger(options.maxWasmBytes)
    || options.maxWasmBytes < 1 || options.maxWasmBytes > 4 * 1024 * 1024
    || typeof options.loadWasm !== "function" || typeof options.initialize !== "function") throw fail("binding");
  return async ({scope, signal}) => {
    const original = Object.freeze({account: scope.account, installation: scope.installation, collection: scope.collection});
    appPoolNames(original); // validate exact physical scope BEFORE initializer/storage IO
    const check = () => {
      if (signal.aborted || Object.entries(original).some(([key, value]) => scope[key as keyof AppReplicaScope] !== value)) throw fail("fenced");
    };
    check();
    const WorkerScope = (globalThis as typeof globalThis & {WorkerGlobalScope?: new () => object}).WorkerGlobalScope;
    if (typeof WorkerScope !== "function" || !(globalThis instanceof WorkerScope)) throw fail("unsupported");
    const supplied = await options.loadWasm({signal}); check();
    if (!(supplied instanceof Uint8Array) || supplied.byteLength < 1 || supplied.byteLength > options.maxWasmBytes) throw fail("binding");
    const bytes = new Uint8Array(supplied);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); check();
    if (Array.from(hash, value => value.toString(16).padStart(2, "0")).join("") !== options.wasmSha256) throw fail("binding");
    const sqlite = await options.initialize({wasmBinary: bytes, print() {}, printErr() {}}); check();
    const opened = await openAppSahpoolIndex(sqlite, original);
    const index: AppSqliteIndex = opened.index;
    const binary = new AppBinaryIndexHost(index);
    const sql: AppSqlLifetime = {
      import: exports => appSqlHost(binary, exports),
      fence: () => binary.fence(),
      get needsRecovery() { return binary.needsRecovery; },
    };
    let closing: Promise<void> | null = null;
    const close = () => closing ??= Promise.resolve().then(async () => {
      try { index.close(); await opened.pool.pauseVfs(); }
      catch { binary.fence(); throw fail("unavailable"); }
    });
    // After acquisition return cleanup EVEN if cancellation arrived while opening.
    // Host retains this result before its current-scope check, so it closes SQL
    // LAST. Throwing here would orphan SQL outside the host's failed-stop custody.
    if (signal.aborted || Object.entries(original).some(([key, value]) => scope[key as keyof AppReplicaScope] !== value)) binary.fence();
    return Object.freeze({sql, opened: ({Fresh: "fresh", Existing: "existing", Unclean: "unclean"} as const)[index.info.opened], sqliteVersion: index.info.sqliteVersion, close});
  };
}
