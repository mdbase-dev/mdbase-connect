import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const packages = new Map();
for (const group of ["apps", "packages", "services"]) {
  for (const entry of await readdir(resolve(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `${group}/${entry.name}`;
    try {
      const manifest = JSON.parse(await readFile(resolve(root, directory, "package.json"), "utf8"));
      packages.set(manifest.name, { directory, manifest });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
const recipe = await readFile(resolve(root, "deploy/docker/Dockerfile.server"), "utf8");
function checkWorkspaceClosure(dockerfile) {
  const pending = ["@mdbase/connect-server", "@mdbase/connect-portal"], seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const { directory, manifest } = packages.get(name);
    assert.ok(dockerfile.slice(0, dockerfile.indexOf("RUN pnpm install")).includes(`COPY ${directory}/package.json ${directory}/package.json`), `${name}: manifest must exist before frozen install`);
    assert.ok(dockerfile.includes(`COPY ${directory} ${directory}`), `${name}: source must be copied for the build`);
    for (const [dependency, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (version.startsWith("workspace:")) pending.push(dependency);
    }
  }
}
test("server container includes the full runtime workspace dependency closure", () => checkWorkspaceClosure(recipe));
test("missing management manifest or source fails the container closure guard", () => {
  for (const copy of ["COPY packages/management/package.json packages/management/package.json", "COPY packages/management packages/management"]) {
    assert.throws(() => checkWorkspaceClosure(recipe.replace(copy, "")), /@mdbase\/connect-management/);
  }
});
