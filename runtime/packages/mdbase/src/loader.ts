/**
 * Loads `mdbase-core.wasm`. By default it is the file next to this package
 * (`wasm/mdbase-core.wasm`): read with `node:fs` on Node, fetched in browsers and
 * workers. Bundlers that understand `new URL(…, import.meta.url)` (Vite, esbuild,
 * webpack 5) copy the file as an asset. Call {@link init} to supply the module
 * yourself.
 */

import { Core } from "./abi.js";
import { MdbaseError } from "./errors.js";

/** Where the WebAssembly module comes from. */
export type WasmSource =
  | BufferSource
  | WebAssembly.Module
  | URL
  | string
  | Response
  | Promise<BufferSource | WebAssembly.Module | Response>;

let core: Core | null = null;
let pending: Promise<Core> | null = null;

function defaultUrl(): URL {
  return new URL("../wasm/mdbase-core.wasm", import.meta.url);
}

async function bytesFrom(src: WasmSource): Promise<BufferSource | WebAssembly.Module> {
  const s = await src;
  if (s instanceof WebAssembly.Module || ArrayBuffer.isView(s) || s instanceof ArrayBuffer) {
    return s;
  }
  if (typeof Response !== "undefined" && s instanceof Response) {
    return new Uint8Array(await s.arrayBuffer());
  }
  const url = typeof s === "string" ? new URL(s, import.meta.url) : (s as URL);
  if (url.protocol === "file:") {
    const nodeFs = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ nodeFs)) as typeof import("node:fs/promises");
    return new Uint8Array(await fs.readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new MdbaseError("wasm_unavailable", `fetching ${url} failed: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function instantiate(src: WasmSource): Promise<Core> {
  const bytes = await bytesFrom(src);
  const mod = bytes instanceof WebAssembly.Module ? bytes : await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(mod, {});
  return new Core(instance);
}

/**
 * Load the engine. Optional: every helper calls it on first use with the
 * default location. Pass `wasm` when the module lives elsewhere (a CDN, an
 * embedded byte array, a precompiled `WebAssembly.Module`).
 *
 * @example
 * ```ts
 * import { init } from "mdbase";
 * await init({ wasm: fetch("/assets/mdbase-core.wasm") });
 * ```
 */
export async function init(options: { wasm?: WasmSource } = {}): Promise<void> {
  if (options.wasm !== undefined) {
    core = null;
    pending = instantiate(options.wasm);
  }
  await engine();
}

/** @internal The loaded engine, loading it from the default location if needed. */
export async function engine(): Promise<Core> {
  if (core) return core;
  if (!pending) {
    pending = instantiate(defaultUrl()).catch((e: unknown) => {
      pending = null;
      if (e instanceof MdbaseError) throw e;
      throw new MdbaseError(
        "wasm_unavailable",
        `mdbase-core.wasm could not be loaded from ${defaultUrl()}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  core = await pending;
  return core;
}

/** @internal Forget the loaded engine (tests). */
export function reset(): void {
  core = null;
  pending = null;
}
