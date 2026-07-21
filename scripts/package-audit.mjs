import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packages = ["protocol", "client", "devkit", "sync", "tasknotes"];
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-packages-"));

try {
  for (const packageName of packages) {
    const packageRoot = join(root, "packages", packageName);
    const archive = join(scratch, `${packageName}.tgz`);
    await run("pnpm", ["pack", "--out", archive], { cwd: packageRoot });
    const entries = (await run("tar", ["-tzf", archive])).stdout.trim().split("\n");
    const manifest = JSON.parse((await run("tar", ["-xOf", archive, "package/package.json"])).stdout);
    assert(manifest.license === "MIT", `${manifest.name} is missing its MIT license metadata`);
    assert(manifest.repository?.url, `${manifest.name} is missing repository metadata`);
    assert(!entries.some((entry) => /(?:^|\/)src\//.test(entry)), `${manifest.name} publishes source files`);
    assert(!entries.some((entry) => /(?:^|\/)(?:test|tests)\//.test(entry) || /\.test\.[^.]+$/.test(entry)), `${manifest.name} publishes test files`);
    for (const target of exportTargets(manifest.exports)) {
      if (target.includes("*")) continue;
      const entry = `package/${target.replace(/^\.\//, "")}`;
      assert(entries.includes(entry), `${manifest.name} exports missing file ${target}`);
    }
    process.stdout.write(`${manifest.name} package is consumable (${entries.length} files)\n`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
