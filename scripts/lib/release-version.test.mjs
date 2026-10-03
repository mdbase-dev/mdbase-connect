import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareVersion, packagePaths, lockPaths } from "./release-version.mjs";

const oldVersion = "0.1.0-beta.123";
const newVersion = "0.1.0-beta.125";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "connect-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {};
  for (const file of packagePaths) files[file] = JSON.stringify({ name: file, version: oldVersion }, null, 2) + "\n";
  files["apps/editor/package.json"] = '{"version":"9.9.9"}\n';
  files["Cargo.toml"] = `[workspace]\nmembers = ["crates/example", "crates/independent"]\n[workspace.package]\nversion = "${oldVersion}"\n`;
  files["crates/example/Cargo.toml"] = '[package]\nname = "example"\nversion.workspace = true\n';
  files["crates/independent/Cargo.toml"] = '[package]\nname = "independent"\nversion = "9.9.9"\n';
  for (const lock of lockPaths) files[lock] = `# lock\nversion = 4\n\n[[package]]\nname = "example"\nversion = "${oldVersion}"\n\n[[package]]\nname = "independent"\nversion = "9.9.9"\n\n[[package]]\nname = "dependency"\nversion = "${oldVersion}"\nsource = "registry+https://example.com"\nchecksum = "unchanged"\n`;
  files["services/mcp/src/mcp.ts"] = `const server = new McpServer({ name: "mdbase", version: "${oldVersion}" });\n`;
  files["CHANGELOG.md"] = "# Changelog\n\n## Unreleased\n\n<!-- Add release notes in changelog.d; assembled by pnpm version:set. -->\n\n## 0.1.0-beta.1\n\n- Historical note.\n";
  files["changelog.d/123.md"] = "## Fixed\n\n- A release note.\n";
  files["architecture.d/123.json"] = JSON.stringify({ reason: "One MCP composition module is necessary.", growth: { productionFiles: 1 } });
  files["config/architecture-budgets.json"] = JSON.stringify({
    productionFileMaxLines: 1000,
    productionFileBudgetsByPackage: {},
    reviewBudgets: { productionFiles: 0, relativeImports: 0, workspacePackages: 0, rustPublicDeclarations: 0, typeScriptExportDeclarations: 0, mdbaseCollectionReferences: 0, typedCollectionReferences: 0 }
  });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return { root, files };
}

test("dry run plans exactly the 19 version files plus notes and ceilings, without writes", async (t) => {
  const { root, files } = await fixture(t);
  const plan = await prepareVersion(root, newVersion, { dryRun: true });
  assert.equal(plan.updates.size, 21);
  // Historical beta-prep cohort (d67c854a): do not accidentally start bumping
  // independently versioned products or omit a release input.
  assert.deepEqual([...plan.updates.keys()].filter((file) => !["CHANGELOG.md", "config/architecture-budgets.json"].includes(file)).sort(), [
    "Cargo.lock", "Cargo.toml", "apps/desktop/package.json", "apps/portal/package.json",
    "deploy/docker/Cargo.lock.hosted-provider", "package.json", "packages/app-ui/package.json",
    "packages/client/package.json", "packages/devkit/package.json", "packages/management/package.json",
    "packages/pickle/package.json", "packages/protocol/package.json", "packages/sync/package.json",
    "packages/testing/package.json", "packages/ui/package.json", "packages/webhooks/package.json",
    "services/mcp/package.json", "services/mcp/src/mcp.ts", "services/server/package.json"
  ].sort());
  for (const [file, content] of Object.entries(files)) assert.equal(await readFile(path.join(root, file), "utf8"), content);
  assert.deepEqual(plan.removals, ["changelog.d/123.md", "architecture.d/123.json"]);
});

test("updates only cohort versions, preserves lock dependencies, consumes notes and ratchets counters", async (t) => {
  const { root, files } = await fixture(t);
  const previousBudgets = JSON.parse(files["config/architecture-budgets.json"]);
  previousBudgets.reviewBudgets.productionFiles = 999;
  previousBudgets.productionFileBudgetsByPackage = { "services/mcp": 999 };
  await writeFile(path.join(root, "config/architecture-budgets.json"), JSON.stringify(previousBudgets));
  await prepareVersion(root, newVersion);
  for (const file of packagePaths) assert.equal(JSON.parse(await readFile(path.join(root, file), "utf8")).version, newVersion);
  for (const lock of lockPaths) {
    const actual = await readFile(path.join(root, lock), "utf8");
    assert.equal(actual, files[lock].replace(`name = "example"\nversion = "${oldVersion}"`, `name = "example"\nversion = "${newVersion}"`));
  }
  assert.match(await readFile(path.join(root, "Cargo.toml"), "utf8"), /version = "0.1.0-beta.125"/);
  assert.match(await readFile(path.join(root, "services/mcp/src/mcp.ts"), "utf8"), /version: "0.1.0-beta.125"/);
  assert.equal(await readFile(path.join(root, "apps/editor/package.json"), "utf8"), files["apps/editor/package.json"]);
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## 0.1.0-beta.125\n\n### Fixed\n\n- A release note./);
  assert.ok(changelog.endsWith("## 0.1.0-beta.1\n\n- Historical note.\n"));
  for (const file of ["changelog.d/123.md", "architecture.d/123.json"]) await assert.rejects(readFile(path.join(root, file)), { code: "ENOENT" });
  const budgets = JSON.parse(await readFile(path.join(root, "config/architecture-budgets.json"), "utf8"));
  assert.equal(budgets.reviewBudgets.productionFiles, 1);
  assert.equal(budgets.productionFileBudgetsByPackage["services/mcp"], 1);
  await assert.rejects(prepareVersion(root, newVersion), /advance/);
});

test("invalid versions and inconsistent inputs fail before any writes", async (t) => {
  const { root, files } = await fixture(t);
  for (const version of [undefined, "1.0.0", "0.1.0-beta.0", "0.1.0-beta.0125", oldVersion, "0.1.0-beta.122"]) await assert.rejects(prepareVersion(root, version));
  await writeFile(path.join(root, "services/mcp/src/mcp.ts"), 'const broken = "no version";\n');
  await assert.rejects(prepareVersion(root, newVersion), /MCP advertised/);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), files["package.json"]);
  assert.equal(await readFile(path.join(root, "Cargo.lock"), "utf8"), files["Cargo.lock"]);
});

test("late fragment and hard-gate failures leave prepared versions untouched", async (t) => {
  const { root, files } = await fixture(t);
  await writeFile(path.join(root, "changelog.d/123.md"), "## Invalid\n\n- Invalid note.\n");
  await assert.rejects(prepareVersion(root, newVersion), /supported section/);
  await writeFile(path.join(root, "changelog.d/123.md"), files["changelog.d/123.md"]);
  await writeFile(path.join(root, "services/mcp/src/mcp.ts"), files["services/mcp/src/mcp.ts"] + "// oversized\n".repeat(1000));
  await assert.rejects(prepareVersion(root, newVersion), /Architecture hard gates failed/);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), files["package.json"]);
  assert.equal(await readFile(path.join(root, "Cargo.toml"), "utf8"), files["Cargo.toml"]);
  assert.equal(await readFile(path.join(root, "CHANGELOG.md"), "utf8"), files["CHANGELOG.md"]);
});
