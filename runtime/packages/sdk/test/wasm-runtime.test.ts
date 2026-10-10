/**
 * The SDK against the real `runtime.wasm` (built by `cargo xtask wasm`). Skipped when
 * the module is absent; CI's wasm job runs it after building.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, inProcessConnector } from "../src/index.js";
import { WasmRuntime } from "../src/runtime/wasm.js";
import { uuidv7 } from "../src/values.js";

const path = process.env.MDBN_RUNTIME_WASM ?? join(import.meta.dirname, "../../../target/wasm/runtime.wasm");
// Skip when the module is absent, or predates the client ABI (rt_* exports).
// Skip when the module is absent, predates the client ABI, or needs host imports this
// test doesn't provide (a file-store build: see wasm-filestore.test.ts).
const KNOWN = new Set(["host_now_ms", "host_random", "host_local_date", "host_default_zone"]);
const mod = existsSync(path) ? new WebAssembly.Module(readFileSync(path)) : null;
const have =
  !!mod &&
  WebAssembly.Module.exports(mod).some((e) => e.name === "rt_info") &&
  WebAssembly.Module.imports(mod).every((i) => KNOWN.has(i.name)) &&
  !WebAssembly.Module.exports(mod).some((e) => e.name === "rt_host_take");

describe.skipIf(!have)("runtime.wasm", () => {
  it("reports info for the shared-runtime registry", async () => {
    const rt = await WasmRuntime.instantiate(readFileSync(path));
    const info = rt.info();
    expect(info.abiMajor).toBe(1);
    expect(info.serves).toContainEqual({ major: 1, minor: 0 });
    expect(info.sem.major).toBeGreaterThanOrEqual(1);
  });

  it("opens a replica and answers hello through the frame layer", async () => {
    const rt = await WasmRuntime.instantiate(readFileSync(path));
    rt.open({
      collection: uuidv7(),
      replicaId: uuidv7(),
      deviceId: uuidv7(),
      mode: "local_only",
      signSecretKey: crypto.getRandomValues(new Uint8Array(32)),
      kemSecretKey: crypto.getRandomValues(new Uint8Array(32)),
    });
    const c = await connect({ app: { name: "t", version: "0" }, connector: inProcessConnector(rt), reconnect: false });
    expect(c.hello.version.major).toBe(1);
    // A live query is served by the real replica through the frame layer.
    const live = c.live({});
    await live.ready;
    expect(live.stale).toBe(false);
    // Planning has shipped. Local-only acknowledges its local Store, not a log
    // acceptance/save guarantee. Refuse the old pending/not_implemented escape.
    const w = await c.create({ path: "a.md", body: "hi" });
    expect((await c.getStatus()).mode).toBe("local_only");
    expect(w.state).toBe("confirmed");
    expect((await w.confirmed).state).toBe("confirmed");
    expect(w.records).toHaveLength(1);
    const record = await c.get(w.records[0]!.id, { body: true });
    expect(record.path).toBe("a.md");
    expect(record.body).toBe("hi");
    c.close();
    rt.dispose();
  });
});
