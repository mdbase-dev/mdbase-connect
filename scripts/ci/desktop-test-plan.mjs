import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// These workspaces feed the JS bundles, not the native CLI or platform makers.
// Unknown inputs still run both packaging lanes.
const bundleWorkspaces = ["apps/editor", "packages/protocol", "packages/ui", "packages/connect-ui"];
const bundleInput = (path) => bundleWorkspaces.some((workspace) => path.startsWith(`${workspace}/`));
const documentation = (path) => path.startsWith("docs/") || path.startsWith("changelog.d/");

function packagingLockInputs(lock) {
  // Compare the generated pnpm v9 lock exactly outside bundled importers.
  // Changed shared resolutions, settings, root/desktop importers, unknown lock
  // formats or YAML aliases retain full packaging, without a dependency parser.
  if (typeof lock !== "string" || !lock.startsWith("lockfileVersion: '9.0'\n")
    || /(?:^|[\s:[{,])[&*][\w-]+/m.test(lock)) return null;
  const start = lock.indexOf("\nimporters:\n");
  const end = lock.indexOf("\npackages:\n", start + 1);
  if (start < 0 || end < 0) return null;
  const blocks = lock.slice(start + "\nimporters:\n".length, end)
    .split(/(?=^  \S[^\n]*:\n)/m);
  if (blocks[0].trim() === "") blocks.shift();
  if (!blocks.length) return null;
  const retained = [];
  for (const block of blocks) {
    const match = /^  ([\w./-]+):\n/.exec(block);
    if (!match || block.slice(match[0].length).split("\n")
      .some((line) => line.trim() !== "" && !line.startsWith("    "))) return null;
    if (!bundleWorkspaces.includes(match[1])) retained.push(block);
  }
  return lock.slice(0, start) + "\nimporters:\n" + retained.join("") + lock.slice(end);
}

export function bundledImporterOnlyChange(before, after) {
  const baseline = packagingLockInputs(before);
  return baseline !== null && before !== after && baseline === packagingLockInputs(after);
}

export function desktopTestPlan(paths, { bundledLockChange = false } = {}) {
  const packagingInputs = paths.filter((path) => !bundleInput(path) && !documentation(path)
    && !(path === "pnpm-lock.yaml" && bundledLockChange));
  const headless = paths.length === 0 || packagingInputs.some((path) => !path.startsWith("apps/desktop/"));
  const windows = paths.length === 0 || packagingInputs.length > 0;
  return {
    headless,
    windows,
    bundle: !headless && !windows && paths.some((path) => bundleInput(path)
      || (path === "pnpm-lock.yaml" && bundledLockChange))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Expected base and head revisions");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  // --no-renames includes both sides of moves so packaging inputs cannot disappear.
  const paths = git("diff", "--no-renames", "--name-only", "-z", `${base}...${head}`)
    .split("\0").filter(Boolean);
  let bundledLockChange = false;
  if (paths.includes("pnpm-lock.yaml")) {
    try {
      const mergeBase = git("merge-base", base, head).trim();
      bundledLockChange = bundledImporterOnlyChange(git("show", `${mergeBase}:pnpm-lock.yaml`),
        git("show", `${head}:pnpm-lock.yaml`));
    } catch {
      // Missing/deleted lock or unavailable history selects full packaging.
    }
  }
  const plan = desktopTestPlan(paths, { bundledLockChange });
  console.log(JSON.stringify({ paths, bundledLockChange, ...plan }, null, 2));
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan)
    .map(([key, value]) => `${key}=${value}\n`).join(""));
}
