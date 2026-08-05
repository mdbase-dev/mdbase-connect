import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const entries = {
  root: resolve(packageRoot, "src/index.ts"),
  advanced: resolve(packageRoot, "src/advanced.ts"),
  crypto: resolve(packageRoot, "src/crypto-entry.ts"),
  testing: resolve(packageRoot, "../testing/src/index.ts")
};

const report = {};
for (const [entry, path] of Object.entries(entries)) {
  const source = await readFile(path, "utf8");
  assert.doesNotMatch(source, /export\s+\*\s+from/u, `${entry} must not use wildcard exports`);
  report[entry] = exportedNames(source);
}

if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const expected = JSON.parse(await readFile(resolve(packageRoot, "public-api.json"), "utf8"));
  assert.deepEqual(report, expected, "Public API inventory changed; review and update public-api.json");
  process.stdout.write("Reviewed public API inventory matches root, /advanced, /crypto, and connect-testing.\n");
}

function exportedNames(source) {
  const names = [];
  const reexports = /export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["'];/gu;
  for (const match of source.matchAll(reexports)) {
    for (const raw of match[1].split(",")) {
      const declaration = raw.replace(/\/\*[\s\S]*?\*\//gu, "").trim().replace(/^type\s+/u, "");
      if (!declaration) continue;
      names.push(declaration.split(/\s+as\s+/u).at(-1));
    }
  }
  const declarations = /export\s+(?:async\s+)?(?:class|interface|type|function|const)\s+([A-Za-z_$][\w$]*)/gu;
  for (const match of source.matchAll(declarations)) names.push(match[1]);
  return [...new Set(names)].sort();
}
