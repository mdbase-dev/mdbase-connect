/** Public original join-attempt marker, not a credential, key store, bootstrap
 * receipt or readiness proof. Preserves the caller's exact existing namespace,
 * version, scope tuple and record shape; no aliases, reset or actor substitution. */
import type { AppReplicaScope } from "./owner.js";

const STORE = "original-join";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
export class AppCollectionJoinError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "busy" | "recovery_required") {
    super(`app collection join: ${reason}`); this.name = "AppCollectionJoinError";
  }
}
const fail = (reason: AppCollectionJoinError["reason"] = "recovery_required") => new AppCollectionJoinError(reason);
export interface AppCollectionJoinLedgerOptions {
  /** Exact configured original database name. Never infer an alias/new database
   * after an existing-store failure. The SDK supplies no app-specific default. */
  readonly databaseName: string;
  readonly scope: Readonly<AppReplicaScope>;
  /** Actual SAME installation/collection owner, not a consent or status flag. */
  isCurrent(): boolean;
}
export interface AppCollectionJoinAttempt {
  readonly outcomeMode: "fresh" | "existing";
  readonly phase: "attempted" | "completed";
}
interface Marker extends AppReplicaScope { version: 1; phase: AppCollectionJoinAttempt["phase"] }

export class AppCollectionJoinLedger {
  private readonly options: Readonly<AppCollectionJoinLedgerOptions>;
  private readonly key: string;
  private busy = false;
  constructor(options: AppCollectionJoinLedgerOptions) {
    const scope = Object.freeze({account: options.scope.account, installation: options.scope.installation, collection: options.scope.collection});
    if (Object.values(scope).some(value => typeof value !== "string" || !UUID.test(value) || value === NIL) ||
        typeof options.databaseName !== "string" || !options.databaseName.length || options.databaseName.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(options.databaseName) || typeof options.isCurrent !== "function") throw fail("binding");
    this.options = Object.freeze({databaseName: options.databaseName, scope, isCurrent: options.isCurrent});
    // Original ordered tuple, unchanged from existing callers.
    this.key = JSON.stringify([scope.account, scope.installation, scope.collection]);
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted || this.options.isCurrent() !== true) throw fail("fenced");
  }
  private marker(value: unknown): Marker {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== "account,collection,installation,phase,version") throw fail();
    const marker = value as Marker;
    if (marker.version !== 1 || (marker.phase !== "attempted" && marker.phase !== "completed") ||
        Object.entries(this.options.scope).some(([key, expected]) => marker[key as keyof AppReplicaScope] !== expected)) throw fail();
    return marker;
  }
  private open(signal: AbortSignal): Promise<IDBDatabase> {
    this.check(signal); if (!globalThis.indexedDB) throw fail();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.options.databaseName, 1);
      let abandoned = false;
      const finish = () => signal.removeEventListener("abort", stop);
      const stop = () => {
        abandoned = true; finish();
        try { request.transaction?.abort(); } catch { /* already committed state remains */ }
        reject(fail());
      };
      signal.addEventListener("abort", stop, {once: true});
      request.onblocked = request.onerror = stop;
      request.onupgradeneeded = () => {
        try {
          this.check(signal); if (abandoned || request.result.objectStoreNames.length) throw fail();
          request.result.createObjectStore(STORE);
        } catch { try { request.transaction?.abort(); } catch { /* preserve */ } }
      };
      request.onsuccess = () => {
        finish();
        try {
          this.check(signal);
          if (abandoned || request.result.objectStoreNames.length !== 1 || !request.result.objectStoreNames.contains(STORE)) throw fail();
          resolve(request.result);
        } catch { request.result.close(); reject(fail()); }
      };
    });
  }
  private async change(change: "prepare" | "complete", signal: AbortSignal): Promise<AppCollectionJoinAttempt> {
    this.check(signal); if (this.busy) throw fail("busy"); this.busy = true;
    let db: IDBDatabase | null = null;
    try {
      db = await this.open(signal); this.check(signal);
      return await new Promise<AppCollectionJoinAttempt>((resolve, reject) => {
        this.check(signal);
        const tx = db!.transaction(STORE, "readwrite", {durability: "strict"});
        let result: AppCollectionJoinAttempt | null = null, reason: unknown;
        const abort = () => { try { tx.abort(); } catch { /* possible commit retained */ } };
        const finish = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, {once: true});
        tx.onabort = tx.onerror = () => {finish(); reject(reason ?? fail());};
        tx.oncomplete = () => {
          finish();
          try { this.check(signal); if (!result) throw fail(); resolve(Object.freeze(result)); }
          catch { reject(fail()); }
        };
        const records = tx.objectStore(STORE), request = records.get(this.key);
        request.onsuccess = () => {
          try {
            this.check(signal);
            const previous = request.result;
            if (previous === undefined) {
              if (change !== "prepare") throw fail();
              records.add({version: 1, ...this.options.scope, phase: "attempted"} satisfies Marker, this.key);
              result = {outcomeMode: "fresh", phase: "attempted"};
            } else {
              const marker = this.marker(previous);
              if (change === "complete" && marker.phase !== "completed") records.put({...marker, phase: "completed"}, this.key);
              result = {outcomeMode: "existing", phase: change === "complete" ? "completed" : marker.phase};
            }
          } catch (error) { reason = error; abort(); }
        };
      });
    } catch (error) { if (error instanceof AppCollectionJoinError) throw error; throw fail(); }
    finally { db?.close(); this.busy = false; }
  }
  /** Commit ONE attempted marker before any bootstrap HTTP. An existing attempt
   * chooses EXISTING protected outcome intake, never permits automatic rePOST.
   * Actual SDK protected storage independently refuses missing/partial state. */
  prepare(options: {signal: AbortSignal}): Promise<AppCollectionJoinAttempt> {
    return this.change("prepare", options.signal);
  }
  /** Whether this device's replica of the collection has caught up with the
   * log once before. Kept under its own key so the join marker keeps its
   * original shape. A failed read answers false (wait for a full catch-up). */
  async syncedBefore(options: {signal: AbortSignal}): Promise<boolean> {
    return (await this.synced("read", options.signal)) === true;
  }
  /** Record the first completed catch-up. Best effort. */
  async markSynced(options: {signal: AbortSignal}): Promise<void> {
    await this.synced("mark", options.signal);
  }
  private async synced(change: "read" | "mark", signal: AbortSignal): Promise<boolean> {
    let db: IDBDatabase | null = null;
    try {
      db = await this.open(signal); this.check(signal);
      const key = JSON.stringify([this.options.scope.account, this.options.scope.installation, this.options.scope.collection, "synced"]);
      return await new Promise<boolean>(resolve => {
        const tx = db!.transaction(STORE, change === "mark" ? "readwrite" : "readonly");
        let found = false;
        tx.onabort = tx.onerror = () => resolve(false);
        tx.oncomplete = () => resolve(change === "mark" || found);
        const records = tx.objectStore(STORE);
        if (change === "mark") records.put({version: 1, synced: true}, key);
        else {
          const request = records.get(key);
          request.onsuccess = () => {
            const value = request.result as {version?: unknown; synced?: unknown} | undefined;
            found = !!value && value.version === 1 && value.synced === true;
          };
        }
      });
    } catch { return false; }
    finally { db?.close(); }
  }
  /** Call only after the SAME protected SDK completion. The marker is history,
   * never a bootstrap receipt, native readable proof or setup permission. */
  async complete(options: {signal: AbortSignal}): Promise<void> {
    await this.change("complete", options.signal);
  }
}
