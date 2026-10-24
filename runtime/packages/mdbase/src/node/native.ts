/**
 * Loads the native addon (`crates/mdbase-node`). Looks for
 * `native/mdbase.<platform>-<arch>.node` inside this package first, then for
 * the optional platform package `mdbase-<platform>-<arch>`, then
 * `$MDBASE_NATIVE` (an explicit path). Internal.
 */

import { createRequire } from "node:module";

import { MdbaseError } from "../errors.js";

const require = createRequire(import.meta.url);

/** The raw addon class. */
export interface NativeCollection {
  /** JSON text in, JSON text out. */
  call(op: string, args: string): Promise<string>;
  close(): Promise<string>;
}

export interface NativeModule {
  Collection: {
    open(root: string, options: string): Promise<string>;
    init(root: string, init: string, options: string): Promise<string>;
    attach(channel: number): NativeCollection;
  };
}

let loaded: NativeModule | null = null;

/** Platform tag, as in the file name. */
export function platformTag(): string {
  const { platform, arch } = process;
  let libc = "";
  if (platform === "linux") {
    const report = (process as { report?: { getReport?: () => unknown } }).report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    libc = report?.header?.glibcVersionRuntime ? "-gnu" : "-musl";
  }
  const msvc = platform === "win32" ? "-msvc" : "";
  return `${platform}-${arch}${libc}${msvc}`;
}

/** Load the addon once. */
export function native(): NativeModule {
  if (loaded) return loaded;
  const tag = platformTag();
  const candidates = [
    process.env["MDBASE_NATIVE"],
    `../../native/mdbase.${tag}.node`,
    `mdbase-${tag}`,
  ].filter((c): c is string => Boolean(c));
  const errors: string[] = [];
  for (const c of candidates) {
    try {
      const spec = c.startsWith("..") ? new URL(c, import.meta.url).pathname : c;
      loaded = require(spec) as NativeModule;
      return loaded;
    } catch (e) {
      errors.push(`${c}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  throw new MdbaseError(
    "native_unavailable",
    `no mdbase native addon for ${tag}`,
    `Install the platform package \`mdbase-${tag}\`, or build it with \`cargo build --release -p mdbase-node\` and point MDBASE_NATIVE at the .node file. Tried: ${errors.join("; ")}`,
  );
}
