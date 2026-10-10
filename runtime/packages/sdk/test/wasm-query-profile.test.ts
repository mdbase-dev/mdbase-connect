import { afterEach, describe, expect, it, vi } from "vitest";
import * as cbor from "../src/cbor.js";
import { WasmRuntime, type OpenConfig, type QueryExecutionProfile } from "../src/index.js";

const config = (): OpenConfig => ({
  collection: "0192f3a4-6000-7abc-8def-0123456789ab",
  replicaId: "0192f3a4-6000-7abc-8def-0123456789ac",
  deviceId: "0192f3a4-6000-7abc-8def-0123456789ad",
  mode: "local_only", signSecretKey: new Uint8Array(32).fill(41), kemSecretKey: new Uint8Array(32).fill(42),
});
afterEach(() => vi.restoreAllMocks());

async function runtime(capability: unknown, outcome = "success") {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const alloc = vi.fn(() => { if (outcome === "allocation") throw new Error("allocation"); return 1024; });
  const tags: Array<number | undefined> = [], configs: cbor.CborValue[] = [];
  const open = (ptr: number, len: number, tag?: number) => {
    tags.push(tag);
    const input = new Uint8Array(memory.buffer, ptr, len);
    configs.push(cbor.decode(input));
    if (outcome === "trap") throw new WebAssembly.RuntimeError("trap");
    input.fill(0); // Models consuming Rust ABI on ordinary return.
    if (outcome === "refused") {
      const error = new TextEncoder().encode("refused");
      new Uint8Array(memory.buffer, 4096, error.length).set(error);
      return (4096n << 32n) | BigInt(error.length);
    }
    return 0n;
  };
  const exports = { memory, alloc, dealloc: vi.fn(), rt_open: open,
    rt_open_profile: capability === true ? open : capability };
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({ instance: { exports } } as unknown as WebAssembly.Instance);
  return { rt: await WasmRuntime.instantiate(new Uint8Array()), alloc, tags, configs };
}

describe("trusted one-time WASM query profile bootstrap (ABI-export models)", () => {
  it.each([undefined, false, 0, "function"])("requires the exact export before secret encoding/allocation: %s", async capability => {
    const f = await runtime(capability), encode = vi.spyOn(cbor, "encodeSecret");
    try {
      for (const queryExecutionProfile of ["desktop", "memory_constrained"] as const) {
        expect(() => f.rt.open({ ...config(), queryExecutionProfile })).toThrowError(expect.objectContaining({ code: "unavailable" }));
      }
      expect(encode).not.toHaveBeenCalled(); expect(f.alloc).not.toHaveBeenCalled();
      // Refusal before ownership transfer does not discard a compatible legacy module.
      f.rt.open(config()); expect(f.tags).toEqual([undefined]);
    } finally { f.rt.dispose(); }
  });
  it("rejects an unknown caller profile before encoding/allocation", async () => {
    const f = await runtime(true), encode = vi.spyOn(cbor, "encodeSecret");
    try {
      expect(() => f.rt.open({ ...config(), queryExecutionProfile: "global" as QueryExecutionProfile })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
      expect(encode).not.toHaveBeenCalled(); expect(f.alloc).not.toHaveBeenCalled();
    } finally { f.rt.dispose(); }
  });
  it.each([["memory_constrained", 0], ["desktop", 1]] as const)("selects %s via fixed tag %s, not a config slot", async (queryExecutionProfile, tag) => {
    const f = await runtime(true);
    try {
      f.rt.open({ ...config(), queryExecutionProfile }); expect(f.tags).toEqual([tag]);
      expect([...(f.configs[0] as Map<number, cbor.CborValue>).keys()]).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(() => f.rt.open(config())).toThrowError(expect.objectContaining({ code: "unavailable" }));
      expect(() => f.rt.open({ ...config(), queryExecutionProfile: "desktop" })).toThrow();
      expect(f.alloc).toHaveBeenCalledTimes(1); expect(f.tags).toEqual([tag]);
    } finally { f.rt.dispose(); }
  });
  it.each(["success", "refused", "trap", "allocation"])("preserves config-copy wipe and uncertain ownership discard after %s", async outcome => {
    const f = await runtime(true, outcome), input = { ...config(), queryExecutionProfile: "desktop" as const };
    const original = cbor.encodeSecret; let encoded!: Uint8Array;
    vi.spyOn(cbor, "encodeSecret").mockImplementation(value => (encoded = original(value)));
    try {
      if (outcome === "success") f.rt.open(input); else expect(() => f.rt.open(input)).toThrow();
      expect(encoded.length).toBeGreaterThan(64); expect(encoded.every(b => b === 0)).toBe(true);
      expect(input.signSecretKey.every(b => b === 41)).toBe(true); expect(input.kemSecretKey.every(b => b === 42)).toBe(true);
      if (outcome === "trap" || outcome === "allocation") {
        expect(() => f.rt.open(input)).toThrowError(expect.objectContaining({ code: "unavailable" }));
      }
    } finally { f.rt.dispose(); }
  });
});
