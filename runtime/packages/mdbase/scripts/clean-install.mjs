import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(pkg, ".consumer-"));
const supplied = process.argv[2];
let archive;
try {
  archive = supplied ? resolve(supplied) : join(pkg, execFileSync("npm", ["pack", "--silent"], { cwd: pkg, encoding: "utf8" }).trim());
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }));
  assert.equal(manifest.name, "@mdbase-dev/mdbase");
  assert(files.includes("package/wasm/mdbase-core.wasm"));
  assert(files.includes("package/dist/index.js"));
  assert(files.includes("package/dist/index.d.ts"));
  assert(files.every((file) => /^package\/(dist\/[^/]+\.(js|js\.map|d\.ts)|wasm\/mdbase-core\.wasm|package\.json|README\.md|LICENSE)$/.test(file)));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", archive], { cwd: dir, stdio: "inherit" });
  writeFileSync(join(dir, "smoke.mjs"), `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { VERSION, contractDigest, loadCatalog, validateRecord } from "@mdbase-dev/mdbase";

assert.equal(VERSION, "0.5.0");
const wasm = await readFile(new URL(import.meta.resolve("@mdbase-dev/mdbase/wasm/mdbase-core.wasm")));
assert(WebAssembly.validate(wasm));
const contract = await contractDigest("---\\nkind: mdbase.contract\\ncontract_type: record\\nid: example.note\\nversion: 1.0.0\\nrecord_schema:\\n  dialect: json-schema-2020-12\\n  value:\\n    type: object\\n---\\n");
assert.match(contract.digest, /^sha256:[0-9a-f]{64}$/);
const resources = { "mdbase.yaml": 'spec_version: "0.3.0"\\n' };
assert.equal((await loadCatalog(resources)).valid, true);
const record = await validateRecord({ resources, path: "note.md", source: "---\\ntitle: Hello\\n---\\n" });
assert.deepEqual(record.issues, []);
await assert.rejects(import("@mdbase-dev/mdbase/node"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("@mdbase-dev/mdbase clean install (npm): ok");
`);
  execFileSync("node", ["smoke.mjs"], { cwd: dir, stdio: "inherit" });
} finally {
  rmSync(dir, { recursive: true, force: true });
  if (!supplied && archive) rmSync(archive, { force: true });
}
