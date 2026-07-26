import { readFile } from "node:fs/promises";

const packagePaths = [
  "package.json",
  "apps/desktop/package.json",
  "apps/portal/package.json",
  "packages/client/package.json",
  "packages/devkit/package.json",
  "packages/pickle/package.json",
  "packages/protocol/package.json",
  "packages/sync/package.json",
  "packages/ui/package.json",
  "packages/webhooks/package.json",
  "services/mcp/package.json",
  "services/server/package.json"
];

const root = JSON.parse(await readFile("package.json", "utf8"));
const version = root.version;
if (!/^0\.1\.0-beta\.[1-9][0-9]*$/.test(version)) {
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
