/**
 * The index Worker entry: owns sqlite-wasm and the `opfs-sahpool` database for
 * one collection. `runtime.wasm` will run in this same Worker, calling
 * {@link SqliteIndex.run} as a synchronous import. Until the runtime ABI lands,
 * the Worker also answers RPCs, which the main thread and the e2e suite use.
 *
 * Messages are `{id, op, ...}` with `op` one of `open`, `run`, `info`, `close`.
 * Replies are `{id, ok, value | error: {kind, detail, stmt}}`.
 */

import { IndexError, openSahpoolIndex, type Batch, type SqliteIndex } from "./sqliteIndex.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const self: any;

type Req =
  | { id: number; op: "open"; collectionId: string; wasm: ArrayBuffer; wipe?: boolean }
  | { id: number; op: "run"; batch: Batch }
  | { id: number; op: "info" }
  | { id: number; op: "close" };

/** Install the RPC handler. `init` loads sqlite-wasm from the bytes the host passes. */
export function serveIndexWorker(init: (wasm: ArrayBuffer) => Promise<any>): void {
  let sqlite3: any = null;
  let index: SqliteIndex | null = null;
  let pool: any = null;
  self.onmessage = async (ev: { data: Req }) => {
    const m = ev.data;
    const reply = (value: unknown) => self.postMessage({ id: m.id, ok: true, value });
    try {
      switch (m.op) {
        case "open": {
          sqlite3 ??= await init(m.wasm);
          if (index) index.close();
          const r = await openSahpoolIndex(sqlite3, m.collectionId, { wipe: m.wipe });
          index = r.index;
          pool = r.pool;
          reply(index.info);
          break;
        }
        case "run":
          if (!index) throw new IndexError("Other", "not open");
          reply(index.run(m.batch));
          break;
        case "info":
          reply(index?.info ?? null);
          break;
        case "close":
          index?.close();
          index = null;
          // Release the pool's access handles so another context can open it.
          // (Not removeVfs: that deletes the pool's files.)
          try {
            pool?.pauseVfs?.();
          } catch {
            /* already paused */
          }
          pool = null;
          reply(null);
          break;
      }
    } catch (e) {
      const err = e instanceof IndexError ? e : new IndexError("Other", String(e));
      self.postMessage({ id: m.id, ok: false, error: { kind: err.kind, detail: err.detail, stmt: err.stmt } });
    }
  };
}
