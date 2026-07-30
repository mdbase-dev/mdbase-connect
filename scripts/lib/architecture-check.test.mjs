import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateArchitecture } from "./architecture-check.mjs";

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), "mdbase-connect-architecture-"));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

const strictBudget = {
  productionFileMaxLines: 3,
  legacyFileLineBudgets: {}
};

test("accepts small acyclic feature modules", async (t) => {
  const root = await fixture({
    "packages/example/package.json": JSON.stringify({ name: "@mdbase/example" }),
    "packages/example/src/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
    "packages/example/src/b.ts": "export const b = 1;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.deepEqual(result.failures, []);
});

test("rejects production files that exceed their explicit budget", async (t) => {
  const root = await fixture({
    "packages/example/src/large.ts": "one\ntwo\nthree\nfour\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.deepEqual(result.failures, [
    "packages/example/src/large.ts has 4 lines; its budget is 3."
  ]);
});

test("rejects relative source cycles including JavaScript extension mapping", async (t) => {
  const root = await fixture({
    "services/example/src/a.ts": "export { b } from './b.js';\n",
    "services/example/src/b.ts": "import { a } from './a.js';\nexport const b = a;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^Relative import cycle:/);
});

test("rejects cycles between workspace packages", async (t) => {
  const root = await fixture({
    "packages/a/package.json": JSON.stringify({
      name: "@mdbase/a",
      dependencies: { "@mdbase/b": "workspace:*" }
    }),
    "packages/a/src/index.ts": "export const a = true;\n",
    "packages/b/package.json": JSON.stringify({
      name: "@mdbase/b",
      dependencies: { "@mdbase/a": "workspace:*" }
    }),
    "packages/b/src/index.ts": "export const b = true;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.deepEqual(result.failures, [
    "Workspace package cycle: @mdbase/a -> @mdbase/b -> @mdbase/a"
  ]);
});
