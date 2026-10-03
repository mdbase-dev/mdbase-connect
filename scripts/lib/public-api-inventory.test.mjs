import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("API inventory regenerates deterministically, verifies source changes, and rejects wildcard exports", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "connect-api-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "packages/client/scripts/check-public-api.mjs");
  await mkdir(path.dirname(script), { recursive: true });
  await cp(new URL("../../packages/client/scripts/check-public-api.mjs", import.meta.url), script);
  const files = {
    "packages/client/src/index.ts": 'export { Original as Alias, type Item } from "./source.js";\nexport const value = 1;\n',
    "packages/client/src/advanced.ts": "export interface Advanced {}\n",
    "packages/client/src/crypto-entry.ts": "export function encrypt() {}\n",
    "packages/testing/src/index.ts": "export class Fake {}\n"
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const inventory = path.join(root, "packages/client/public-api.json");
  run("--write");
  const first = await readFile(inventory, "utf8");
  assert.deepEqual(JSON.parse(first), { root: ["Alias", "Item", "value"], advanced: ["Advanced"], crypto: ["encrypt"], testing: ["Fake"] });
  run("--write");
  assert.equal(await readFile(inventory, "utf8"), first);
  run();
  await writeFile(path.join(root, "packages/client/src/index.ts"), files["packages/client/src/index.ts"] + "export const added = 2;\n");
  assert.throws(() => run(), /generate:public-api/);
  run("--write"); run();
  const updated = await readFile(inventory, "utf8");
  await writeFile(path.join(root, "packages/client/src/index.ts"), 'export * from "./source.js";\n');
  assert.throws(() => run("--write"), /wildcard exports/);
  assert.equal(await readFile(inventory, "utf8"), updated);
});
