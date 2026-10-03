import { readFile } from "node:fs/promises";

import { packagePaths, lockPaths, betaVersion, versionedCrateNames } from "./lib/release-version.mjs";

const root = JSON.parse(await readFile("package.json", "utf8"));
const version = root.version;
if (!betaVersion.test(version)) {
  throw new Error(
    `Development releases must use 0.1.0-beta.N before 0.1.0; found ${version}.`
  );
}

for (const path of packagePaths) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`${path} has ${manifest.version}; expected ${version}.`);
  }
}

const cargoManifest = await readFile("Cargo.toml", "utf8");
const cargoVersion = cargoManifest.match(
  /\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/
)?.[1];
if (cargoVersion !== version) {
  throw new Error(`Cargo.toml has ${cargoVersion ?? "no workspace version"}; expected ${version}.`);
}

const versionedCrates = await versionedCrateNames(process.cwd(), cargoManifest);

// The release image uses its own pinned-engine lock, not the development lock.
// Both must track the workspace version before a --locked Docker build starts.
for (const lockPath of lockPaths) {
  const lock = await readFile(lockPath, "utf8");
  for (const entry of lock.split("[[package]]").slice(1)) {
    const name = entry.match(/^name = "([^"]+)"/m)?.[1];
    if (!versionedCrates.has(name)) continue;
    const lockedVersion = entry.match(/^version = "([^"]+)"/m)?.[1];
    if (lockedVersion !== version) {
      throw new Error(`${lockPath}: ${name} has ${lockedVersion}; expected ${version}.`);
    }
  }
}

const mcpSource = await readFile("services/mcp/src/mcp.ts", "utf8");
if (!mcpSource.includes(`version: "${version}"`)) {
  throw new Error("The MCP server's advertised version does not match the release version.");
}

const expectedTag = `v${version}`;
const suppliedTag = process.argv[2]
  || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "");
if (suppliedTag && suppliedTag !== expectedTag) {
  throw new Error(`Release tag ${suppliedTag} does not match ${expectedTag}.`);
}

console.log(`Release version ${version} is consistent (${expectedTag}).`);
