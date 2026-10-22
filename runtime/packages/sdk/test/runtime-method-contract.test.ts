import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
// @ts-expect-error untyped build script
import {framesAt, pinnedCommit, servedMethods} from "../scripts/runtime-methods.mjs";

const manifest = JSON.parse(readFileSync(new URL("../scripts/runtime-methods.json", import.meta.url), "utf8")) as {source: {commit: string}; methods: string[]};
const SRC = new URL("../src/", import.meta.url).pathname;

/** Replica methods the SDK requests that the pinned runtime does not serve.
 * Each entry is a known gap, not a silent fallback; fix it (or its caller) and
 * remove it here. Adding a new unserved request fails this test. */
const UNSERVED: Record<string, string> = {
  report_witnesses: "proposed; best effort, an unknown_method answer is ignored",
  describe_typing: "not in the native frame dispatch",
  backlinks: "not in the native frame dispatch",
  account_key_setup: "not in the native frame dispatch",
  account_key_status: "not in the native frame dispatch",
  account_key_unlock: "not in the native frame dispatch",
  recovery_key_create: "not in the native frame dispatch",
  recovery_key_import: "not in the native frame dispatch",
  recovery_key_status: "not in the native frame dispatch",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "testing" ? [] : sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/** Literal method names sent to the replica through a client call or session
 * request; the CP authority and application worker are other servers. */
function requested(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/([\w.]+)\.(?:call|request)(?:<[^>]*>)?\(\s*"([a-z][a-z0-9_]*)"/g)) {
      if (/(authority|worker)$/.test(m[1]!)) continue;
      out.set(m[2]!, file.slice(SRC.length));
    }
  }
  return out;
}

describe("SDK ↔ pinned native runtime methods", () => {
  it("the method manifest belongs to the pinned native runtime", () => {
    expect(manifest.source.commit).toBe(pinnedCommit());
  });

  const frames = framesAt(manifest.source.commit) as string | null;
  it.skipIf(frames === null)("the manifest matches the pinned commit's frame dispatch", () => {
    expect(servedMethods(frames)).toEqual(manifest.methods);
  });

  it("every replica request the SDK makes is served by the pinned runtime", () => {
    const served = new Set(manifest.methods);
    const missing = [...requested()].filter(([method]) => !served.has(method) && !(method in UNSERVED));
    expect(missing.map(([method, file]) => `${method} (${file})`)).toEqual([]);
    // A gap that was fixed, or is no longer requested, leaves the allowlist too.
    const stale = Object.keys(UNSERVED).filter(method => served.has(method) || !requested().has(method));
    expect(stale).toEqual([]);
  });
});
