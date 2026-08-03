import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const sourceRoots = ["apps", "crates", "packages", "services/server/src"];
const sourceExtensions = new Set([".js", ".mjs", ".rs", ".ts", ".tsx"]);
const forbidden = [
  "onFirstContact",
  "FirstContactBinding",
  "ApplicationTrustRequest",
  "trust_required",
  "/oauth/authorization_status"
];

test("keeps the retired first-contact ceremony out of runtime source", async () => {
  const violations = [];
  for (const sourceRoot of sourceRoots) {
    for (const file of await files(path.join(root, sourceRoot))) {
      if (!sourceExtensions.has(path.extname(file))) continue;
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (/(^|\/)(test|tests)\//u.test(relative) || /\.(?:spec|test)\.[^.]+$/u.test(relative)) {
        continue;
      }
      if (/(^|\/)tests\.rs$/u.test(relative)) continue;
      if (relative === "crates/connect-core/src/registry/database.rs") continue;
      const source = await readFile(file, "utf8");
      for (const identifier of forbidden) {
        if (source.includes(identifier)) violations.push(`${relative}: ${identifier}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules", "target"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}
