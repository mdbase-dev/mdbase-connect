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
  legacyFileLineBudgets: {},
  reviewBudgets: {
    productionFiles: 100,
    relativeImports: 100,
    workspacePackages: 100,
    rustPublicDeclarations: 100,
    typeScriptExportDeclarations: 100,
    mdbaseCollectionReferences: 100,
    typedCollectionReferences: 100
  }
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

test("guards typed local runtime outcomes from OperationResult and record-pointer regressions", async (t) => {
  const root = await fixture({
    "crates/connect-core/Cargo.toml": '[package]\nname = "connect-core"\nversion = "0.0.0"\n',
    "crates/connect-core/src/registry/runtime_operations.rs": [
      "fn adapter(value: &Typed) { value.to_v03(); }",
      "fn regression(value: &Value) { let _ = value.pointer(\"/result/frontmatter\"); }",
      "fn nested(value: &Execution) { let _ = value.result.result; }"
    ].join("\n"),
    "crates/connect-core/src/registry/runtime_executor.rs": "fn executor() {}\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.ok(result.failures.some((failure) => failure.includes("record JSON-pointer inspection")));
  assert.ok(result.failures.some((failure) => failure.includes("deprecated nested OperationResult access")));
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

test("does not apply hand-maintained file budgets to generated sources", async (t) => {
  const root = await fixture({
    "packages/example/src/catalog.generated.ts": "one\ntwo\nthree\nfour\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.deepEqual(result.failures, []);
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

test("makes package and public-surface growth an explicit budget change", async (t) => {
  const root = await fixture({
    "packages/example/package.json": JSON.stringify({ name: "@mdbase/example" }),
    "packages/example/src/index.ts": "export const first = 1;\nexport const second = 2;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const rejected = await evaluateArchitecture(root, {
    ...strictBudget,
    productionFileBudgetsByPackage: {},
    reviewBudgets: { ...strictBudget.reviewBudgets, typeScriptExportDeclarations: 1 }
  });
  assert.deepEqual(rejected.failures, [
    "packages/example has 1 production files but no package budget.",
    "typeScriptExportDeclarations is 2; its reviewed budget is 1."
  ]);

  const accepted = await evaluateArchitecture(root, {
    ...strictBudget,
    productionFileBudgetsByPackage: { "packages/example": 1 },
    reviewBudgets: { ...strictBudget.reviewBudgets, typeScriptExportDeclarations: 2 }
  });
  assert.deepEqual(accepted.failures, []);
});

test("treats reviewed-surface baselines as flexible upper bounds", async (t) => {
  const root = await fixture({
    "packages/example/package.json": JSON.stringify({ name: "@mdbase/example" }),
    "packages/example/src/index.ts": "export const value = 1;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, {
    ...strictBudget,
    productionFileBudgetsByPackage: { "packages/example": 2 },
    reviewBudgets: {
      productionFiles: 2,
      relativeImports: 1,
      workspacePackages: 2,
      rustPublicDeclarations: 1,
      typeScriptExportDeclarations: 2,
      mdbaseCollectionReferences: 1,
      typedCollectionReferences: 1
    }
  });

  assert.deepEqual(result.failures, []);
  assert.equal(result.productionFileCount, 1);
  assert.equal(result.typeScriptExportDeclarationCount, 1);
});

test("rejects dead-code references outside the reviewed file inventory", async (t) => {
  const root = await fixture({
    "crates/example/src/lib.rs": "#![allow(unused, dead_code)]\npub fn retained() {}\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, {
    ...strictBudget,
    deadCodeReferencesByFile: {}
  });

  assert.deepEqual(result.failures, [
    "crates/example/src/lib.rs has 1 unregistered dead-code reference(s)."
  ]);
});

test("excludes conventional Rust test modules from production budgets", async (t) => {
  const root = await fixture({
    "crates/example/src/lib.rs": "pub fn live() {}\n",
    "crates/example/src/hostile_tests.rs": "pub fn fixture_only() {}\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.equal(result.productionFileCount, 1);
  assert.equal(result.rustPublicDeclarationCount, 1);
});

test("counts same-line exports and Rust public fields conservatively", async (t) => {
  const root = await fixture({
    "packages/example/src/index.ts": "export const one = 1; export const two = 2;\n",
    "crates/example/src/lib.rs": "pub struct Item { pub first: u8, pub second: u8 } pub fn build() {}\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, strictBudget);

  assert.equal(result.typeScriptExportDeclarationCount, 2);
  assert.equal(result.rustPublicDeclarationCount, 4);
});

test("inventories unnamed workspace packages even when they have no source files", async (t) => {
  const root = await fixture({
    "packages/empty/package.json": JSON.stringify({ private: true })
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, {
    ...strictBudget,
    productionFileBudgetsByPackage: {}
  });

  assert.deepEqual(result.failures, [
    "packages/empty has 0 production files but no package budget."
  ]);
});

test("rejects malformed and unknown reviewed-surface budgets", async (t) => {
  const root = await fixture({
    "packages/example/src/index.ts": "export const value = 1;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, {
    ...strictBudget,
    reviewBudgets: {
      ...strictBudget.reviewBudgets,
      relativeImports: "bad",
      workspacePackages: -1,
      inventedSurface: 0
    }
  });

  assert.deepEqual(result.failures, [
    "reviewBudgets.relativeImports must be a non-negative integer.",
    "reviewBudgets.workspacePackages must be a non-negative integer.",
    "reviewBudgets.inventedSurface is not a supported reviewed surface."
  ]);
});

test("requires every reviewed-surface baseline", async (t) => {
  const root = await fixture({
    "packages/example/src/index.ts": "export const value = 1;\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { relativeImports: _omitted, ...incomplete } = strictBudget.reviewBudgets;

  const result = await evaluateArchitecture(root, {
    ...strictBudget,
    reviewBudgets: incomplete
  });

  assert.deepEqual(result.failures, ["reviewBudgets.relativeImports is required."]);
});

test("inventories empty Rust workspace crates", async (t) => {
  const root = await fixture({
    "crates/empty/Cargo.toml": "[package]\nname = 'empty'\nversion = '0.0.0'\n"
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await evaluateArchitecture(root, {
    ...strictBudget,
    productionFileBudgetsByPackage: {}
  });

  assert.deepEqual(result.failures, [
    "crates/empty has 0 production files but no package budget."
  ]);
});
