import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateArchitecture } from "./architecture-check.mjs";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "mdbase-connect-architecture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return root;
}

test("accepts acyclic feature modules", async (t) => {
  const root = await fixture(t, {
    "packages/example/package.json": JSON.stringify({ name: "@mdbase/example" }),
    "packages/example/src/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
    "packages/example/src/b.ts": "export const b = 1;\n"
  });

  assert.deepEqual(await evaluateArchitecture(root), []);
});

test("rejects relative source cycles including JavaScript extension mapping", async (t) => {
  const root = await fixture(t, {
    "services/example/src/a.ts": "export { b } from './b.js';\n",
    "services/example/src/b.ts": "import { a } from './a.js';\nexport const b = a;\n"
  });

  assert.deepEqual(await evaluateArchitecture(root), [
    "Relative import cycle: services/example/src/a.ts -> services/example/src/b.ts -> services/example/src/a.ts"
  ]);
});

test("ignores relative cycles that only test files close", async (t) => {
  const root = await fixture(t, {
    "services/example/src/a.ts": "export const a = 1;\n",
    "services/example/src/a.test.ts": "import { a } from './a.js';\n"
  });

  assert.deepEqual(await evaluateArchitecture(root), []);
});

test("rejects cycles between workspace packages", async (t) => {
  const root = await fixture(t, {
    "packages/a/package.json": JSON.stringify({ name: "@mdbase/a", dependencies: { "@mdbase/b": "workspace:*" } }),
    "packages/b/package.json": JSON.stringify({ name: "@mdbase/b", dependencies: { "@mdbase/a": "workspace:*" } })
  });

  assert.deepEqual(await evaluateArchitecture(root), [
    "Workspace package cycle: @mdbase/a -> @mdbase/b -> @mdbase/a"
  ]);
});
