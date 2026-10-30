import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fragments, assembleChangelog } from "./changelog.mjs";
import { counters, declarations } from "./architecture-growth.mjs";
import { evaluateArchitecture } from "./architecture-check.mjs";

// This is the release cohort checked by version:check, not every workspace:
// the editor and feedback service have independent versions.
export const packagePaths = [
  "package.json",
  "apps/desktop/package.json",
  "apps/portal/package.json",
  "packages/app-ui/package.json",
  "packages/client/package.json",
  "packages/devkit/package.json",
  "packages/i18n/package.json",
  "packages/management/package.json",
  "packages/pickle/package.json",
  "packages/protocol/package.json",
  "packages/sync/package.json",
  "packages/testing/package.json",
  "packages/ui/package.json",
  "packages/webhooks/package.json",
  "runtime/packages/sdk/package.json",
  "services/mcp/package.json",
  "services/server/package.json"
];
export const lockPaths = ["Cargo.lock", "deploy/docker/Cargo.lock.hosted-provider"];
// npm lock and the local Obsidian consumer carry the same SDK version.
export const sdkVersionFields = [
  ["runtime/packages/sdk/package-lock.json", ["version"]],
  ["runtime/packages/sdk/package-lock.json", ["packages", "", "version"]],
  ["runtime/packages/obsidian-runtime/package.json", ["peerDependencies", "@mdbase-dev/sdk"]],
  ["runtime/packages/obsidian-runtime/package-lock.json", ["packages", "", "peerDependencies", "@mdbase-dev/sdk"]],
  ["runtime/packages/obsidian-runtime/package-lock.json", ["packages", "../sdk", "version"]]
];
export const betaVersion = /^0\.1\.0-beta\.[1-9][0-9]*$/;

export async function versionedCrateNames(root, cargoManifest) {
  const memberBlock = cargoManifest.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1];
  if (!memberBlock) throw new Error("Cargo.toml has no explicit workspace members.");
  const names = new Set();
  for (const [, member] of memberBlock.matchAll(/"([^"]+)"/g)) {
    const manifest = await readFile(path.join(root, member, "Cargo.toml"), "utf8");
    if (/^version\.workspace\s*=\s*true\s*$/m.test(manifest)) {
      const name = manifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      if (!name) throw new Error(`${member}/Cargo.toml has no package name.`);
      names.add(name);
    }
  }
  return names;
}

function replaceOne(text, pattern, replacement, file) {
  if ([...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length !== 1) {
    throw new Error(`${file}: expected exactly one version field.`);
  }
  return text.replace(pattern, replacement);
}

export async function prepareVersion(root, version, { dryRun = false } = {}) {
  if (!betaVersion.test(version ?? "")) throw new Error("Expected version 0.1.0-beta.N (positive integer N).");
  const read = (file) => readFile(path.join(root, file), "utf8");
  const current = JSON.parse(await read("package.json")).version;
  if (!betaVersion.test(current) || BigInt(version.split(".").at(-1)) <= BigInt(current.split(".").at(-1))) {
    throw new Error(`Version must advance beyond ${current}.`);
  }
  const updates = new Map();
  for (const file of packagePaths) {
    const source = await read(file);
    if (JSON.parse(source).version !== current) throw new Error(`${file}: version does not match ${current}.`);
    updates.set(file, replaceOne(source, /^(  "version": ")[^"]+(".*)$/m, `$1${version}$2`, file));
  }
  for (const [file, keys] of sdkVersionFields) {
    const json = JSON.parse(updates.get(file) ?? await read(file));
    const parent = keys.slice(0, -1).reduce((value, key) => value[key], json);
    if (parent[keys.at(-1)] !== current) throw new Error(`${file}: SDK version does not match ${current}.`);
    parent[keys.at(-1)] = version;
    updates.set(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  const cargo = await read("Cargo.toml");
  if (cargo.match(/\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/)?.[1] !== current) throw new Error("Cargo.toml workspace version is inconsistent.");
  updates.set("Cargo.toml", replaceOne(cargo, /(\[workspace\.package\][\s\S]*?\nversion = ")[^"]+(")/, `$1${version}$2`, "Cargo.toml"));
  const names = await versionedCrateNames(root, cargo);
  for (const file of lockPaths) {
    const source = await read(file);
    const updated = source.split("[[package]]").map((entry) => {
      const name = entry.match(/^name = "([^"]+)"/m)?.[1];
      if (!names.has(name)) return entry;
      if (entry.match(/^version = "([^"]+)"/m)?.[1] !== current) throw new Error(`${file}: ${name} version is inconsistent.`);
      if (/^source = /m.test(entry)) throw new Error(`${file}: ${name} is not a workspace lock entry.`);
      return replaceOne(entry, /^(version = ")[^"]+(".*)$/m, `$1${version}$2`, file);
    }).join("[[package]]");
    updates.set(file, updated);
  }
  const mcp = "services/mcp/src/mcp.ts";
  const mcpSource = await read(mcp);
  if (!mcpSource.includes(`version: "${current}"`)) throw new Error("MCP advertised version is inconsistent.");
  updates.set(mcp, replaceOne(mcpSource, /(new McpServer\(\{ name: "mdbase", version: ")[^"]+(")/, `$1${version}$2`, mcp));
  const entries = await fragments(root);
  updates.set("CHANGELOG.md", assembleChangelog(await read("CHANGELOG.md"), entries, version));
  const budgetFile = "config/architecture-budgets.json";
  const budgets = JSON.parse(await read(budgetFile));
  const result = await evaluateArchitecture(root, budgets, { checkCounters: false });
  if (result.failures.length) throw new Error(`Architecture hard gates failed:\n${result.failures.join("\n")}`);
  const counts = counters(result);
  budgets.reviewBudgets = Object.fromEntries(Object.keys(budgets.reviewBudgets).map((name) => [name, counts[name]]));
  budgets.productionFileBudgetsByPackage = Object.fromEntries(
    Object.keys(result.productionFilesByPackage).sort().map((name) => [name, result.productionFilesByPackage[name]])
  );
  updates.set(budgetFile, `${JSON.stringify(budgets, null, 2)}\n`);
  const growthEntries = await declarations(root);
  const removals = [...entries.map((entry) => `changelog.d/${entry.name}`), ...growthEntries.map((entry) => `architecture.d/${entry.name}`)];
  // Validate everything before writing anything. A dry run returns the exact plan.
  if (!dryRun) {
    for (const [file, content] of updates) await writeFile(path.join(root, file), content);
    for (const file of removals) await unlink(path.join(root, file));
  }
  return { updates, removals };
}
