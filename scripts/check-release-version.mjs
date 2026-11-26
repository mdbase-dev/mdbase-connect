import { readFile } from "node:fs/promises";

import { packagePaths, sdkVersionFields } from "./lib/release-version.mjs";

const root = JSON.parse(await readFile("package.json", "utf8"));
const version = root.version;

for (const path of packagePaths) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`${path} has ${manifest.version}; expected ${version}.`);
  }
}
for (const [path, keys] of sdkVersionFields) {
  const json = JSON.parse(await readFile(path, "utf8"));
  const actual = keys.reduce((value, key) => value[key], json);
  if (actual !== version) throw new Error(`${path}: SDK version has ${actual}; expected ${version}.`);
}

const mcpSource = await readFile("services/mcp/src/mcp.ts", "utf8");
if (!mcpSource.includes(`version: "${version}"`)) {
  throw new Error("The MCP server's advertised version does not match the release version.");
}

console.log(`Workspace version ${version} is consistent.`);
