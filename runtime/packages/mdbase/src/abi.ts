/**
 * The raw ABI of `mdbase-core.wasm` (`crates/mdbase-wasm`): `alloc`, `dealloc`,
 * `mdbase_abi` and `mdbase_call(op, json) -> json`. Internal; use the functions
 * in `index.ts`.
 */

import { MdbaseError, type ErrorCode } from "./errors.js";

/** The ABI major this package speaks. A module with another major is refused. */
export const ABI_MAJOR = 1;

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  mdbase_abi(): number;
  mdbase_call(opPtr: number, opLen: number, inPtr: number, inLen: number): bigint;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** One instantiated module. */
export class Core {
  readonly #x: Exports;

  constructor(instance: WebAssembly.Instance) {
    const x = instance.exports as unknown as Partial<Exports>;
    for (const name of ["memory", "alloc", "dealloc", "mdbase_abi", "mdbase_call"] as const) {
      if (!(name in x)) {
        throw new MdbaseError(
          "wasm_incompatible",
          `the WebAssembly module is not mdbase-core.wasm: export \`${name}\` is missing`,
          "Pass the mdbase-core.wasm that ships with this version of the mdbase package.",
        );
      }
    }
    this.#x = x as Exports;
    const abi = this.#x.mdbase_abi();
    if (abi !== ABI_MAJOR) {
      throw new MdbaseError(
        "wasm_incompatible",
        `mdbase-core.wasm speaks ABI ${abi}; this package needs ABI ${ABI_MAJOR}`,
        "Use the mdbase-core.wasm that ships with this version of the mdbase package.",
      );
    }
  }

  #write(text: string): [number, number] {
    const bytes = enc.encode(text);
    const ptr = this.#x.alloc(bytes.length);
    new Uint8Array(this.#x.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
  }

  /** Run `op` with `input` (JSON-serialisable) and return the parsed `ok` value. */
  call(op: string, input: unknown): unknown {
    const [opPtr, opLen] = this.#write(op);
    const [inPtr, inLen] = this.#write(JSON.stringify(input ?? {}));
    const packed = this.#x.mdbase_call(opPtr, opLen, inPtr, inLen);
    const ptr = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    let text: string;
    try {
      text = dec.decode(new Uint8Array(this.#x.memory.buffer, ptr, len));
    } finally {
      if (len > 0) this.#x.dealloc(ptr, len);
    }
    const out = JSON.parse(text) as { ok?: unknown; error?: WireError };
    if (out.error) {
      throw MdbaseError.fromWire(out.error);
    }
    return out.ok;
  }
}

/** The error shape `mdbase_call` returns. */
export interface WireError {
  code: ErrorCode | string;
  message: string;
  location?: string;
  details?: unknown;
}
