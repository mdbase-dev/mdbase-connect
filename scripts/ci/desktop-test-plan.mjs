import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Deliberately use narrow exclusions, not an incomplete dependency allowlist.
// Unknown/shared inputs and mixed changes retain all native checks.
export function desktopTestPlan(paths) {
  return {
    headless: paths.length === 0 || paths.some((path) => !path.startsWith("apps/editor/")),
    windows: paths.length === 0 || paths.some((path) => !/^apps\/editor\/.*\.css$/.test(path))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Expected base and head revisions");
  // --no-renames includes both sides of moves so native inputs cannot disappear.
  const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], {
    encoding: "utf8"
  }).split("\0").filter(Boolean);
  const plan = desktopTestPlan(paths);
  console.log(JSON.stringify({ paths, ...plan }, null, 2));
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan)
    .map(([key, value]) => `${key}=${value}\n`).join(""));
}
