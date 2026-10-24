/**
 * The SDK against the real `runtime.wasm` (built by `cargo xtask wasm`).
 * Missing or incompatible artifacts fail: the SDK CI job builds it before tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connect, inProcessConnector } from "../src/index.js";
import { WasmRuntime } from "../src/runtime/wasm.js";
import { uuidv7 } from "../src/values.js";

const path = process.env.MDBN_RUNTIME_WASM ?? join(import.meta.dirname, "../../../target/wasm/runtime.wasm");
const KNOWN = new Set(["host_now_ms", "host_random", "host_local_date", "host_default_zone"]);
let mod: WebAssembly.Module;
try {mod = new WebAssembly.Module(readFileSync(path));}
catch {throw new Error(`runtime.wasm is missing or invalid at ${path}; build it with cargo xtask wasm before running SDK integration tests.`);}
if (!WebAssembly.Module.exports(mod).some(e => e.name === "rt_info") ||
    !WebAssembly.Module.imports(mod).every(i => i.module === "env" && i.kind === "function" && KNOWN.has(i.name)) ||
    WebAssembly.Module.exports(mod).some(e => e.name === "rt_host_take")) {
  throw new Error(`runtime.wasm has an incompatible client ABI at ${path}; build the default runtime with cargo xtask wasm.`);
}

describe("runtime.wasm", () => {
  it("reports info for the shared-runtime registry", async () => {
    const rt = await WasmRuntime.instantiate(readFileSync(path));
    const info = rt.info();
    expect(info.abiMajor).toBe(1);
    expect(info.serves).toContainEqual({ major: 1, minor: 0 });
    expect(info.sem.major).toBeGreaterThanOrEqual(1);
  });

  it("serves version-one canonical contract inspection through the actual WASM frame path", async () => {
    const rt = await WasmRuntime.instantiate(readFileSync(path));
    rt.open({ collection: uuidv7(), replicaId: uuidv7(), deviceId: uuidv7(), mode: "local_only", signSecretKey: crypto.getRandomValues(new Uint8Array(32)), kemSecretKey: crypto.getRandomValues(new Uint8Array(32)) });
    const c = await connect({ app: { name: "contract-reader", version: "1" }, connector: inProcessConnector(rt), reconnect: false });
    const contract = { id: "mdbase.person", version: "2.0.0" };
    try {
      await expect(c.queryContract(contract)).rejects.toMatchObject({ code: "not_found", reason: "data_contract_not_found" });
      await c.resources.put("_contracts/person.md", "---\nkind: mdbase.contract\ncontract_type: record\nid: mdbase.person\nversion: 2.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      name: {type: string}\n---\n");
      await c.resources.put("_types/contact.md", "---\nkind: mdbase.type\nname: aliasContact\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n    properties:\n      full_name: {type: string}\nimplements:\n  - contract: mdbase.person\n    version: 2.0.0\n    fields: {'/name': '/full_name'}\n---\n");
      const write = await c.create({ path: "people/a.md", type: "aliasContact", frontmatter: { full_name: "Projected", name: "Not the mapped name" } });
      const result = await c.queryContract(contract);
      expect(result.version).toBe(1); expect(result.page.complete).toBe(true);
      expect(result.records).toHaveLength(1); expect(result.records[0]!.id).toBe(write.records[0]!.id);
      expect(result.records[0]!.implementations[0]).toMatchObject({ typeName: "aliasContact", issues: [] });
      expect(result.records[0]!.implementations[0]!.fields.get("name")).toBe("Projected");
      await expect(c.queryContract(contract, { pageSize: 1 })).rejects.toMatchObject({ code: "upgrade_required", reason: "contract_query_cursor_required" });
    } finally { c.close(); rt.dispose(); }
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
