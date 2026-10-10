import { afterEach, describe, expect, it, vi } from "vitest";
import * as cbor from "../src/cbor.js";
import { WasmRuntime, type OpenConfig } from "../src/runtime/wasm.js";

const config = (): OpenConfig => ({
  collection: "0192f3a4-6000-7abc-8def-0123456789ab",
  replicaId: "0192f3a4-6000-7abc-8def-0123456789ac",
  deviceId: "0192f3a4-6000-7abc-8def-0123456789ad",
  mode: "local_only",
  signSecretKey: new Uint8Array(32).fill(41),
  kemSecretKey: new Uint8Array(32).fill(42),
});

afterEach(() => vi.restoreAllMocks());

/** Mock only the ABI exports; these tests don't silently skip without a built WASM. */
async function runtime(outcome: "success" | "refused" | "trap" | "allocation") {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const dealloc = vi.fn();
  const exports = {
    memory,
    alloc: () => {
      if (outcome === "allocation") throw new Error("allocation failed");
      return 1024;
    },
    dealloc,
    rt_open: (ptr: number, len: number) => {
      if (outcome === "trap") throw new WebAssembly.RuntimeError("unreachable");
      // Rust rt_open consumes/wipes this input on ordinary return paths.
      new Uint8Array(memory.buffer, ptr, len).fill(0);
      if (outcome === "refused") {
        const error = new TextEncoder().encode("config refused");
        new Uint8Array(memory.buffer, 4096, error.length).set(error);
        return (4096n << 32n) | BigInt(error.length);
      }
      return 0n;
    },
  };
  vi.spyOn(WebAssembly, "instantiate").mockResolvedValue({ instance: { exports } } as unknown as WebAssembly.Instance);
  const original = cbor.encodeSecret;
  let encoded: Uint8Array | undefined;
  vi.spyOn(cbor, "encodeSecret").mockImplementation((value) => {
    encoded = original(value);
    return encoded;
  });
  return {
    rt: await WasmRuntime.instantiate(new Uint8Array()),
    encoded: () => encoded!,
    dealloc,
  };
}

describe("WASM config key-copy lifetime", () => {
  for (const outcome of ["success", "refused", "trap", "allocation"] as const) {
    it(`wipes the JS encoded config after ${outcome}`, async () => {
      const { rt, encoded, dealloc } = await runtime(outcome);
      const input = config();
      try {
        if (outcome === "success") rt.open(input);
        else expect(() => rt.open(input)).toThrow();
        expect(encoded().length).toBeGreaterThan(64);
        expect(encoded().every((b) => b === 0)).toBe(true);
        // The runtime owns its encoding, not the caller's key-storage buffers.
        expect(input.signSecretKey.every((b) => b === 41)).toBe(true);
        expect(input.kemSecretKey.every((b) => b === 42)).toBe(true);
        if (outcome === "refused") expect(dealloc).toHaveBeenCalledWith(4096, 14);
        if (outcome === "trap" || outcome === "allocation") {
          expect(() => rt.info()).toThrowError(expect.objectContaining({ code: "unavailable" }));
          expect(() => rt.open(input)).toThrowError(expect.objectContaining({ code: "unavailable" }));
          expect(encoded().every((b) => b === 0)).toBe(true);
        }
      } finally {
        rt.dispose();
      }
    });
  }
});
