// Index Worker bundle for the e2e plugin: sqlite-wasm from bytes the host passes.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { serveIndexWorker } from "../../../src/index/worker.js";

serveIndexWorker(async (wasm: ArrayBuffer) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sqlite3InitModule as any)({
    print: () => {},
    printErr: (...a: unknown[]) => console.warn("[sqlite3]", ...a),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instantiateWasm(imports: any, cb: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
      WebAssembly.instantiate(wasm, imports).then((r) => cb(r.instance, r.module));
      return {};
    },
  }),
);
