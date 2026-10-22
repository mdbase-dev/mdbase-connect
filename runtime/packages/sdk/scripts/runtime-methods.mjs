// Request methods the pinned native runtime serves, read from its replica frame
// dispatch (crates/replica/src/frames.rs) at the commit in asset-pins.json.
// `node scripts/runtime-methods.mjs --write` regenerates runtime-methods.json
// after a native refresh; the contract test fails until it is regenerated.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const FRAMES = "crates/replica/src/frames.rs";

export function servedMethods(source) {
  const arms = source.match(/^\s+"[a-z][a-z0-9_]*"(\s*\|\s*"[a-z][a-z0-9_]*")*\s*=>/gm) ?? [];
  const names = new Set(arms.flatMap(arm => arm.match(/"[a-z0-9_]+"/g).map(name => name.slice(1, -1))));
  if (/r\.method == "hello"/.test(source)) names.add("hello");
  return [...names].sort();
}

export function pinnedCommit() {
  return JSON.parse(readFileSync(new URL("../src/application/asset-pins.json", here), "utf8")).runtime.source.commit;
}

/** Frames source at `commit`, or null when this checkout lacks that commit. */
export function framesAt(commit) {
  try {
    return execFileSync("git", ["show", `${commit}:${FRAMES}`], { cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

if (process.argv.includes("--write")) {
  const commit = pinnedCommit(), source = framesAt(commit);
  if (source === null) throw new Error(`commit ${commit} is not in this checkout`);
  writeFileSync(new URL("runtime-methods.json", here), JSON.stringify({ source: { commit, path: FRAMES }, methods: servedMethods(source) }, null, 2) + "\n");
}
